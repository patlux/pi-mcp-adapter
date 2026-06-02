import type { AgentToolResult, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
  formatMcpDirectToolCallLines,
  formatMcpProxyToolCallLines,
  formatMcpToolResultLines,
  renderMcpProxyToolCall,
  renderMcpToolResult,
} from "../tool-result-renderer.ts";

type TestDetails = Record<string, unknown> & { error?: unknown };
type TestResult = AgentToolResult<TestDetails>;

const collapsedOptions: ToolRenderResultOptions = { expanded: false, isPartial: false };
const plainTheme = { fg: (_name: string, text: string) => text };
const labeledTheme = {
  fg: (name: string, text: string) => `<${name}>${text}</${name}>`,
  bold: (text: string) => `**${text}**`,
};

function result(content: TestResult["content"], details: TestDetails = {}): TestResult {
  return { content, details };
}

describe("MCP tool call renderer", () => {
  it("shows proxy tool calls with compact arguments", () => {
    const display = formatMcpProxyToolCallLines({
      tool: "cf-portal_list_worker_tail_events",
      server: "cf-portal",
      args: JSON.stringify({ accountId: "abc", scriptName: "worker" }),
    });

    expect(display).toEqual([
      "mcp call cf-portal.list_worker_tail_events",
      "  accountId=abc scriptName=worker",
    ]);
  });

  it("normalizes underscore-prefixed proxy tool names", () => {
    const display = formatMcpProxyToolCallLines({
      tool: "piparo_expo_bootstrap_plan",
      args: JSON.stringify({ project_name: "smoke-pui", target_parent: "/tmp", add_pui_smoke_component: true }),
    });

    expect(display).toEqual([
      "mcp call piparo.expo_bootstrap_plan",
      "  project_name=smoke-pui target_parent=/tmp add_pui_smoke_component=true",
    ]);
  });

  it("redacts sensitive proxy argument previews", () => {
    const display = formatMcpProxyToolCallLines({
      tool: "piparo_expo_bootstrap_plan",
      args: JSON.stringify({ authorization: "Bearer abc", nested: { token: "secret", ok: 1 } }),
    });

    expect(display).toEqual([
      "mcp call piparo.expo_bootstrap_plan",
      '  authorization=[redacted] nested={"token":"[redacted]","ok":1}',
    ]);
  });

  it("shows proxy discovery operations", () => {
    expect(formatMcpProxyToolCallLines({ search: "tail events", server: "cf-portal", regex: true })).toEqual([
      'mcp search "tail events" @ cf-portal • regex',
    ]);
    expect(formatMcpProxyToolCallLines({ connect: "cf-portal" })).toEqual(["mcp connect cf-portal"]);
    expect(formatMcpProxyToolCallLines({ server: "cf-portal" })).toEqual(["mcp list cf-portal"]);
    expect(formatMcpProxyToolCallLines({})).toEqual(["mcp status"]);
  });

  it("renders ui-messages with execution precedence", () => {
    expect(formatMcpProxyToolCallLines({ action: "ui-messages", server: "cf-portal" })).toEqual(["mcp ui-messages"]);
  });

  it("shows direct tool calls with compact arguments", () => {
    const display = formatMcpDirectToolCallLines("cf-portal_list_worker_tail_events", {
      accountId: "abc",
      scriptName: "worker",
    });

    expect(display).toEqual([
      "cf-portal.list_worker_tail_events",
      "  accountId=abc scriptName=worker",
    ]);
  });

  it("omits empty direct tool arguments", () => {
    expect(formatMcpDirectToolCallLines("cf-portal_status", {})).toEqual(["cf-portal.status"]);
  });

  it("renders proxy call titles with separate theme colors", () => {
    const output = renderMcpProxyToolCall({
      tool: "piparo_expo_bootstrap_plan",
      args: JSON.stringify({ project_name: "smoke-pui" }),
    }, labeledTheme).render(120).join("\n");

    expect(output).toContain("<toolTitle>**mcp**</toolTitle>");
    expect(output).toContain("<accent>call</accent>");
    expect(output).toContain("<muted>piparo.expo_bootstrap_plan</muted>");
    expect(output).toContain("<muted>project_name=smoke-pui</muted>");
  });
});

describe("MCP tool result renderer", () => {
  it("shows the first three lines and an ellipsis for collapsed long text", () => {
    const display = formatMcpToolResultLines(result([
      { type: "text", text: "one\ntwo\nthree\nfour" },
    ]), false);

    expect(display).toEqual({
      lines: ["one", "two", "three", "…"],
      truncated: true,
    });
  });

  it("does not add an ellipsis when collapsed text is three lines or fewer", () => {
    const display = formatMcpToolResultLines(result([
      { type: "text", text: "one\ntwo\nthree" },
    ]), false);

    expect(display).toEqual({
      lines: ["one", "two", "three"],
      truncated: false,
    });
  });

  it("shows full text when expanded", () => {
    const display = formatMcpToolResultLines(result([
      { type: "text", text: "one\ntwo\nthree\nfour" },
    ]), true);

    expect(display).toEqual({
      lines: ["one", "two", "three", "four"],
      truncated: false,
    });
  });

  it("uses placeholders for images", () => {
    const display = formatMcpToolResultLines(result([
      { type: "text", text: "before" },
      { type: "image", mimeType: "image/png", data: "abc" },
    ]), true);

    expect(display.lines).toEqual(["before", "[image: image/png]"]);
  });

  it("uses an empty-result placeholder when content is empty", () => {
    const display = formatMcpToolResultLines(result([]), false);

    expect(display).toEqual({ lines: ["(empty result)"], truncated: false });
  });

  it("keeps error text visible", () => {
    const display = formatMcpToolResultLines(result([
      { type: "text", text: "Error: upstream failed\nExpected parameters:\n{}" },
    ]), false);

    expect(display.lines).toEqual(["Error: upstream failed", "Expected parameters:", "{}"]);
    expect(display.truncated).toBe(false);
  });

  it("renders long error results expanded even when the row is collapsed", () => {
    const output = renderMcpToolResult(
      result([{ type: "text", text: "Error: failed\nline 2\nline 3\nline 4" }]),
      collapsedOptions,
      plainTheme,
      { isError: true },
    ).render(80).join("\n");

    expect(output).toContain("line 4");
    expect(output).not.toContain("Ctrl+O to expand");
    expect(output).not.toContain("…");
  });

  it("renders adapter error details expanded even when Pi context is not marked as an error", () => {
    const output = renderMcpToolResult(
      result([{ type: "text", text: "Error: failed\nline 2\nline 3\nline 4" }], { error: "tool_error" }),
      collapsedOptions,
      plainTheme,
      { isError: false },
    ).render(80).join("\n");

    expect(output).toContain("line 4");
    expect(output).not.toContain("Ctrl+O to expand");
    expect(output).not.toContain("…");
  });
});
