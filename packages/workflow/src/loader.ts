import path from "node:path";

import { parseWorkflowFile } from "./parse.js";
import {
  renderPrompt,
  type PromptRenderLogger,
  type PromptRenderOptions,
} from "./render.js";
import {
  resolveWorkflow,
  validateWorkflowEnv,
  type EnvLike,
} from "./resolve.js";
import type { PromptContext, WorkflowConfig } from "./types.js";
import {
  watchWorkflow,
  type WatchWorkflowOptions,
  type WorkflowWatcher,
} from "./watch.js";

export type StartWatcherOptions = Omit<
  WatchWorkflowOptions,
  "onReload" | "onError" | "loadWorkflow"
> &
  Partial<Pick<WatchWorkflowOptions, "onReload" | "onError">>;

export interface WorkflowLoader {
  /** Load a workflow file once without setting up any watcher. */
  loadOnce(filePath: string): Promise<WorkflowConfig>;
  /**
   * Start watching `filePath` for hot reload. Default `onReload` / `onError`
   * are no-ops so callers only have to wire them when they care.
   */
  start(
    filePath: string,
    options?: StartWatcherOptions,
  ): Promise<WorkflowWatcher>;
  /**
   * Render a prompt template against a {@link PromptContext}. If `options`
   * does not provide a logger, the loader's default logger (passed to
   * {@link createWorkflowLoader}) is used.
   */
  render(
    template: string,
    context: PromptContext,
    options?: PromptRenderOptions,
  ): Promise<string>;
}

export interface CreateWorkflowLoaderOptions {
  /** Default logger applied to `render` when caller omits one. */
  logger?: PromptRenderLogger;
  /** Environment used for tracker token validation. Defaults to process.env. */
  env?: EnvLike;
}

/**
 * Bundle the parse/render/watch primitives behind a single facade that the
 * orchestrator can depend on without learning about three modules. The
 * facade is stateless aside from the logger preference; multiple watchers
 * are independent.
 */
export function createWorkflowLoader(
  factoryOptions: CreateWorkflowLoaderOptions = {},
): WorkflowLoader {
  const defaultLogger = factoryOptions.logger;
  const env = factoryOptions.env ?? process.env;
  const loadWorkflow = async (filePath: string): Promise<WorkflowConfig> => {
    const parsed = await parseWorkflowFile(filePath);
    const resolved = await resolveWorkflow(parsed, path.dirname(path.resolve(filePath)));
    validateWorkflowEnv(resolved, env);
    return resolved;
  };

  return {
    loadOnce(filePath: string): Promise<WorkflowConfig> {
      return loadWorkflow(filePath);
    },
    start(
      filePath: string,
      options: StartWatcherOptions = {},
    ): Promise<WorkflowWatcher> {
      const onReload = options.onReload ?? (() => undefined);
      const onError = options.onError ?? (() => undefined);
      const resolved: WatchWorkflowOptions = {
        onReload,
        onError,
        loadWorkflow,
        ...(options.debounceMs !== undefined
          ? { debounceMs: options.debounceMs }
          : {}),
      };
      return watchWorkflow(filePath, resolved);
    },
    async render(
      template: string,
      context: PromptContext,
      options: PromptRenderOptions = {},
    ): Promise<string> {
      const logger = options.logger ?? defaultLogger;
      const renderOptions: PromptRenderOptions = logger
        ? { ...options, logger }
        : options;
      return renderPrompt(template, context, renderOptions);
    },
  };
}
