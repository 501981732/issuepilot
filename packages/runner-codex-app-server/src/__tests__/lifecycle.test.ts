import { describe, it, expect, vi } from "vitest";
import { driveLifecycle } from "../lifecycle.js";
import type { RpcClient } from "../rpc.js";

function createFakeRpc(
  responses: Map<string, unknown>,
  notifications: Array<{ method: string; params: unknown }> = [],
): RpcClient & {
  notifHandler: (m: string, p: unknown) => void;
  requestHandler: (m: string, p: unknown) => Promise<unknown> | unknown;
} {
  let notifHandler: (m: string, p: unknown) => void = () => {};
  let requestHandler: (
    m: string,
    p: unknown,
  ) => Promise<unknown> | unknown = () => {
    throw new Error("No request handler registered");
  };

  const client: RpcClient & {
    notifHandler: (m: string, p: unknown) => void;
    requestHandler: (m: string, p: unknown) => Promise<unknown> | unknown;
  } = {
    get notifHandler() {
      return notifHandler;
    },
    get requestHandler() {
      return requestHandler;
    },
    request: vi.fn(async (method: string) => {
      if (responses.has(method)) {
        return responses.get(method);
      }
      throw new Error(`Unexpected method: ${method}`);
    }),
    notify: vi.fn(),
    onNotification: vi.fn((handler) => {
      notifHandler = handler;
    }),
    onMalformed: vi.fn(),
    onRequest: vi.fn((handler) => {
      requestHandler = handler;
    }),
    close: vi.fn(async () => {}),
    waitExit: vi.fn(async () => ({ code: 0, signal: null })),
  };

  setTimeout(() => {
    for (const n of notifications) {
      notifHandler(n.method, n.params);
    }
  }, 10);

  return client;
}

describe("driveLifecycle", () => {
  it("initializes Codex app-server with clientInfo", async () => {
    const rpc = createFakeRpc(
      new Map([
        ["initialize", { serverInfo: { name: "codex", version: "1.0" } }],
        ["thread/start", { threadId: "t1" }],
        ["turn/start", { turnId: "u1" }],
      ]),
      [
        {
          method: "turn/completed",
          params: { turnId: "u1", stop: true },
        },
      ],
    );

    await driveLifecycle({
      rpc,
      maxTurns: 1,
      prompt: "Fix",
      title: "Fix",
      cwd: "/tmp/ws",
      threadName: "test",
      sandboxType: "workspace-write",
      approvalPolicy: "never",
      turnSandboxPolicy: { type: "workspaceWrite" },
      turnTimeoutMs: 5000,
      tools: [],
      onEvent: () => {},
    });

    expect(rpc.request).toHaveBeenCalledWith("initialize", {
      clientInfo: { name: "issuepilot", version: "0.0.0" },
      capabilities: {},
    });
  });

  it("uses the Codex 0.129 thread and turn payload shapes", async () => {
    const rpc = createFakeRpc(
      new Map([
        ["initialize", { serverInfo: { name: "codex", version: "1.0" } }],
        ["thread/start", { thread: { id: "t1" } }],
        ["turn/start", { turn: { id: "u1" } }],
      ]),
      [
        {
          method: "turn/completed",
          params: { threadId: "t1", turn: { id: "u1" } },
        },
      ],
    );

    const result = await driveLifecycle({
      rpc,
      maxTurns: 1,
      prompt: "Fix the bug",
      title: "Fix bug",
      cwd: "/tmp/ws",
      threadName: "test",
      sandboxType: "workspace-write",
      approvalPolicy: "never",
      turnSandboxPolicy: { type: "workspaceWrite" },
      turnTimeoutMs: 5000,
      tools: [],
      onEvent: () => {},
    });

    expect(result).toMatchObject({
      status: "completed",
      threadId: "t1",
      lastTurnId: "u1",
    });
    expect(rpc.request).toHaveBeenCalledWith(
      "thread/start",
      expect.objectContaining({
        cwd: "/tmp/ws",
        sandbox: "workspace-write",
        approvalPolicy: "never",
      }),
    );
    expect(rpc.request).toHaveBeenCalledWith(
      "turn/start",
      expect.objectContaining({
        threadId: "t1",
        input: [{ type: "text", text: "Fix the bug", text_elements: [] }],
        cwd: "/tmp/ws",
        sandboxPolicy: {
          type: "workspaceWrite",
          writableRoots: ["/tmp/ws"],
          networkAccess: false,
          excludeTmpdirEnvVar: false,
          excludeSlashTmp: false,
        },
      }),
    );
  });

  it("completes a single-turn lifecycle", async () => {
    const rpc = createFakeRpc(
      new Map([
        ["initialize", { serverInfo: { name: "codex", version: "1.0" } }],
        ["thread/start", { threadId: "t1" }],
        ["turn/start", { turnId: "u1" }],
      ]),
      [
        {
          method: "turn/completed",
          params: { turnId: "u1", stop: true },
        },
      ],
    );

    const events: string[] = [];
    const result = await driveLifecycle({
      rpc,
      maxTurns: 3,
      prompt: "Fix the bug",
      title: "Fix bug",
      cwd: "/tmp/ws",
      threadName: "test-thread",
      sandboxType: "workspace-write",
      approvalPolicy: "never",
      turnSandboxPolicy: { type: "workspaceWrite" },
      turnTimeoutMs: 5000,
      tools: [],
      onEvent: (type) => {
        events.push(type);
      },
    });

    expect(result.status).toBe("completed");
    expect(result.turnsUsed).toBe(1);
    expect(result.threadId).toBe("t1");
    expect(events).toContain("session_started");
    expect(events).toContain("turn_started");
    expect(events).toContain("turn_completed");
  });

  it("normalizes non-terminal app-server notifications to canonical event types", async () => {
    const rpc = createFakeRpc(
      new Map([
        ["initialize", { serverInfo: { name: "codex", version: "1.0" } }],
        ["thread/start", { threadId: "t1" }],
        ["turn/start", { turnId: "u1" }],
      ]),
      [
        {
          method: "turn/notification",
          params: { turnId: "u1", message: "working" },
        },
        {
          method: "unknown/event",
          params: { turnId: "u1" },
        },
        {
          method: "turn/completed",
          params: { turnId: "u1", stop: true },
        },
      ],
    );

    const events: string[] = [];
    await driveLifecycle({
      rpc,
      maxTurns: 1,
      prompt: "Fix",
      title: "Fix",
      cwd: "/tmp/ws",
      threadName: "test-thread",
      sandboxType: "workspace-write",
      approvalPolicy: "never",
      turnSandboxPolicy: { type: "workspaceWrite" },
      turnTimeoutMs: 5000,
      tools: [],
      onEvent: (type) => {
        events.push(type);
      },
    });

    expect(events).toContain("notification");
    expect(events).toContain("malformed_message");
    expect(events).not.toContain("turn_notification");
    expect(events).not.toContain("unknown_event");
  });

  it("captures the last turn notification message as finalMessage", async () => {
    const rpc = createFakeRpc(
      new Map([
        ["initialize", { serverInfo: { name: "codex", version: "1.0" } }],
        ["thread/start", { threadId: "t1" }],
        ["turn/start", { turnId: "u1" }],
      ]),
      [
        {
          method: "turn/notification",
          params: { turnId: "u1", message: "working" },
        },
        {
          method: "turn/notification",
          params: { turnId: "u1", message: "final reviewer json" },
        },
        {
          method: "turn/completed",
          params: { turnId: "u1", stop: true },
        },
      ],
    );

    const result = await driveLifecycle({
      rpc,
      maxTurns: 1,
      prompt: "Review",
      title: "Review",
      cwd: "/tmp/ws",
      threadName: "test-thread",
      sandboxType: "workspace-write",
      approvalPolicy: "never",
      turnSandboxPolicy: { type: "workspaceWrite" },
      turnTimeoutMs: 5000,
      tools: [],
      onEvent: () => {},
    });

    expect(result.status).toBe("completed");
    expect(result.finalMessage).toBe("final reviewer json");
  });

  it("reports failed status on turn/failed", async () => {
    const rpc = createFakeRpc(
      new Map([
        ["initialize", { serverInfo: { name: "codex", version: "1.0" } }],
        ["thread/start", { threadId: "t1" }],
        ["turn/start", { turnId: "u1" }],
      ]),
      [
        {
          method: "turn/failed",
          params: { turnId: "u1", error: "something went wrong" },
        },
      ],
    );

    const result = await driveLifecycle({
      rpc,
      maxTurns: 3,
      prompt: "Fix",
      title: "Fix",
      cwd: "/tmp/ws",
      threadName: "test",
      sandboxType: "workspace-write",
      approvalPolicy: "never",
      turnSandboxPolicy: { type: "workspaceWrite" },
      turnTimeoutMs: 5000,
      tools: [],
      onEvent: () => {},
    });

    expect(result.status).toBe("failed");
    expect(result.failureReason).toContain("something went wrong");
  });

  it("does not lose turn notifications emitted immediately after turn/start", async () => {
    const rpc = createFakeRpc(
      new Map([
        ["initialize", { serverInfo: { name: "codex", version: "1.0" } }],
        ["thread/start", { threadId: "t1" }],
      ]),
    );
    (rpc.request as ReturnType<typeof vi.fn>).mockImplementation(
      async (method: string) => {
        if (method === "initialize")
          return { serverInfo: { name: "codex", version: "1.0" } };
        if (method === "thread/start") return { threadId: "t1" };
        if (method === "turn/start") {
          rpc.notifHandler("turn/failed", {
            turnId: "u1",
            error: "failed before wait registered",
          });
          return { turnId: "u1" };
        }
        throw new Error(`Unexpected: ${method}`);
      },
    );

    const result = await driveLifecycle({
      rpc,
      maxTurns: 1,
      prompt: "Fix",
      title: "Fix",
      cwd: "/tmp/ws",
      threadName: "test",
      sandboxType: "workspace-write",
      approvalPolicy: "never",
      turnSandboxPolicy: { type: "workspaceWrite" },
      turnTimeoutMs: 5000,
      tools: [],
      onEvent: () => {},
    });

    expect(result).toMatchObject({
      status: "failed",
      failureReason: "failed before wait registered",
    });
  });

  it("stops after maxTurns if no stop signal", async () => {
    let turnCount = 0;
    const rpc = createFakeRpc(
      new Map([
        ["initialize", { serverInfo: { name: "codex", version: "1.0" } }],
        ["thread/start", { threadId: "t1" }],
      ]),
    );

    (rpc.request as ReturnType<typeof vi.fn>).mockImplementation(
      async (method: string) => {
        if (method === "initialize")
          return { serverInfo: { name: "codex", version: "1.0" } };
        if (method === "thread/start") return { threadId: "t1" };
        if (method === "turn/start") {
          turnCount++;
          const turnId = `u${turnCount}`;
          setTimeout(() => {
            rpc.notifHandler("turn/completed", {
              turnId,
              stop: turnCount >= 2,
            });
          }, 5);
          return { turnId };
        }
        throw new Error(`Unexpected: ${method}`);
      },
    );

    const result = await driveLifecycle({
      rpc,
      maxTurns: 2,
      prompt: "Fix",
      title: "Fix",
      cwd: "/tmp/ws",
      threadName: "test",
      sandboxType: "workspace-write",
      approvalPolicy: "never",
      turnSandboxPolicy: { type: "workspaceWrite" },
      turnTimeoutMs: 5000,
      tools: [],
      onEvent: () => {},
    });

    expect(result.turnsUsed).toBe(2);
    expect(result.status).toBe("completed");
  });

  it("handles app-server dynamic tool call requests", async () => {
    const rpc = createFakeRpc(
      new Map([
        ["initialize", { serverInfo: { name: "codex", version: "1.0" } }],
        ["thread/start", { threadId: "t1" }],
        ["turn/start", { turnId: "u1" }],
      ]),
      [
        {
          method: "turn/completed",
          params: { turnId: "u1", stop: true },
        },
      ],
    );

    const events: string[] = [];
    const resultPromise = driveLifecycle({
      rpc,
      maxTurns: 1,
      prompt: "Fix",
      title: "Fix",
      cwd: "/tmp/ws",
      threadName: "test",
      sandboxType: "workspace-write",
      approvalPolicy: "never",
      turnSandboxPolicy: { type: "workspaceWrite" },
      turnTimeoutMs: 5000,
      tools: [
        {
          name: "gitlab_get_issue",
          description: "Get issue",
          inputSchema: { type: "object" },
          handler: vi.fn(async () => ({ ok: true })),
        },
      ],
      onEvent: (type) => events.push(type),
    });

    await Promise.resolve();
    const response = await rpc.requestHandler("item/tool/call", {
      tool: "gitlab_get_issue",
      arguments: {},
      callId: "call-1",
      threadId: "t1",
      turnId: "u1",
    });
    const result = await resultPromise;

    expect(response).toMatchObject({
      success: true,
      contentItems: [{ type: "inputText", text: JSON.stringify({ ok: true }) }],
    });
    expect(events).toContain("tool_call_started");
    expect(events).toContain("tool_call_completed");
    expect(result.status).toBe("completed");
    expect(result.completedToolCalls).toEqual([
      { tool: "gitlab_get_issue", result: { ok: true } },
    ]);
  });

  it("auto-approves command and file approval requests when approvalPolicy is never", async () => {
    const rpc = createFakeRpc(
      new Map([
        ["initialize", { serverInfo: { name: "codex", version: "1.0" } }],
        ["thread/start", { threadId: "t1" }],
        ["turn/start", { turnId: "u1" }],
      ]),
      [
        {
          method: "turn/completed",
          params: { turnId: "u1", stop: true },
        },
      ],
    );
    const events: string[] = [];

    const resultPromise = driveLifecycle({
      rpc,
      maxTurns: 1,
      prompt: "Fix",
      title: "Fix",
      cwd: "/tmp/ws",
      threadName: "test",
      sandboxType: "workspace-write",
      approvalPolicy: "never",
      turnSandboxPolicy: { type: "workspaceWrite" },
      turnTimeoutMs: 5000,
      tools: [],
      onEvent: (type) => events.push(type),
    });

    await Promise.resolve();
    await expect(
      rpc.requestHandler("item/commandExecution/requestApproval", {}),
    ).resolves.toEqual({ decision: "accept" });
    await expect(
      rpc.requestHandler("item/fileChange/requestApproval", {}),
    ).resolves.toEqual({ decision: "accept" });
    await resultPromise;

    expect(events.filter((e) => e === "approval_auto_approved")).toHaveLength(
      2,
    );
  });

  it("returns a deterministic non-interactive response for user input requests", async () => {
    const rpc = createFakeRpc(
      new Map([
        ["initialize", { serverInfo: { name: "codex", version: "1.0" } }],
        ["thread/start", { threadId: "t1" }],
        ["turn/start", { turnId: "u1" }],
      ]),
      [
        {
          method: "turn/completed",
          params: { turnId: "u1", stop: true },
        },
      ],
    );
    const events: string[] = [];

    const resultPromise = driveLifecycle({
      rpc,
      maxTurns: 1,
      prompt: "Fix",
      title: "Fix",
      cwd: "/tmp/ws",
      threadName: "test",
      sandboxType: "workspace-write",
      approvalPolicy: "never",
      turnSandboxPolicy: { type: "workspaceWrite" },
      turnTimeoutMs: 5000,
      tools: [],
      onEvent: (type) => events.push(type),
    });

    await Promise.resolve();
    await expect(
      rpc.requestHandler("item/tool/requestUserInput", { turnId: "u1" }),
    ).resolves.toMatchObject({
      success: false,
      contentItems: [
        {
          type: "inputText",
          text: expect.stringContaining("non-interactive IssuePilot run"),
        },
      ],
    });
    await expect(resultPromise).resolves.toMatchObject({
      status: "completed",
    });
    expect(events).toContain("turn_input_required");
  });
});
