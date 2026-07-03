import type { AgentToolResult, AgentToolUpdateCallback, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { UrlElicitationRequiredError } from "@modelcontextprotocol/sdk/types.js";
import type { McpExtensionState } from "./state.ts";
import type { DirectToolSpec, McpContent } from "./types.ts";
import { lazyConnect, getFailureAgeSeconds } from "./init.ts";
import { abortable, throwIfAborted } from "./abort.ts";
import { formatSchema } from "./tool-metadata.ts";
import { resolveMcpResultContent, transformMcpContent } from "./tool-registrar.ts";
import { guardMcpOutput, guardedMcpDetails, resolveMcpOutputGuardOptions } from "./mcp-output-guard.ts";
import { maybeStartUiSession, type UiSessionRuntime } from "./ui-session.ts";
import { authenticate, supportsOAuth } from "./mcp-auth-flow.ts";
import { formatAuthRequiredMessage } from "./utils.ts";

// Startup-light spec helpers moved to ./direct-tool-specs.ts (no heavy MCP
// graph imports there); re-exported here for backward compatibility.
export { resolveDirectTools, getMissingConfiguredDirectToolServers, buildProxyDescription } from "./direct-tool-specs.ts";

type DirectAutoAuthResult =
  | { status: "skipped" }
  | { status: "success" }
  | { status: "failed"; message: string };

function getDirectAuthRequiredMessage(
  state: McpExtensionState,
  serverName: string,
  defaultMessage = `MCP server "${serverName}" requires OAuth authentication. Run mcp({ action: "auth-start", server: "${serverName}" }) to get a browser URL, or /mcp-auth ${serverName} in an interactive local session.`,
): string {
  return formatAuthRequiredMessage(state.config, serverName, defaultMessage);
}

function getDirectAuthFailedMessage(state: McpExtensionState, serverName: string, message: string): string {
  const customGuidance = state.config.settings?.authRequiredMessage;
  if (customGuidance) {
    return `OAuth authentication failed for "${serverName}": ${message}. ${getDirectAuthRequiredMessage(state, serverName)}`;
  }
  return `OAuth authentication failed for "${serverName}": ${message}. Run mcp({ action: "auth-start", server: "${serverName}" }) to get a browser URL, or /mcp-auth ${serverName} in an interactive local session.`;
}

async function attemptDirectAutoAuth(
  state: McpExtensionState,
  serverName: string,
): Promise<DirectAutoAuthResult> {
  if (state.config.settings?.autoAuth !== true) {
    return { status: "skipped" };
  }

  const definition = state.config.mcpServers[serverName];
  if (!definition || !supportsOAuth(definition) || !definition.url) {
    return { status: "skipped" };
  }

  const grantType = definition.oauth ? definition.oauth.grantType ?? "authorization_code" : "authorization_code";
  if (!state.ui && grantType !== "client_credentials") {
    return {
      status: "failed",
      message: getDirectAuthRequiredMessage(
        state,
        serverName,
        `MCP server "${serverName}" requires OAuth authentication. Run mcp({ action: "auth-start", server: "${serverName}" }) to get a browser URL, or /mcp-auth ${serverName} in an interactive local session.`,
      ),
    };
  }

  try {
    await authenticate(serverName, definition.url, definition);
    return { status: "success" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: "failed",
      message: getDirectAuthFailedMessage(state, serverName, message),
    };
  }
}

type DirectToolExecute = (
  toolCallId: string,
  params: Record<string, unknown>,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<Record<string, unknown>> | undefined,
  ctx: ExtensionContext,
) => Promise<AgentToolResult<Record<string, unknown>>>;

export function createDirectToolExecutor(
  getState: () => McpExtensionState | null,
  getInitPromise: () => Promise<McpExtensionState | null> | null,
  spec: DirectToolSpec
): DirectToolExecute {
  return async function execute(_toolCallId, params, signal) {
    throwIfAborted(signal);
    let state = getState();
    const initPromise = getInitPromise();

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

    let connected = await lazyConnect(state, spec.serverName, signal);
    let autoAuthAttempted = false;

    if (!connected && state.manager.getConnection(spec.serverName)?.status === "needs-auth") {
      autoAuthAttempted = true;
      const autoAuth = await attemptDirectAutoAuth(state, spec.serverName);
      if (autoAuth.status === "failed") {
        return {
          content: [{ type: "text" as const, text: autoAuth.message }],
          details: { error: "auth_required", server: spec.serverName, message: autoAuth.message },
        };
      }
      if (autoAuth.status === "success") {
        await state.manager.close(spec.serverName);
        state.failureTracker.delete(spec.serverName);
        connected = await lazyConnect(state, spec.serverName, signal);
      }
    }

    if (!connected) {
      const authConnection = state.manager.getConnection(spec.serverName);
      if (authConnection?.status === "needs-auth") {
        const message = getDirectAuthRequiredMessage(state, spec.serverName);
        return {
          content: [{ type: "text" as const, text: message }],
          details: { error: "auth_required", server: spec.serverName, message, autoAuthAttempted },
        };
      }
      const failedAgo = getFailureAgeSeconds(state, spec.serverName);
      return {
        content: [{ type: "text" as const, text: `MCP server "${spec.serverName}" not available${failedAgo !== null ? ` (failed ${failedAgo}s ago)` : ""}` }],
        details: { error: "server_unavailable", server: spec.serverName },
      };
    }

    const connection = state.manager.getConnection(spec.serverName);
    if (!connection || connection.status !== "connected") {
      return {
        content: [{ type: "text" as const, text: `MCP server "${spec.serverName}" not connected` }],
        details: { error: "not_connected", server: spec.serverName },
      };
    }

    let uiSession: UiSessionRuntime | null = null;
    const requestOptions = state.manager.getRequestOptions?.(spec.serverName, signal) ?? (signal ? { signal } : undefined);

    const outputGuardOptions = resolveMcpOutputGuardOptions(state.config.settings);

    try {
      state.manager.touch(spec.serverName);
      state.manager.incrementInFlight(spec.serverName);

      if (spec.resourceUri) {
        const result = await connection.client.readResource({ uri: spec.resourceUri }, requestOptions);
        const content = (result.contents ?? []).map(c => ({
          type: "text" as const,
          text: "text" in c ? c.text : ("blob" in c ? `[Binary data: ${(c as { mimeType?: string }).mimeType ?? "unknown"}]` : JSON.stringify(c)),
        }));
        const guarded = await guardMcpOutput(content.length > 0 ? content : [{ type: "text" as const, text: "(empty resource)" }], outputGuardOptions);
        return {
          content: guarded.content,
          details: { server: spec.serverName, resourceUri: spec.resourceUri, ...guardedMcpDetails(guarded) },
        };
      }

      const hasUi = !!spec.uiResourceUri;
      uiSession = hasUi
        ? await maybeStartUiSession(state, {
            serverName: spec.serverName,
            toolName: spec.originalName,
            toolArgs: params ?? {},
            uiResourceUri: spec.uiResourceUri!,
            streamMode: spec.uiStreamMode,
          })
        : null;

      const resultPromise = connection.client.callTool({
        name: spec.originalName,
        arguments: params ?? {},
        _meta: uiSession?.requestMeta,
      }, undefined, requestOptions);

      const result = await abortable(resultPromise, signal);
      uiSession?.sendToolResult(result as unknown as import("@modelcontextprotocol/sdk/types.js").CallToolResult);

      if (result.isError) {
        const mcpContent = (result.content ?? []) as McpContent[];
        const content = transformMcpContent(mcpContent);
        const outputContent = content.length > 0 ? content : [{ type: "text" as const, text: "(empty result)" }];
        const schemaText = spec.inputSchema ? `\n\nExpected parameters:\n${formatSchema(spec.inputSchema)}` : "";
        const guarded = await guardMcpOutput(outputContent, { ...outputGuardOptions, prefix: "Error: ", suffix: schemaText, emptyTextFallback: "Tool execution failed" });
        return {
          content: guarded.content,
          details: { error: "tool_error", server: spec.serverName, ...guardedMcpDetails(guarded) },
        };
      }

      const content = resolveMcpResultContent(result as Record<string, unknown>);
      const outputContent = content.length > 0 ? content : [{ type: "text" as const, text: "(empty result)" }];
      if (hasUi) {
        const uiMessage = uiSession?.reused
          ? "Updated the open UI."
          : "📺 Interactive UI is now open in your browser. I'll respond to your prompts and intents as you interact with it.";
        const guarded = await guardMcpOutput(outputContent, { ...outputGuardOptions, suffix: `\n\n${uiMessage}` });
        return {
          content: guarded.content,
          details: { server: spec.serverName, tool: spec.originalName, uiOpen: true, ...guardedMcpDetails(guarded) },
        };
      }

      const guarded = await guardMcpOutput(outputContent, { ...outputGuardOptions });
      return {
        content: guarded.content,
        details: { server: spec.serverName, tool: spec.originalName, ...guardedMcpDetails(guarded) },
      };
    } catch (error) {
      if (error instanceof UrlElicitationRequiredError) {
        const action = await state.manager.handleUrlElicitationRequired(spec.serverName, error);
        const message = action === "accept"
          ? "The original MCP tool did not run. Complete the opened browser interaction, then retry the tool."
          : `The URL interaction was ${action === "decline" ? "declined" : "cancelled"}.`;
        uiSession?.sendToolCancelled(message);
        return {
          content: [{ type: "text" as const, text: message }],
          details: { error: "url_elicitation_required", server: spec.serverName, action },
        };
      }
      const message = error instanceof Error ? error.message : String(error);
      uiSession?.sendToolCancelled(message);
      const schemaText = spec.inputSchema ? `\n\nExpected parameters:\n${formatSchema(spec.inputSchema)}` : "";
      const guarded = await guardMcpOutput([{ type: "text" as const, text: message }], { ...outputGuardOptions, prefix: "Failed to call tool: ", suffix: schemaText });
      return {
        content: guarded.content,
        details: { error: "call_failed", server: spec.serverName, ...guardedMcpDetails(guarded) },
      };
    } finally {
      if (uiSession?.reused) {
        uiSession.close();
      }
      state.manager.decrementInFlight(spec.serverName);
      state.manager.touch(spec.serverName);
    }
  };
}
