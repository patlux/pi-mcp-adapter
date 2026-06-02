import { getMarkdownTheme, keyText } from "@earendil-works/pi-coding-agent";
import type { AgentToolResult, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Text, TruncatedText, type Component } from "@earendil-works/pi-tui";

type McpToolResultDetails = Record<string, unknown> & { error?: unknown };
type McpToolContentBlock = AgentToolResult<McpToolResultDetails>["content"][number];

interface RenderTheme {
  fg: (name: string, text: string) => string;
  bold?: (text: string) => string;
}

interface ToolCallDisplay {
  title: ToolCallTitle;
  detailLines: string[];
}

interface ToolCallTitle {
  root: string;
  action?: string;
  target?: string;
  suffix?: string;
}

export interface McpProxyToolCallInput {
  tool?: string;
  args?: string;
  connect?: string;
  describe?: string;
  search?: string;
  regex?: boolean;
  includeSchemas?: boolean;
  server?: string;
  action?: string;
}

interface McpToolRenderContext {
  isError: boolean;
}

export interface McpToolResultDisplay {
  lines: string[];
  truncated: boolean;
}

const DEFAULT_MAX_CALL_INPUT_CHARS = 1500;
const MAX_PREVIEW_VALUE_CHARS = 160;
const REDACTED_VALUE = "[redacted]";
const SENSITIVE_KEY_PARTS = [
  "apikey",
  "authorization",
  "bearer",
  "cookie",
  "credential",
  "privatekey",
  "password",
  "passwd",
  "pwd",
  "refreshtoken",
  "secret",
  "sessionid",
  "token",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 1))}…`;
}

function truncatePreview(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 3))}...`;
}

function cleanSingleLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function isBarePreviewToken(value: string): boolean {
  return /^[A-Za-z0-9._:/@-]+$/.test(value);
}

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isSensitiveKey(key: string): boolean {
  const normalized = normalizeKey(key);
  return SENSITIVE_KEY_PARTS.some((part) => normalized.includes(part));
}

function safeStringify(value: unknown, space?: number): string {
  const seen = new WeakSet<object>();
  try {
    const json = JSON.stringify(
      value,
      (_key: string, currentValue: unknown) => {
        if (typeof currentValue === "bigint") return null;
        if (typeof currentValue === "number" && !Number.isFinite(currentValue)) return null;
        if (
          currentValue === undefined ||
          typeof currentValue === "function" ||
          typeof currentValue === "symbol"
        ) {
          return null;
        }
        if (typeof currentValue === "object" && currentValue !== null) {
          if (seen.has(currentValue)) return "[Circular]";
          seen.add(currentValue);
        }
        return currentValue;
      },
      space,
    );
    return json ?? "null";
  } catch {
    return String(value);
  }
}

function redactValue(value: unknown, key?: string): unknown {
  if (typeof key === "string" && isSensitiveKey(key)) return REDACTED_VALUE;

  if (Array.isArray(value)) {
    return value.map((entry) => redactValue(entry));
  }

  if (!isRecord(value)) return value;

  const redacted: Record<string, unknown> = {};
  for (const [entryKey, entryValue] of Object.entries(value)) {
    redacted[entryKey] = redactValue(entryValue, entryKey);
  }
  return redacted;
}

function formatJsonish(value: unknown, maxChars: number): string {
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      return truncateText(safeStringify(redactValue(parsed), 2), maxChars);
    } catch {
      return truncateText(cleanSingleLine(value), maxChars);
    }
  }

  return truncateText(safeStringify(redactValue(value), 2), maxChars);
}

function parseArgsObject(args: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(args);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function formatPreviewString(value: string, maxChars: number): string {
  const cleaned = cleanSingleLine(value);
  if (cleaned.length > 0 && isBarePreviewToken(cleaned)) {
    return truncatePreview(cleaned, maxChars);
  }
  return truncatePreview(safeStringify(cleaned), maxChars);
}

function formatPreviewKey(key: string, maxChars: number): string {
  if (key.length > 0 && isBarePreviewToken(key)) {
    return truncatePreview(key, maxChars);
  }
  return truncatePreview(safeStringify(key), maxChars);
}

function formatPreviewValue(key: string, value: unknown, maxChars: number): string {
  if (isSensitiveKey(key)) return REDACTED_VALUE;

  if (value === null) return "null";

  switch (typeof value) {
    case "string":
      return formatPreviewString(value, maxChars);
    case "number":
      return Number.isFinite(value) ? String(value) : "null";
    case "boolean":
      return value ? "true" : "false";
    case "bigint":
      return "null";
    case "object":
      return truncatePreview(safeStringify(redactValue(value)), maxChars);
    default:
      return "null";
  }
}

function formatArgsObjectKeyValuePreview(
  value: Record<string, unknown>,
  maxChars: number,
): string | undefined {
  const entries = Object.entries(value);
  if (entries.length === 0) return undefined;

  const preview = entries
    .map(
      ([key, entryValue]) =>
        `${formatPreviewKey(key, MAX_PREVIEW_VALUE_CHARS)}=${formatPreviewValue(key, entryValue, MAX_PREVIEW_VALUE_CHARS)}`,
    )
    .join(" ");

  return preview.length > 0 ? truncatePreview(preview, maxChars) : undefined;
}

function formatArgsPreview(args: string, maxChars: number): string | undefined {
  if (maxChars <= 0) return undefined;

  const parsed = parseArgsObject(args);
  if (parsed) {
    return formatArgsObjectKeyValuePreview(parsed, maxChars);
  }

  const cleaned = cleanSingleLine(args);
  return cleaned.length > 0 ? truncatePreview(cleaned, maxChars) : undefined;
}

function hasUsefulObjectContent(value: unknown): boolean {
  return isRecord(value) && Object.keys(value).length > 0;
}

function formatServerToolTarget(tool: string, server?: string): string {
  const cleanTool = tool.trim();
  const cleanServer = server?.trim();
  if (cleanTool.includes(".")) return cleanTool;

  if (!cleanServer) {
    const separator = cleanTool.indexOf("_");
    if (separator > 0 && separator < cleanTool.length - 1) {
      return `${cleanTool.slice(0, separator)}.${cleanTool.slice(separator + 1)}`;
    }
    return cleanTool;
  }

  const serverPrefix = `${cleanServer}_`;
  if (cleanTool.startsWith(serverPrefix)) {
    return `${cleanServer}.${cleanTool.slice(serverPrefix.length)}`;
  }

  return `${cleanServer}.${cleanTool}`;
}

function titleToPlainLine(title: ToolCallTitle): string {
  const parts = [title.root, title.action, title.target, title.suffix].filter(
    (part): part is string => Boolean(part),
  );
  return parts.join(" ");
}

function formatMcpProxyToolCallDisplay(
  args: McpProxyToolCallInput,
  maxInputChars = DEFAULT_MAX_CALL_INPUT_CHARS,
): ToolCallDisplay {
  if (args.action === "ui-messages") {
    return { title: { root: "mcp", action: args.action }, detailLines: [] };
  }

  if (args.tool) {
    const target = formatServerToolTarget(args.tool, args.server);
    const detailLines = args.args ? [formatArgsPreview(args.args, maxInputChars)].filter((line): line is string => Boolean(line)) : [];
    return { title: { root: "mcp", action: "call", target }, detailLines };
  }

  if (args.connect) {
    return { title: { root: "mcp", action: "connect", target: args.connect }, detailLines: [] };
  }

  if (args.describe) {
    return {
      title: { root: "mcp", action: "describe", target: formatServerToolTarget(args.describe, args.server) },
      detailLines: [],
    };
  }

  if (args.search) {
    const suffixParts: string[] = [];
    if (args.server) suffixParts.push(`@ ${args.server}`);
    if (args.regex === true) suffixParts.push("regex");
    if (args.includeSchemas === false) suffixParts.push("schemas hidden");
    const suffix = suffixParts.length > 0 ? suffixParts.join(" • ") : undefined;
    return {
      title: { root: "mcp", action: "search", target: `\"${cleanSingleLine(args.search)}\"`, suffix },
      detailLines: [],
    };
  }

  if (args.server) {
    return { title: { root: "mcp", action: "list", target: args.server }, detailLines: [] };
  }

  if (args.action) {
    return { title: { root: "mcp", action: args.action }, detailLines: [] };
  }

  return { title: { root: "mcp", action: "status" }, detailLines: [] };
}

export function formatMcpProxyToolCallLines(
  args: McpProxyToolCallInput,
  maxInputChars = DEFAULT_MAX_CALL_INPUT_CHARS,
): string[] {
  const display = formatMcpProxyToolCallDisplay(args, maxInputChars);
  return [titleToPlainLine(display.title), ...display.detailLines.map((line) => `  ${line}`)];
}

export function formatMcpDirectToolCallLines(
  displayName: string,
  args: Record<string, unknown>,
  maxInputChars = DEFAULT_MAX_CALL_INPUT_CHARS,
): string[] {
  const title = formatServerToolTarget(displayName);
  if (!hasUsefulObjectContent(args)) return [title];
  const preview = formatArgsObjectKeyValuePreview(args, maxInputChars);
  return preview ? [title, `  ${preview}`] : [title];
}

function bold(theme: RenderTheme, text: string): string {
  return theme.bold ? theme.bold(text) : text;
}

function renderStyledTitle(title: ToolCallTitle, theme: RenderTheme): string {
  let output = theme.fg("toolTitle", bold(theme, title.root));
  if (title.action) output += ` ${theme.fg("accent", title.action)}`;
  if (title.target) output += ` ${theme.fg("muted", title.target)}`;
  if (title.suffix) output += ` ${theme.fg("dim", title.suffix)}`;
  return output;
}

function renderToolCallDisplay(display: ToolCallDisplay, theme: RenderTheme): Component {
  return new ToolCallComponent(display, theme);
}

class ToolCallComponent implements Component {
  constructor(
    private readonly display: ToolCallDisplay,
    private readonly theme: RenderTheme,
  ) {}

  render(width: number): string[] {
    const container = new Container();
    container.addChild(new TruncatedText(renderStyledTitle(this.display.title, this.theme), 0, 0));
    for (const line of this.display.detailLines) {
      container.addChild(new TruncatedText(`  ${this.theme.fg("muted", line)}`, 0, 0));
    }
    return container.render(width);
  }

  invalidate(): void {}
}

export function renderMcpProxyToolCall(args: McpProxyToolCallInput, theme: RenderTheme): Component {
  return renderToolCallDisplay(formatMcpProxyToolCallDisplay(args), theme);
}

export function createMcpDirectToolCallRenderer(displayName: string) {
  return (args: Record<string, unknown>, theme: RenderTheme): Component => {
    const preview = hasUsefulObjectContent(args)
      ? formatArgsObjectKeyValuePreview(args, DEFAULT_MAX_CALL_INPUT_CHARS)
      : undefined;
    return renderToolCallDisplay(
      {
        title: { root: formatServerToolTarget(displayName) },
        detailLines: preview ? [preview] : [],
      },
      theme,
    );
  };
}

function blockToLines(block: McpToolContentBlock): string[] {
  if (block.type === "text") {
    return block.text.split("\n");
  }
  return [`[image: ${block.mimeType}]`];
}

function blockToText(block: McpToolContentBlock): string {
  if (block.type === "text") return block.text;
  return `[image: ${block.mimeType}]`;
}

function resultText(result: Pick<AgentToolResult<McpToolResultDetails>, "content">): string {
  const text = result.content.map(blockToText).join("\n").trimEnd();
  return text.length > 0 ? text : "(empty result)";
}

function firstNonEmptyLine(text: string): string | undefined {
  return text
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
}

function stringDetail(details: McpToolResultDetails, key: string): string | undefined {
  const value = details[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function detailToolName(details: McpToolResultDetails): string | undefined {
  const server = stringDetail(details, "server");
  const directTool = stringDetail(details, "tool");
  if (directTool) return formatServerToolTarget(directTool, server);

  const requestedTool = stringDetail(details, "requestedTool");
  if (requestedTool) return formatServerToolTarget(requestedTool, server);

  const tool = details.tool;
  if (isRecord(tool)) {
    const name = tool.name;
    if (typeof name === "string" && name.trim().length > 0) {
      return formatServerToolTarget(name, server);
    }
  }

  return server;
}

function resultHasText(result: Pick<AgentToolResult<McpToolResultDetails>, "content">): boolean {
  return result.content.some((block) => block.type === "text" && block.text.trim().length > 0);
}

function collapsedResultSummary(result: AgentToolResult<McpToolResultDetails>): string {
  const details = result.details;
  const mode = stringDetail(details, "mode");
  const text = resultText(result);
  const firstLine = firstNonEmptyLine(text);
  const toolName = detailToolName(details);

  if (mode === "describe") {
    return `${toolName ?? firstLine ?? "MCP tool"} schema available`;
  }

  if (mode === "call" || toolName) {
    const suffix = resultHasText(result) ? "text output" : "output available";
    return `${toolName ?? "MCP tool"}: ${suffix}`;
  }

  if (mode === "search") {
    return firstLine ?? "MCP search results available";
  }

  if (mode === "list" || mode === "connect" || mode === "status") {
    return firstLine ?? "MCP output available";
  }

  return firstLine ?? "MCP output available";
}

function formatExpandHint(theme: RenderTheme): string {
  let key = "";
  try {
    key = keyText("app.tools.expand").trim().toLowerCase();
  } catch {
    key = "";
  }
  return `${theme.fg("dim", key || "ctrl+o")}${theme.fg("muted", " to expand")}`;
}

function withExpandHint(text: string, theme: RenderTheme): string {
  return `${text} (${formatExpandHint(theme)})`;
}

function renderErrorText(text: string, theme: RenderTheme): Component {
  const rendered = text
    .split("\n")
    .map((line) => theme.fg("error", line))
    .join("\n");
  return new Text(rendered, 0, 0);
}

function renderExpandedResult(text: string, theme: RenderTheme): Component {
  return new Markdown(text, 0, 0, getMarkdownTheme(), {
    color: (line) => theme.fg("toolOutput", line),
  });
}

export function formatMcpToolResultLines(
  result: Pick<AgentToolResult<McpToolResultDetails>, "content">,
  expanded: boolean,
  maxCollapsedLines = 3,
): McpToolResultDisplay {
  const allLines = result.content.flatMap(blockToLines);
  const lines = allLines.length > 0 ? allLines : ["(empty result)"];

  if (expanded || lines.length <= maxCollapsedLines) {
    return { lines, truncated: false };
  }

  return {
    lines: [...lines.slice(0, maxCollapsedLines), "…"],
    truncated: true,
  };
}

export function renderMcpToolResult(
  result: AgentToolResult<McpToolResultDetails>,
  options: ToolRenderResultOptions,
  theme: RenderTheme,
  context?: McpToolRenderContext,
): Component {
  if (options.isPartial) {
    return new Text(theme.fg("warning", "Calling MCP tool…"), 0, 0);
  }

  const text = resultText(result);
  const hasError = context?.isError === true || Boolean(result.details.error);
  if (hasError) {
    return renderErrorText(text, theme);
  }

  if (options.expanded) {
    return renderExpandedResult(text, theme);
  }

  return new Text(withExpandHint(theme.fg("success", collapsedResultSummary(result)), theme), 0, 0);
}
