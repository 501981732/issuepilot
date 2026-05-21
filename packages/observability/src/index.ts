export { redact } from "./redact.js";
export { createEventBus } from "./event-bus.js";
export type { EventBus, EventFilter, EventHandler } from "./event-bus.js";
export { createEventStore } from "./event-store.js";
export type { EventStore, EventRecord } from "./event-store.js";
export { createBatchedEventStore } from "./event-store-batching.js";
export type {
  BatchedEventStore,
  BatchedEventStoreOptions,
} from "./event-store-batching.js";
export { createRunStore } from "./run-store.js";
export type { RunStore } from "./run-store.js";
export { createLogger } from "./logger.js";
export type { LoggerOptions } from "./logger.js";

export const PACKAGE_NAME = "@issuepilot/observability";
export const VERSION = "0.0.0";
