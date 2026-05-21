# IssuePilot V4.7 Runner Adapter Contract 设计

日期：2026-05-20
状态：已落地，验收通过

关联文档：

- `docs/superpowers/specs/2026-05-17-issuepilot-v4-intelligent-workbench-design.md`
- `docs/superpowers/specs/2026-05-19-issuepilot-v4-6-multi-agent-collaboration-design.md`
- `docs/superpowers/plans/2026-05-19-issuepilot-v4-6-multi-agent-collaboration.md`
- `docs/superpowers/plans/2026-05-19-issuepilot-v4-6-multi-agent-collaboration-acceptance.md`
- `docs/superpowers/specs/2026-05-21-issuepilot-v4-8-second-runner-dogfood-design.md`

## 实施计划

- V4.7 Runner Adapter Contract：实施计划见
  `docs/superpowers/plans/2026-05-20-issuepilot-v4-7-runner-adapter-contract.md`。
- V4.7 验收清单见
  `docs/superpowers/plans/2026-05-20-issuepilot-v4-7-runner-adapter-contract-acceptance.md`。

## 1. 背景

V4.6 已经把一个 TaskNode 的执行拆成 Coder、Reviewer、Test/Evidence 三个
角色，并通过 `PipelineRun` 与 `AgentReport` 把角色产物持久化、展示和纳入
V4.4 Quality Analytics / V4.5 Improvement Loop。

V4.6 的真实实现仍然把所有角色绑定到同一个 Codex app-server lifecycle。
`apps/orchestrator/src/agents/codex-lifecycle.ts` 直接把 Codex `driveLifecycle`
结果翻译成 coder / reviewer outcome；daemon wiring 也需要了解 Codex command、
turn、tool schema、cancel 回调和 event 转发细节。

这对 V4.6 是合理的，因为当时重点是先验证多角色产品语义。但进入 V4.7 后，
IssuePilot 需要先把 runner 边界稳定下来，才能在后续版本接入 Claude Code、
内部 coder agent 或其他本地 runner，而不会把 Codex-specific 分支散进
PipelineCoordinator、AgentReport、dashboard 和 quality/improvement 模块。

V4.7 的目标不是接入第二个真实 runner，而是抽出 **Runner Adapter Contract**：
现有 Codex app-server 成为第一个 adapter，所有三角色 pipeline 都通过本地
静态 runner registry 选择 adapter，再由 orchestrator 把标准化 `RunnerResult`
转换成现有 `AgentReport`。

## 2. 目标

V4.7 需要回答：

1. runner adapter 的稳定输入、输出、事件、错误和 capability 声明是什么？
2. workflow YAML 如何声明本地静态 `runners:` registry，并让 `roles.<role>`
   引用某个 runner？
3. 如何把现有 Codex lifecycle 迁移成 `codex_app_server` adapter，而不改写
   V4.6 的 PipelineCoordinator 状态机？
4. runner 层错误如何映射到 `AgentReport.lastError`，并继续被 V4.4 / V4.5
   消费？
5. 如何让 `AgentReport` 能追溯 runner，同时避免 runner adapter 直接写
   IssuePilot 业务报告？

## 3. 非目标

V4.7 不做：

- 不接入 Claude Code、Cursor agent、内部 coder agent 或其他第二 runner。
- 不做动态 runner discovery、插件市场、远程 manifest 探测或 runner SDK 发布。
- 不做多 worker 调度、worker pool、远程 runner 服务、队列调度或生产 sandbox。
- 不做并发 fan-out。V4.6 的 Coder → Reviewer → Test/Evidence 顺序 pipeline
  保持不变。
- 不让 runner adapter 直接生成或写入 `AgentReport`。
- 不做旧 workflow / 旧 AgentReport 的长期兼容层。当前仍是开发阶段，V4.7
  可以一次性切换 fixture 和内部 shape。
- 不把 token、secret、OAuth credential 或环境变量值写入 workflow YAML、
  runner options、event、artifact 或 report。

## 4. 设计选项

### 方案 A：内置 registry only（不采用）

只在代码里注册 `codex_app_server`，workflow YAML 只能引用内置 runner id。

优点是实现最小；缺点是本地静态配置层缺失，V4.8 接第二 runner 时还要重新
设计 `runners:` 配置。

### 方案 B：本地静态 registry + Codex adapter 迁移（采用）

在 workflow YAML 中支持 `runners:` registry 与 `roles.<role>.runner` 引用。
`packages/shared-contracts` 定义 runner contract；`packages/workflow` 解析和
校验 registry；`apps/orchestrator` 注册内置 `codex_app_server` adapter，并把
现有 Codex lifecycle 迁移到标准 `RunnerResult`。

优点：

- 把 V4.6 的 Codex-specific lifecycle 边界收束到一个 adapter。
- 后续接第二 runner 时只需要新增 adapter 与 registry entry。
- 仍然保持本地单机，不提前进入 V3 worker 平台化。

缺点：

- 需要扩展 shared contracts、workflow parser/resolve、orchestrator wiring
  和一批 V4.6 fixture。

### 方案 C：动态 runner discovery（不采用）

runner 自己暴露 manifest / capabilities，IssuePilot 启动时探测并协商能力。

优点是长期平台能力更强；缺点是 V4.7 过重，容易滑向 V3 生产 worker / SDK
方向。当前没有第二 runner dog-food，不应先做动态发现协议。

## 5. 产品边界

V4.7 的核心对象是 `RunnerDescriptor` 和 `RunnerResult`。它们描述"某个本地
runner 能做什么、一次 role run 的标准结果是什么"，但不描述 IssuePilot 的
最终业务报告。

边界原则：

- runner adapter 接收 role run input，返回 `RunnerResult`。
- orchestrator 的 agent factory 继续负责生成 role-specific `AgentReport`。
- PipelineCoordinator 仍只调用 `CoderAgentRunner` / `ReviewerAgentRunner` /
  `TestEvidenceAgentRunner`，不认识具体 runner kind。
- `AgentReport` 可新增 runner 追溯字段，但不把 runner 原始日志和 secret-adjacent
  数据持久化。
- capability 是静态声明，不做运行期 negotiation。

V4.7 的 hard gate：

- 所有三角色 pipeline 都必须通过 runner registry 选择 adapter。
- daemon 不再直接拼接 Codex lifecycle runner。
- 未注册 runner 或 capability 不满足时 fail closed，且 dashboard / report
  可见。
- `scripts/ci-equivalent-check.sh` 必须通过。

## 6. 架构

V4.7 在 V4.6 Agent Orchestrator 下新增 runner adapter 层：

```text
WorkflowConfig
  ├─ runners: RunnerDescriptor[]
  └─ roles.<role>.runner
        ↓ resolve / validate
RunnerRegistry
  └─ codex_app_server adapter
        ↓ returns RunnerResult
Agent factory
  ├─ createCoderAgent        -> CoderAgentReport
  ├─ createReviewerAgent     -> ReviewerAgentReport
  └─ createTestEvidenceAgent -> TestEvidenceAgentReport
        ↓
PipelineCoordinator / PipelineStore / AgentReport store
```

### 6.1 Contract 层

`packages/shared-contracts/src/runner.ts` 新增 runner contract，并从
`packages/shared-contracts/src/index.ts` 导出。

这层只定义数据 shape 和 type guards，不 import orchestrator、workflow loader、
GitLab client、Codex lifecycle 或 filesystem store。

### 6.2 Workflow 配置层

`packages/workflow` 解析本地静态 `runners:` registry 和 `roles.<role>.runner`
引用。开发期允许默认 `codex_app_server`，但不做旧配置迁移承诺。

### 6.3 Orchestrator adapter 层

`apps/orchestrator` 新增 runner registry / resolver。现有
`codex-lifecycle.ts` 迁移为 `codex_app_server` adapter，输出标准
`RunnerResult`。agent factory 使用该结果继续生成 `AgentReport`。

## 7. Shared Contract

建议新增：

```ts
type RunnerKind = "codex_app_server";

type RunnerCapability =
  | "roles.coder"
  | "roles.reviewer"
  | "roles.test_evidence"
  | "events.streaming"
  | "cancel"
  | "artifacts"
  | "gitlab.tools"
  | "filesystem.readonly"
  | "filesystem.worktree_write";

interface CodexAppServerRunnerOptions {
  command?: string;
  maxTurns?: number;
  turnTimeoutMs?: number;
  approvalPolicy?: "never";
  threadSandbox?: "workspace-write";
}

interface RunnerDescriptor {
  runnerId: string;
  kind: RunnerKind;
  displayName?: string;
  capabilities: RunnerCapability[];
  defaultTimeoutSeconds?: number;
  options?: CodexAppServerRunnerOptions;
}

interface RunnerRunInput {
  runnerId: string;
  role: AgentRole;
  prompt: string;
  cwd: string;
  workItemId: string;
  taskId: string;
  pipelineRunId: string;
  roleProfileId: string;
  timeoutSeconds?: number;
  toolAllow: WorkflowToolGrant[];
  sandbox: WorkflowSandbox;
  metadata: Record<string, string | number | boolean>;
}

interface RunnerArtifact {
  kind: "text" | "diff" | "evidence" | "log" | "tool_result";
  path?: string;
  mimeType?: string;
  summary?: string;
}

interface RunnerError {
  code: RunnerErrorCode;
  message: string;
  hint?: string;
}

type RunnerEventType =
  | "runner_started"
  | "turn_started"
  | "tool_call_started"
  | "tool_call_completed"
  | "runner_message"
  | "runner_completed"
  | "runner_failed"
  | "runner_cancelled";

interface RunnerEvent {
  type: RunnerEventType;
  at: string;
  runnerId: string;
  runnerRunId?: string;
  pipelineRunId: string;
  workItemId: string;
  taskId: string;
  role: AgentRole;
  message?: string;
  data?: Record<string, string | number | boolean | null>;
  redactedFields: string[];
}

type RunnerResult =
  | {
      status: "completed";
      finalMessage?: string;
      runId?: string;
      artifacts?: RunnerArtifact[];
    }
  | {
      status: "failed";
      error: RunnerError;
      runId?: string;
      artifacts?: RunnerArtifact[];
    }
  | {
      status: "cancelled";
      cancelledAt: string;
      runId?: string;
    }
  | {
      status: "timeout";
      error: RunnerError;
      runId?: string;
    };
```

第一版 `RunnerErrorCode`：

- `runner_unavailable`
- `runner_timeout`
- `sandbox_violation`
- `capability_missing`
- `tool_denied`
- `output_unparseable`
- `artifact_collection_failed`

`local_command`、Claude Code、内部 runner 等只出现在未来工作说明中，不进入
V4.7 的 `RunnerKind` union。V4.7 的 workflow resolver 遇到任何非
`codex_app_server` kind 都必须 fail closed。

### 7.1 `codex_app_server` options allowlist

`runners.codex_app_server.options` 必须走 adapter-specific schema，不能保留
任意 `Record<string, unknown>` 直通到 runtime。

允许字段：

| 字段 | 说明 |
| --- | --- |
| `command` | Codex app-server 启动命令；只用于 spawn app-server，不改变 task cwd。 |
| `maxTurns` | 单次 role run 的 turn 上限。 |
| `turnTimeoutMs` | 单 turn 超时。 |
| `approvalPolicy` | V4.7 只允许 `never`。 |
| `threadSandbox` | V4.7 只允许 `workspace-write`，实际写权限仍由 role sandbox 限制。 |

禁止字段：

- `cwd`、`workspaceRoot`、`repoRoot`：runner cwd 只能由 IssuePilot issue
  worktree 解析得到。
- `env` / `token` / `secret` / `credential`：不允许在 runner options 持久化
  secret 值。
- 任意提升 sandbox、approval policy 或绕过 `toolAllow` 的字段。
- unknown fields。workflow loader / resolver 必须拒绝 unknown options。

### 7.2 Runner event contract

adapter 可以通过 orchestrator 提供的 event sink emit `RunnerEvent`，但不能把
runner raw payload 直接写入 event store。所有 event 必须满足：

- 必须带 `runnerId`、`pipelineRunId`、`workItemId`、`taskId` 和 `role`。
- `runnerRunId` 已知时必须填写；未知时可省略，后续 event 不能反向修改旧 event。
- `data` 只能是 primitive record，不能包含完整 prompt、token、raw tool input、
  raw stdout/stderr 或未 redaction 的第三方响应。
- `redactedFields` 记录 redaction 发生过的字段路径。
- dashboard / observability 只能消费 `RunnerEvent` 或现有 `IssuePilotEvent`
  的 sanitized 字段，不允许依赖 Codex raw notification shape。

## 8. Workflow YAML

V4.7 支持本地静态 runner registry：

```yaml
runners:
  codex_app_server:
    kind: codex_app_server
    display_name: Codex App Server
    capabilities:
      - roles.coder
      - roles.reviewer
      - roles.test_evidence
      - events.streaming
      - cancel
      - artifacts
      - gitlab.tools
      - filesystem.worktree_write
    timeout_seconds: 1800
    options:
      command: codex app-server
      max_turns: 20
      approval_policy: never
      thread_sandbox: workspace-write

roles:
  coder:
    runner: codex_app_server
    prompt_template: .agents/prompts/coder.md
    sandbox: read_write_worktree
    tools:
      - name: gitlab.create_mr
      - name: gitlab.update_mr
      - name: run.command
        allow: ["pnpm test", "git diff --stat"]

  reviewer:
    runner: codex_app_server
    prompt_template: .agents/prompts/reviewer.md
    sandbox: read_only_worktree
    publish_to_mr: true
```

Rules:

- `roles.<role>.runner` 未写时，开发期默认 `codex_app_server`。
- `runners:` 未写时，loader 注入内置 `codex_app_server` descriptor。
- 写了未知 runner id，resolve 阶段 fail closed。
- runner capabilities 不满足 role / sandbox / tools 要求，resolve 阶段报
  `capability_missing`。
- `options` 必须按 `CodexAppServerRunnerOptions` allowlist 校验；YAML 使用
  snake_case，loader 映射成 TS camelCase，unknown fields fail closed。
- `options.env` 不属于 V4.7，不能写 env var 名称或值。

### 8.1 V4.7 workflow shape cutover

V4.7 起，V4 pipeline 的 runner 配置以 `runners:` 和 `roles.<role>.runner`
为准。根 spec 里早期 P0 / V1 的 `agent.runner` 与 `codex:` 示例仍可作为
非 V4 single-run runtime 的历史配置参考，但不能作为 V4.7 role pipeline 的
runner source of truth。

Cutover 规则：

- V4.7 role pipeline 不读取 `agent.runner` 来选择 runner。
- V4.7 role pipeline 不从 `codex:` 直接读取 per-role options；需要进入
  `runners.codex_app_server.options`。
- 如果同一个 workflow 同时声明 V4.7 `runners:` 和旧式 per-role runner 覆盖
  字段，resolver 必须 fail closed。
- 这不是兼容层：现有开发 fixture 直接升级到 V4.7 shape。

## 9. Orchestrator 迁移

### 9.1 新增 RunnerRegistry

orchestrator 启动时：

1. 从 resolved workflow 读取 `runners`。
2. 注册内置 `codex_app_server` adapter。
3. 校验 `roles.<role>.runner` 指向的 descriptor 存在。
4. 校验 capability 是否覆盖 role、sandbox、tools、cancel、artifact 需求。
5. 构造 agent factory 时注入 registry / resolver。

### 9.2 改造 Codex lifecycle

`apps/orchestrator/src/agents/codex-lifecycle.ts` 从 coder/reviewer outcome
翻译器改成 `CodexAppServerRunnerAdapter`：

```ts
interface RunnerAdapter {
  descriptor: RunnerDescriptor;
  run(input: RunnerRunInput): Promise<RunnerResult>;
}
```

Codex adapter 负责：

- 调用 `spawnRpc` / `driveLifecycle`。
- 把 Codex notification 映射为 sanitized `RunnerEvent`，再交给 orchestrator
  event sink；不持久化 Codex raw payload。
- 把 `lastTurnId` 映射到 `RunnerResult.runId`。
- 把 `finalMessage` 映射到 `RunnerResult.finalMessage`。
- 把 timeout / failed 映射到 runner 层错误。
- 把 cancelled 映射为 `RunnerResult.status = "cancelled"`，不额外构造
  `RunnerError`。
- Codex `blocked` 不作为业务 blocked 状态暴露：adapter 必须按具体原因映射为
  `tool_denied`、`sandbox_violation` 或 `runner_unavailable`。
- 在 `finally` 中关闭 RPC。

### 9.3 保留 AgentReport 生成层

agent factory 继续负责业务语义：

- `createCoderAgent` 从 `RunnerResult.completed.finalMessage`、git summary、
  GitLab MR tool result 生成 `CoderAgentReport`。
- `createReviewerAgent` 从 `RunnerResult.finalMessage` 走现有 reviewer JSON
  parser、finding validator 和 MR publish 逻辑。
- `createTestEvidenceAgent` 继续使用 evidence collector；runner artifact
  只作为可选补充。

### 9.4 AgentReport 追溯字段

`AgentReportBase` 新增：

```ts
runnerId: string;
runnerKind: RunnerKind;
runnerRunId?: string | null;
```

这些字段用于 dashboard、debug 和 audit。V4.7 不为旧 report 做 lazy migration；
测试 fixture 直接升级。

## 10. Error Handling

V4.7 错误分两层：

### 10.1 Runner 层错误

runner adapter 只描述执行器失败原因：

- runner 不可用：`runner_unavailable`
- 超时：`runner_timeout`
- sandbox 拒绝：`sandbox_violation`
- capability 不满足：`capability_missing`
- tool 被拒绝：`tool_denied`
- 输出无法解析：`output_unparseable`
- artifact 收集失败：`artifact_collection_failed`

### 10.2 AgentReport 层错误

agent factory 把 `RunnerError` 映射到现有 `LastErrorCode`：

| RunnerErrorCode | LastErrorCode |
| --- | --- |
| `runner_unavailable` | `runner_unavailable` |
| `runner_timeout` | `runner_unavailable` |
| `sandbox_violation` | `sandbox_violation` |
| `capability_missing` | `runner_unavailable` |
| `tool_denied` | `runner_unavailable` |
| `output_unparseable` | `parse_failed` |
| `artifact_collection_failed` | `evidence_unavailable` |

`RunnerResult.status = "cancelled"` 不携带 `RunnerError`；agent factory 直接把它
映射为 `AgentReport.status = "cancelled"`，并在需要写 `lastError` 或 task
reason 时使用 `pipeline_cancelled`。

runner adapter 不产生业务 blocked 状态。需要 `ai-blocked` / `blocked`
语义时，由 orchestrator 或 agent factory 基于 `LastErrorCode`、workflow
policy 和 GitLab 状态机决定。

Reviewer JSON 不合法仍由 reviewer agent 映射为 `parse_failed`。runner adapter
不决定 reviewer decision，也不写 `reviewer_requested_changes`。

## 11. Security / Redaction

- `RunnerRunInput` 不包含 token 原文。
- GitLab token 继续由 `tracker.token_env` 或 OAuth credential resolver 在运行时加载。
- `runners.*.options` 只能使用 adapter-specific allowlist，不允许持久化 secret
  值、cwd、env、token、credential、sandbox escalation 或 unknown fields。
- event / artifact summary 进入 store 前必须 redaction。
- runner adapter 不直接写 workflow、`AGENTS.md`、project rules 或 skill 文件。
- capability missing 必须 fail closed，不允许 fallback 到更宽权限 runner。

## 12. Dashboard / Observability

V4.7 dashboard 不新增大页面，只做追溯信息展示：

- WorkItem task detail / AgentReport tab 展示 `runnerId`、`runnerKind` 和
  `runnerRunId`。
- runner capability 校验失败时，展示与现有 `agent_not_configured` / 503
  类似的可读错误。
- `/reports` 不改聚合模型，继续消费 `AgentReport.lastError` 和 V4.6 byRole
  字段。

## 13. 测试策略

### 13.1 Shared contracts

- `RunnerDescriptor` / `RunnerResult` / `RunnerError` type guard。
- JSON round-trip 保留 optional 字段。
- capability 列表只接受枚举值。
- `RunnerEvent` 只接受 sanitized primitive `data`，并要求 correlation fields。
- `RunnerKind` 只接受 `codex_app_server`；`local_command` 在 V4.7 必须被拒绝。

### 13.2 Workflow

- `runners:` parse / resolve。
- `roles.<role>.runner` 引用解析。
- unknown runner id fail closed。
- capability missing 报结构化错误。
- `codex_app_server.options` unknown / forbidden fields fail closed。
- mixed `agent.runner` / `codex:` V4.7 role-pipeline shape fail-closed 测试。
- 未写 `runners:` / `roles.<role>.runner` 时注入开发期默认
  `codex_app_server`。

### 13.3 Orchestrator

- Codex adapter 把 completed / failed / timeout / cancelled 映射为
  `RunnerResult`。
- Codex adapter 把 streaming notification 映射为 sanitized `RunnerEvent`。
- Codex `blocked` 不泄漏为 raw status，而是映射到明确 runner error code。
- agent factory 把 `RunnerResult` 映射为 Coder / Reviewer / TestEvidence
  `AgentReport`。
- capability missing 不启动 runner，直接生成 failed report。
- daemon / team daemon 不再直接构造 Codex lifecycle runner。

### 13.4 E2E / Gate

- 默认 `codex_app_server` runner 跑通 V4.6 等价 `full_pipeline`。
- `AgentReport` 记录 runner 追溯字段。
- `scripts/ci-equivalent-check.sh` 通过。

## 14. 验收标准

V4.7 至少满足：

1. `packages/shared-contracts` 导出 runner contract，并有 round-trip / guard
   测试。
2. workflow 支持 `runners:` registry 与 `roles.<role>.runner`。
3. 未注册 runner / unsupported kind / capability missing 在 resolve 或 run 前
   fail closed。
4. Codex app-server 通过 `RunnerAdapter` 执行，不再由 daemon 直接拼 Codex
   lifecycle runner。
5. `codex_app_server.options` 使用 allowlist schema，unknown / secret-like /
   sandbox-escalation 字段被拒绝。
6. Codex raw event 不进入 store；adapter 只能 emit sanitized `RunnerEvent`。
7. Coder / Reviewer / TestEvidence 三角色仍能生成原有 role-specific
   `AgentReport`。
8. `AgentReport` 包含 `runnerId`、`runnerKind`、`runnerRunId?`。
9. V4.4 Quality Analytics、V4.5 Improvement Loop、V4.6 dashboard pipeline
   不需要理解 runner-specific 原始输出。
10. `scripts/ci-equivalent-check.sh` 通过。

## 15. 与 V4.6 / V3 的关系

V4.7 是 V4.6 的 runner boundary 收口，不是 V3 worker 平台的提前实现。

- V4.6 负责多角色 pipeline 与 `AgentReport` 产品语义。
- V4.7 负责本地 runner adapter contract 与静态 registry。
- V3 仍负责多 worker、生产 sandbox、权限、集中存储、队列调度和生产治理。

后续版本可以在 V4.7 contract 上接第二 runner，但必须先通过真实 adapter dog-food
验证 contract，而不是先扩动态 discovery 或 worker pool。
