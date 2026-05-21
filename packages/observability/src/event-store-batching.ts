/**
 * V4.7 review N-2 — batched event store wrapper.
 *
 * Why this exists:
 *   `EventStore.append` is fire-and-forget at every caller (orchestrator
 *   `publishEvent`, runner `RunnerEventSink.emit` → publishLifecycleEvent),
 *   and the underlying `createEventStore` implementation does one
 *   `fs.mkdir({ recursive: true })` + one `fs.appendFile(...)` syscall per
 *   record. Once V4.7 B1 fixed the dead `RunnerEvent` stream, a single
 *   Codex multi-turn run can fan out hundreds of `notification` /
 *   `tool_call_*` events in a few seconds → the orchestrator's event jsonl
 *   files get hammered with one syscall per event.
 *
 * What this does:
 *   Wrap an `EventStore` with an in-memory buffer keyed by
 *   `<projectSlug>|<issueIid>`. New events are pushed into the buffer; a
 *   per-key timer (default 250ms) coalesces them into a single
 *   `fs.appendFile` call containing newline-joined JSON records. When a
 *   buffer hits `maxBatchSize` (default 50) the flush triggers immediately
 *   to bound memory.
 *
 * Read-after-write semantics:
 *   `read(slug, iid)` first flushes the matching buffer before delegating
 *   to the inner store, so tests and dashboard API handlers that do
 *   `append(...); read(...)` in the same task continue to see the latest
 *   record.
 *
 * Shutdown:
 *   `flush()` drains all buffers (awaitable); `dispose()` flushes then
 *   clears timers (call this on daemon stop to avoid leaking pending
 *   timeouts at process exit).
 *
 * Failure handling:
 *   `appendFile` errors are surfaced through the optional `onError`
 *   callback (defaults to `console.warn`). We do NOT re-throw inside the
 *   timer callback because that would crash the daemon's libuv loop;
 *   callers that need durability can wrap a separate logger.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { EventRecord, EventStore } from "./event-store.js";
import { redact } from "./redact.js";

export interface BatchedEventStoreOptions {
  /**
   * Time window after the first buffered event before a flush triggers (ms).
   * Default 250ms — short enough that the dashboard SSE feels live, long
   * enough that a Codex tool-call burst gets coalesced.
   */
  flushIntervalMs?: number;
  /**
   * Max events buffered per (slug, iid) before forced flush. Default 50.
   * Bounds memory under streaming bursts.
   */
  maxBatchSize?: number;
  /** Logger for flush errors. Default `console.warn` with `[event-store]` prefix. */
  onError?: (err: unknown) => void;
}

export interface BatchedEventStore extends EventStore {
  /** Drain all pending writes immediately. Awaitable. */
  flush(): Promise<void>;
  /** Stop accepting new writes; flushes then clears timers. */
  dispose(): Promise<void>;
}

const DEFAULT_FLUSH_INTERVAL_MS = 250;
const DEFAULT_MAX_BATCH_SIZE = 50;

interface BufferEntry {
  events: EventRecord[];
  timer: NodeJS.Timeout | undefined;
}

export function createBatchedEventStore(
  inner: EventStore,
  storeDir: string,
  opts: BatchedEventStoreOptions = {},
): BatchedEventStore {
  const flushIntervalMs = opts.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
  const maxBatchSize = opts.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE;
  const onError =
    opts.onError ??
    ((err: unknown) =>
      console.warn(
        `[event-store] flush failed: ${err instanceof Error ? err.message : String(err)}`,
      ));

  const buffers = new Map<string, BufferEntry>();
  // 关闭后拒绝新的 append:测试 / shutdown 路径要保证不会留 timer。
  let disposed = false;

  function bufferKey(slug: string, iid: number): string {
    return `${slug}|${iid}`;
  }

  function parseKey(key: string): { slug: string; iid: number } {
    const sep = key.lastIndexOf("|");
    return {
      slug: key.slice(0, sep),
      iid: Number(key.slice(sep + 1)),
    };
  }

  function filePath(slug: string, iid: number): string {
    return path.join(storeDir, `${slug}-${iid}.jsonl`);
  }

  async function flushKey(key: string): Promise<void> {
    const entry = buffers.get(key);
    if (!entry || entry.events.length === 0) return;
    // 先 delete 再 IO,避免 IO 期间新 append 串到旧 buffer(顺序由 IO
    // await 边界保证)。
    buffers.delete(key);
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = undefined;
    }
    const { slug, iid } = parseKey(key);
    const fp = filePath(slug, iid);
    try {
      await fs.mkdir(path.dirname(fp), { recursive: true });
      const payload =
        entry.events.map((e) => JSON.stringify(redact(e))).join("\n") + "\n";
      await fs.appendFile(fp, payload, "utf-8");
    } catch (err) {
      onError(err);
    }
  }

  function scheduleFlush(key: string, entry: BufferEntry): void {
    if (entry.timer) return;
    entry.timer = setTimeout(() => {
      void flushKey(key);
    }, flushIntervalMs);
    // 不持有 event loop:daemon 退出时 batched store 不需要阻止进程结束,
    // 真正的 drain 走 dispose() 显式调用。
    if (typeof entry.timer.unref === "function") {
      entry.timer.unref();
    }
  }

  return {
    async append(slug, iid, event) {
      if (disposed) {
        // 关闭后兜底走 inner,保证不丢事件(顺序在此分支下不再保证,
        // 但只在 dispose 之后才走这条,通常是测试 cleanup 场景)。
        await inner.append(slug, iid, event);
        return;
      }
      const key = bufferKey(slug, iid);
      let entry = buffers.get(key);
      if (!entry) {
        entry = { events: [], timer: undefined };
        buffers.set(key, entry);
      }
      entry.events.push(event);
      if (entry.events.length >= maxBatchSize) {
        // 大批量到了立刻 flush,不再等 timer。
        await flushKey(key);
        return;
      }
      scheduleFlush(key, entry);
    },

    async read(slug, iid, options) {
      // 读前先 drain 匹配 key,保证 read-after-write 语义。
      await flushKey(bufferKey(slug, iid));
      return inner.read(slug, iid, options);
    },

    async flush(): Promise<void> {
      const keys = [...buffers.keys()];
      await Promise.all(keys.map((key) => flushKey(key)));
    },

    async dispose(): Promise<void> {
      disposed = true;
      const keys = [...buffers.keys()];
      await Promise.all(keys.map((key) => flushKey(key)));
    },
  };
}
