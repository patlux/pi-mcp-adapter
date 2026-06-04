import { describe, expect, it, vi } from "vitest";
import type { ElicitRequest } from "@modelcontextprotocol/sdk/types.js";

const mocks = vi.hoisted(() => ({
  open: vi.fn(async () => undefined),
}));

vi.mock("open", () => ({ default: mocks.open }));

function formRequest(params: ElicitRequest["params"]): ElicitRequest {
  return { method: "elicitation/create", params } as ElicitRequest;
}

describe("elicitation handler", () => {
  it("converts form elicitation schemas to Pi forms and returns accepted content", async () => {
    const { handleElicitationRequest } = await import("../elicitation-handler.ts");
    const ui = {
      form: vi.fn(async () => ({
        action: "submit",
        values: {
          title: "Bug in auth flow",
          priority: "medium",
          assignToMe: true,
        },
      })),
    };

    const result = await handleElicitationRequest(
      { serverName: "github", ui: ui as any, autoOpenUrls: false },
      formRequest({
        mode: "form",
        message: "Create a new issue",
        requestedSchema: {
          type: "object",
          properties: {
            title: {
              type: "string",
              title: "Title",
              description: "Issue title",
              minLength: 1,
            },
            priority: {
              type: "string",
              title: "Priority",
              enum: ["low", "medium", "high"],
              default: "medium",
            },
            assignToMe: {
              type: "boolean",
              title: "Assign to me",
              default: false,
            },
          },
          required: ["title"],
        },
      }),
    );

    expect(ui.form).toHaveBeenCalledWith({
      title: "MCP Input Request",
      message: "Server: github\n\nCreate a new issue",
      submitLabel: "Submit",
      secondaryLabel: "Decline",
      cancelLabel: "Cancel",
      fields: [
        {
          type: "text",
          name: "title",
          label: "Title",
          description: "Issue title",
          required: true,
          minLength: 1,
        },
        {
          type: "select",
          name: "priority",
          label: "Priority",
          required: false,
          options: [
            { value: "low" },
            { value: "medium" },
            { value: "high" },
          ],
          defaultValue: "medium",
        },
        {
          type: "boolean",
          name: "assignToMe",
          label: "Assign to me",
          defaultValue: false,
        },
      ],
    });
    expect(result).toEqual({
      action: "accept",
      content: {
        title: "Bug in auth flow",
        priority: "medium",
        assignToMe: true,
      },
    });
  });

  it("shows URL elicitations as a Pi form and opens accepted URLs", async () => {
    const { handleElicitationRequest } = await import("../elicitation-handler.ts");
    const ui = {
      form: vi.fn(async () => ({ action: "submit", values: {} })),
      notify: vi.fn(),
    };

    const result = await handleElicitationRequest(
      { serverName: "stripe", ui: ui as any, autoOpenUrls: false },
      formRequest({
        mode: "url",
        message: "Confirm payment authorization",
        elicitationId: "elicit_123",
        url: "https://checkout.stripe.com/c/pay/cs_test_123",
      }),
    );

    expect(ui.form).toHaveBeenCalledWith({
      title: "MCP Browser Request",
      message: [
        "Server: stripe",
        "",
        "Confirm payment authorization",
        "",
        "Domain: checkout.stripe.com",
        "URL: https://checkout.stripe.com/c/pay/cs_test_123",
        "",
        "Open this URL in your browser?",
      ].join("\n"),
      fields: [],
      submitLabel: "Open",
      secondaryLabel: "Decline",
      cancelLabel: "Cancel",
    });
    expect(mocks.open).toHaveBeenCalledWith("https://checkout.stripe.com/c/pay/cs_test_123");
    expect(ui.notify).toHaveBeenCalledWith("Opened browser for MCP elicitation.", "info");
    expect(result).toEqual({ action: "accept" });
  });

  it("maps Pi secondary and cancel form actions to MCP decline and cancel", async () => {
    const { handleElicitationRequest } = await import("../elicitation-handler.ts");
    const makeRequest = () =>
      formRequest({
        mode: "form",
        message: "Continue?",
        requestedSchema: {
          type: "object",
          properties: {
            reason: { type: "string", title: "Reason" },
          },
        },
      });

    const declineUi = { form: vi.fn(async () => ({ action: "secondary" })) };
    const cancelUi = { form: vi.fn(async () => ({ action: "cancel" })) };

    await expect(
      handleElicitationRequest({ serverName: "demo", ui: declineUi as any, autoOpenUrls: false }, makeRequest()),
    ).resolves.toEqual({ action: "decline" });
    await expect(
      handleElicitationRequest({ serverName: "demo", ui: cancelUi as any, autoOpenUrls: false }, makeRequest()),
    ).resolves.toEqual({ action: "cancel" });
  });
});
