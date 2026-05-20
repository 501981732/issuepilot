export const PACKAGE_NAME = "@issuepilot/workflow";
export const VERSION = "0.0.0";

export type {
  AgentConfig,
  CiConfig,
  CodexApprovalPolicy,
  CodexConfig,
  CodexThreadSandbox,
  CodexTurnSandboxPolicy,
  CodexTurnSandboxType,
  GitConfig,
  HooksConfig,
  IssuePromptInfo,
  PromptContext,
  TrackerConfig,
  WorkflowConfig,
  WorkflowSource,
  WorkspaceConfig,
} from "./types.js";

export {
  parseWorkflowFile,
  parseWorkflowString,
  WorkflowConfigError,
} from "./parse.js";

export {
  CentralWorkflowConfigError,
  compileCentralWorkflowProject,
  type CentralWorkflowDefaults,
  type CompileCentralWorkflowProjectInput,
} from "./central.js";

export {
  assertRunnerCapabilities,
  expandHomePath,
  expandWorkflowPaths,
  resolveRolePromptHashes,
  resolveTrackerSecret,
  resolveWorkflow,
  RoleProfileInvalidError,
  RunnerConfigInvalidError,
  validateWorkflowEnv,
  type EnvLike,
  type TrackerSecret,
} from "./resolve.js";

export {
  detectMissingVariables,
  renderPrompt,
  type PromptRenderLogger,
  type PromptRenderOptions,
} from "./render.js";

export {
  watchWorkflow,
  type WatchWorkflowOptions,
  type WorkflowWatcher,
} from "./watch.js";

export {
  createWorkflowLoader,
  type CreateWorkflowLoaderOptions,
  type StartWatcherOptions,
  type WorkflowLoader,
} from "./loader.js";
