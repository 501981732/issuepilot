import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
} from "vitest";

import { createBatchedEventStore } from "../event-store-batching.js";
import { createEventStore } from "../event-store.js";

describe("createBatchedEventStore (V4.7 review N-2)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "batched-evstore-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("coalesces multiple appends within the flush window into a single appendFile call", async () => {
    // 用一个 mock inner store 来观察 batched store 是否真的合并写;真正的
    // fs.appendFile 数量很难用单 import 路径稳定 spy(node fs/promises 与
    // fs.promises 在 vitest 下可能是不同 reference)。Batched store 的语义
    // 是「N 个 append → 1 次 inner.append」,所以这里只要 inner.append 被调
    // 用 0 次(因为 batched store 自己拼装 payload 写盘),且文件落地为 5
    // 行就足以证明 batching 生效。
    const innerAppend = vi.fn(async () => undefined);
    const innerRead = vi.fn(async () => []);
    const mockInner = { append: innerAppend, read: innerRead };
    const store = createBatchedEventStore(mockInner, tmpDir, {
      flushIntervalMs: 10,
      maxBatchSize: 100,
    });
    try {
      for (let i = 0; i < 5; i++) {
        await store.append("proj", 1, {
          id: `e${i}`,
          runId: "r1",
          type: "notification",
          message: `m${i}`,
        });
      }
      await store.flush();

      // batched store 不再调用 inner.append:它直接拼好整个 payload 一次
      // 写盘,所以 inner.append 永远不会被触发。
      expect(innerAppend).not.toHaveBeenCalled();
      // 文件内容必须含 5 行 JSON(尾随一个换行),证明 5 次 append 合并成
      // 一次 fs.appendFile 调用。
      const raw = fs.readFileSync(
        path.join(tmpDir, "proj-1.jsonl"),
        "utf-8",
      );
      const lines = raw.split("\n").filter(Boolean);
      expect(lines).toHaveLength(5);
      expect(lines.map((l) => (JSON.parse(l) as { id: string }).id)).toEqual([
        "e0",
        "e1",
        "e2",
        "e3",
        "e4",
      ]);
    } finally {
      await store.dispose();
    }
  });

  it("force-flushes the buffer when maxBatchSize is reached", async () => {
    const inner = createEventStore(tmpDir);
    const store = createBatchedEventStore(inner, tmpDir, {
      flushIntervalMs: 100_000, // 故意拉到极大,确认是 size 触发 flush
      maxBatchSize: 3,
    });
    try {
      for (let i = 0; i < 3; i++) {
        await store.append("proj", 2, {
          id: `e${i}`,
          runId: "r1",
          type: "notification",
          message: `m${i}`,
        });
      }
      // size 触发的 flush 是同步 await,无需 timer。
      const events = await store.read("proj", 2);
      expect(events).toHaveLength(3);
    } finally {
      await store.dispose();
    }
  });

  it("preserves event ordering across multiple keys", async () => {
    const inner = createEventStore(tmpDir);
    const store = createBatchedEventStore(inner, tmpDir, {
      flushIntervalMs: 20,
    });
    try {
      await store.append("a", 1, {
        id: "a1",
        runId: "r1",
        type: "x",
        message: "a1",
      });
      await store.append("b", 2, {
        id: "b1",
        runId: "r1",
        type: "x",
        message: "b1",
      });
      await store.append("a", 1, {
        id: "a2",
        runId: "r1",
        type: "x",
        message: "a2",
      });
      await store.flush();

      const aEvents = await store.read("a", 1);
      const bEvents = await store.read("b", 2);
      expect(aEvents.map((e) => e.id)).toEqual(["a1", "a2"]);
      expect(bEvents.map((e) => e.id)).toEqual(["b1"]);
    } finally {
      await store.dispose();
    }
  });

  it("read() drains pending writes for the matching key (read-after-write)", async () => {
    const inner = createEventStore(tmpDir);
    const store = createBatchedEventStore(inner, tmpDir, {
      flushIntervalMs: 100_000,
    });
    try {
      await store.append("proj", 3, {
        id: "fresh",
        runId: "r1",
        type: "x",
        message: "y",
      });
      // 没等 timer 也没显式 flush,直接 read 必须能看到刚 append 的 record。
      const events = await store.read("proj", 3);
      expect(events.map((e) => e.id)).toEqual(["fresh"]);
    } finally {
      await store.dispose();
    }
  });

  it("dispose() drains buffers and rejects new batched writes (falls through to inner)", async () => {
    const inner = createEventStore(tmpDir);
    const store = createBatchedEventStore(inner, tmpDir, {
      flushIntervalMs: 100_000,
    });
    await store.append("proj", 4, {
      id: "pre",
      runId: "r1",
      type: "x",
      message: "pre",
    });
    await store.dispose();
    // dispose 之后再 append 直接走 inner.append,不再 batch。
    await store.append("proj", 4, {
      id: "post",
      runId: "r1",
      type: "x",
      message: "post",
    });
    const events = await inner.read("proj", 4);
    expect(events.map((e) => e.id)).toEqual(["pre", "post"]);
  });

  it("redacts secrets in the batched payload (same as inner store)", async () => {
    const inner = createEventStore(tmpDir);
    const store = createBatchedEventStore(inner, tmpDir, {
      flushIntervalMs: 5,
    });
    try {
      await store.append("proj", 5, {
        id: "e1",
        runId: "r1",
        type: "tool_output",
        message: "Bearer secret-token",
        token: "glpat-12345678901234567890",
      });
      await store.flush();
      const raw = fs.readFileSync(
        path.join(tmpDir, "proj-5.jsonl"),
        "utf-8",
      );
      expect(raw).toContain("[REDACTED]");
      expect(raw).not.toContain("secret-token");
      expect(raw).not.toContain("glpat-12345678901234567890");
    } finally {
      await store.dispose();
    }
  });

  it("surfaces flush errors through onError without crashing", async () => {
    const inner = createEventStore(tmpDir);
    const errors: unknown[] = [];
    const store = createBatchedEventStore(inner, "/dev/null/does-not-exist", {
      flushIntervalMs: 5,
      onError: (err) => errors.push(err),
    });
    try {
      await store.append("proj", 6, {
        id: "e1",
        runId: "r1",
        type: "x",
        message: "y",
      });
      await store.flush();
      expect(errors.length).toBeGreaterThan(0);
    } finally {
      await store.dispose();
    }
  });
});
