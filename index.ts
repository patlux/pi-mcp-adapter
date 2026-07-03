import type { ExtensionAPI, ToolInfo } from "@earendil-works/pi-coding-agent";
import type { McpExtensionState } from "./state.ts";
import { Type } from "typebox";
import { loadMcpConfig } from "./config.ts";
import { buildProxyDescription, getMissingConfiguredDirectToolServers, resolveDirectTools } from "./direct-tool-specs.ts";
import { loadMetadataCache } from "./metadata-cache.ts";
import { getConfigPathFromArgv, normalizeDirectToolInputSchema, truncateAtWord } from "./utils.ts";
import { createMcpDirectToolCallRenderer, renderMcpProxyToolCall, renderMcpToolResult } from "./tool-result-renderer.ts";
import { toolErrorOverride } from "./error-signal.ts";

// The MCP runtime graph (SDK, server manager, panels, OAuth, recheck) is
// expensive to import (~50-80ms). Keep it out of the extension factory so pi
// startup stays fast; session_start kicks the import off in the background
// and every handler awaits the cached promise (a no-op once loaded).
type HeavyModules = {
  commands: typeof import("./commands.ts");
  init: typeof import("./init.ts");
  proxy: typeof import("./proxy-modes.ts");
  auth: typeof import("./mcp-auth-flow.ts");
  direct: typeof import("./direct-tools.ts");
};
let heavyModules: Promise<HeavyModules> | null = null;
function heavy(): Promise<HeavyModules> {
  heavyModules ??= (async () => {
    const [commands, init, proxy, auth, direct] = await Promise.all([
      import("./commands.ts"),
      import("./init.ts"),
      import("./proxy-modes.ts"),
      import("./mcp-auth-flow.ts"),
      import("./direct-tools.ts"),
    ]);
    return { commands, init, proxy, auth, direct };
  })();
  return heavyModules;
}

export default function mcpAdapter(pi: ExtensionAPI) {
  let state: McpExtensionState | null = null;
  let initPromise: Promise<McpExtensionState | null> | null = null;
  let lifecycleGeneration = 0;

  async function shutdownState(currentState: McpExtensionState | null, reason: string): Promise<void> {
    if (!currentState) return;
    const { init } = await heavy();

    if (currentState.uiServer) {
      currentState.uiServer.close(reason);
      currentState.uiServer = null;
    }

    let flushError: unknown;
    try {
      init.flushMetadataCache(currentState);
    } catch (error) {
      flushError = error;
    }

    try {
      await currentState.lifecycle.gracefulShutdown();
    } catch (error) {
      if (flushError) {
        console.error("MCP: graceful shutdown failed after metadata flush error", error);
      } else {
        throw error;
      }
    }

    if (flushError) {
      throw flushError;
    }
  }

  const earlyConfigPath = getConfigPathFromArgv();
  const earlyConfig = loadMcpConfig(earlyConfigPath);
  const earlyCache = loadMetadataCache();
  const prefix = earlyConfig.settings?.toolPrefix ?? "server";

  const envRaw = process.env.MCP_DIRECT_TOOLS;
  const directSpecs = envRaw === "__none__"
    ? []
    : resolveDirectTools(
        earlyConfig,
        earlyCache,
        prefix,
        envRaw?.split(",").map(s => s.trim()).filter(Boolean),
      );
  const missingConfiguredDirectToolServers = getMissingConfiguredDirectToolServers(earlyConfig, earlyCache);
  const shouldRegisterProxyTool =
    earlyConfig.settings?.disableProxyTool !== true
    || directSpecs.length === 0
    || missingConfiguredDirectToolServers.length > 0;

  for (const spec of directSpecs) {
    (pi.registerTool as (tool: unknown) => unknown)({
      name: spec.prefixedName,
      label: `MCP: ${spec.originalName}`,
      description: spec.description || "(no description)",
      promptSnippet: truncateAtWord(spec.description, 100) || `MCP tool from ${spec.serverName}`,
      parameters: Type.Unsafe(normalizeDirectToolInputSchema(spec.inputSchema) as never),
      execute: async (toolCallId: string, params: Record<string, unknown>, signal: AbortSignal | undefined, onUpdate: unknown, ctx: unknown) => {
        const { direct } = await heavy();
        return direct.createDirectToolExecutor(() => state, () => initPromise, spec)(
          toolCallId,
          params,
          signal,
          onUpdate as never,
          ctx as never,
        );
      },
      renderCall: createMcpDirectToolCallRenderer(spec.prefixedName),
      renderResult: renderMcpToolResult,
    });
  }

  const getPiTools = (): ToolInfo[] => pi.getAllTools();

  pi.registerFlag("mcp-config", {
    description: "Path to MCP config file",
    type: "string",
  });

  // Intentionally not awaiting the heavy import here: the handler returns
  // immediately so pi startup is not blocked; MCP init continues in the
  // background exactly like the previous initializeMcp().then() flow.
  pi.on("session_start", (_event, ctx) => {
    const generation = ++lifecycleGeneration;
    const previousState = state;
    state = null;
    initPromise = null;

    const promise = (async (): Promise<McpExtensionState | null> => {
      const { init, auth } = await heavy();

      try {
        await Promise.all([
          shutdownState(previousState, "session_restart"),
          auth.shutdownOAuth(),
        ]);
      } catch (error) {
        console.error("MCP: failed to shut down previous session state", error);
      }

      if (generation !== lifecycleGeneration) {
        return null;
      }

      await auth.initializeOAuth().catch(err => {
        console.error("MCP OAuth initialization failed:", err);
      });

      return init.initializeMcp(pi, ctx);
    })();
    initPromise = promise;

    promise.then(async (nextState) => {
      if (generation !== lifecycleGeneration || initPromise !== promise) {
        try {
          await shutdownState(nextState, "stale_session_start");
        } catch (error) {
          console.error("MCP: failed to clean stale session state", error);
        }
        return;
      }
      if (!nextState) {
        initPromise = null;
        return;
      }

      state = nextState;
      const { init } = await heavy();
      init.updateStatusBar(nextState);
      initPromise = null;
    }).catch(err => {
      if (generation !== lifecycleGeneration) {
        return;
      }
      if (initPromise !== promise && initPromise !== null) {
        return;
      }
      console.error("MCP initialization failed:", err);
      initPromise = null;
    });
  });

  pi.on("session_shutdown", async () => {
    ++lifecycleGeneration;
    const currentState = state;
    state = null;
    initPromise = null;

    try {
      const cleanups: Promise<void>[] = [shutdownState(currentState, "session_shutdown")];
      // Only touch OAuth if the heavy graph was ever loaded; otherwise there
      // is nothing to shut down and importing it now would be wasted work.
      if (heavyModules) {
        cleanups.push(heavy().then(({ auth }) => auth.shutdownOAuth()));
      }
      await Promise.all(cleanups);
    } catch (error) {
      console.error("MCP: session shutdown cleanup failed", error);
    }
  });

  // Re-flag returned MCP tool failures so pi registers them as errors (see toolErrorOverride).
  pi.on("tool_result", (event) => toolErrorOverride(event.details));

  pi.registerCommand("mcp", {
    description: "Show MCP server status",
    handler: async (args, ctx) => {
      const { commands } = await heavy();
      if (!state && initPromise) {
        try {
          state = await initPromise;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (ctx.hasUI) ctx.ui.notify(`MCP initialization failed: ${message}`, "error");
          return;
        }
      }
      if (!state) {
        if (ctx.hasUI) ctx.ui.notify("MCP not initialized", "error");
        return;
      }

      const parts = args?.trim()?.split(/\s+/) ?? [];
      const subcommand = parts[0] ?? "";
      const targetServer = parts[1];
      const rest = parts.slice(1).join(" ");

      switch (subcommand) {
        case "reconnect":
          await commands.reconnectServers(state, ctx, targetServer);
          break;
        case "tools":
          await commands.showTools(state, ctx);
          break;
        case "setup": {
          const result = await commands.openMcpSetup(state, pi, ctx, earlyConfigPath, "setup");
          if (result?.configChanged) {
            await ctx.reload();
            return;
          }
          break;
        }
        case "logout": {
          const serverName = rest;
          if (!serverName) {
            if (ctx.hasUI) ctx.ui.notify("Usage: /mcp logout <server>", "error");
            return;
          }
          await commands.logoutServer(serverName, state, ctx);
          break;
        }
        case "status":
        case "":
        default:
          if (ctx.hasUI) {
            const result = await commands.openMcpPanel(state, pi, ctx, earlyConfigPath);
            if (result?.configChanged) {
              await ctx.reload();
              return;
            }
          } else {
            await commands.showStatus(state, ctx);
          }
          break;
      }
    },
  });

  pi.registerCommand("mcp-auth", {
    description: "Authenticate with an MCP server (OAuth)",
    handler: async (args, ctx) => {
      const serverName = args?.trim();
      if (!serverName && !ctx.hasUI) {
        return;
      }
      const { commands } = await heavy();

      if (!state && initPromise) {
        try {
          state = await initPromise;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (ctx.hasUI) ctx.ui.notify(`MCP initialization failed: ${message}`, "error");
          return;
        }
      }
      if (!state) {
        if (ctx.hasUI) ctx.ui.notify("MCP not initialized", "error");
        return;
      }

      if (!serverName) {
        await commands.openMcpAuthPanel(state, pi, ctx, earlyConfigPath);
        return;
      }

      await commands.authenticateServer(serverName, state.config, ctx);
    },
  });

  if (shouldRegisterProxyTool) {
    (pi.registerTool as (tool: unknown) => unknown)({
      name: "mcp",
      label: "MCP",
      description: buildProxyDescription(earlyConfig, earlyCache, directSpecs),
      promptSnippet: "MCP gateway - connect to MCP servers and call their tools",
      renderCall: renderMcpProxyToolCall,
      parameters: Type.Object({
        tool: Type.Optional(Type.String({ description: "Tool name to call (e.g., 'xcodebuild_list_sims')" })),
        args: Type.Optional(Type.String({ description: "Arguments as JSON string (e.g., '{\"key\": \"value\"}')" })),
        connect: Type.Optional(Type.String({ description: "Server name to connect (lazy connect + metadata refresh)" })),
        describe: Type.Optional(Type.String({ description: "Tool name to describe (shows parameters)" })),
        search: Type.Optional(Type.String({ description: "Search tools by name/description" })),
        regex: Type.Optional(Type.Boolean({ description: "Treat search as regex (default: substring match)" })),
        includeSchemas: Type.Optional(Type.Boolean({ description: "Include parameter schemas in search results (default: true)" })),
        server: Type.Optional(Type.String({ description: "Filter to specific server (also disambiguates tool calls)" })),
        action: Type.Optional(Type.String({ description: "Action: 'ui-messages', 'auth-start', or 'auth-complete'" })),
      }),
      renderResult: renderMcpToolResult,
      async execute(_toolCallId, params: {
        tool?: string;
        args?: string;
        connect?: string;
        describe?: string;
        search?: string;
        regex?: boolean;
        includeSchemas?: boolean;
        server?: string;
        action?: string;
      }, signal, _onUpdate, _ctx) {
        let parsedArgs: Record<string, unknown> | undefined;
        if (params.args) {
          try {
            parsedArgs = JSON.parse(params.args);
            if (typeof parsedArgs !== "object" || parsedArgs === null || Array.isArray(parsedArgs)) {
              const gotType = Array.isArray(parsedArgs) ? "array" : parsedArgs === null ? "null" : typeof parsedArgs;
              throw new Error(`Invalid args: expected a JSON object, got ${gotType}`);
            }
          } catch (error) {
            if (error instanceof SyntaxError) {
              throw new Error(`Invalid args JSON: ${error.message}`, { cause: error });
            }
            throw error;
          }
        }

        const { proxy } = await heavy();
        if (!state && initPromise) {
          try {
            state = await initPromise;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return {
              content: [{ type: "text" as const, text: `MCP initialization failed: ${message}` }],
              details: { error: "init_failed", message },
            };
          }
        }
        if (!state) {
          return {
            content: [{ type: "text" as const, text: "MCP not initialized" }],
            details: { error: "not_initialized" },
          };
        }

        if (params.action === "ui-messages") {
          return proxy.executeUiMessages(state);
        }
        if (params.action === "auth-start") {
          if (!params.server) {
            return {
              content: [{ type: "text" as const, text: "auth-start requires `server`. Example: mcp({ action: \"auth-start\", server: \"linear-server\" })" }],
              details: { mode: "auth-start", error: "missing_server" },
            };
          }
          return proxy.executeAuthStart(state, params.server);
        }
        if (params.action === "auth-complete") {
          if (!params.server) {
            return {
              content: [{ type: "text" as const, text: "auth-complete requires `server`." }],
              details: { mode: "auth-complete", error: "missing_server" },
            };
          }
          const input = parsedArgs?.redirectUrl ?? parsedArgs?.code ?? parsedArgs?.input;
          if (typeof input !== "string" || input.trim().length === 0) {
            return {
              content: [{ type: "text" as const, text: "auth-complete requires args with `redirectUrl`, `code`, or `input`." }],
              details: { mode: "auth-complete", error: "missing_input" },
            };
          }
          return proxy.executeAuthComplete(state, params.server, input);
        }
        if (params.tool) {
          return proxy.executeCall(state, params.tool, parsedArgs, params.server, getPiTools, signal);
        }
        if (params.connect) {
          return proxy.executeConnect(state, params.connect, signal);
        }
        if (params.describe) {
          return proxy.executeDescribe(state, params.describe);
        }
        if (params.search) {
          return proxy.executeSearch(state, params.search, params.regex, params.server, params.includeSchemas);
        }
        if (params.server) {
          return proxy.executeList(state, params.server);
        }
        return proxy.executeStatus(state);
      },
    });
  }
}
