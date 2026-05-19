# IssuePilot V4.6 Multi-Agent / Multi-Runner Collaboration 设计

日期：2026-05-19
状态：待 spec review

关联文档：

- `docs/superpowers/specs/2026-05-17-issuepilot-v4-intelligent-workbench-design.md`
- `docs/superpowers/specs/2026-05-18-issuepilot-v4-4-quality-analytics-design.md`
- `docs/superpowers/specs/2026-05-18-issuepilot-v4-5-improvement-loop-design.md`
- `docs/superpowers/plans/2026-05-17-issuepilot-v4-3-review-packet-evidence.md`
- `README.md`

## 实施计划

V4.6 实施计划尚未拆出，本 spec 作为 V4 阶段的最后一阶段总览。计划文档预计放在
`docs/superpowers/plans/2026-05-19-issuepilot-v4-6-multi-agent.md`，在 spec
review 通过后再拆。

## 1. 背景

V4.1–V4.3 已经把单 Issue → 多 task 拆解 → Parent Review Packet 跑通；V4.4 在
`/reports` 上汇总质量趋势；V4.5 把质量事实推进成可审计的 improvement
recommendation。截至 V4.5，IssuePilot 的「执行端」仍然是单一 coding agent
（`@issuepilot/runner-codex-app-server`）跑完 coding pass 后直接进入
`human-review`，所有「reviewer 视角的验证、risk、回归测试证据」都靠 coding
agent 自我汇报，dashboard 难以判断 coding 自检漏掉了什么、reviewer 需要重做
什么。

V4.6 的目标是把 IssuePilot 从「单 coding agent 单跑」升级为「多 agent 角色
协作」：在同一 task run 里，先跑 coding pass，再让 reviewer agent 做只读
视角的独立审查，再让 test/evidence agent 补齐验证证据，所有 agent 产物进入
统一的 RunReport / WorkItemReport / Review Packet，operator 依然是最终
gate。

V4.6 同时要给「非 Codex 的 runner」（例如 Claude Code、Cursor agent、内部
coding runner）留好接口边界，但 **不在 V4.6 实现** 任何非 Codex runner，只
落地 `RunnerAdapter` 契约和 codex-app-server 适配层重构。

## 2. 目标

V4.6 需要回答：

1. 一个 task run 里允许哪些 agent 角色？每个角色读什么、写什么、跑多久？
2. 多个 agent 角色的产物如何统一进入 RunReportArtifact / WorkItemReport /
   Review Packet / Evidence，而不复制或绕开 V4.3 evidence 模型？
3. 切换 / 替换 runner（Codex / Claude / 内部）的最小契约是什么？workflow
   YAML 怎么配置？
4. 多角色 pass 失败时如何不污染 coding 成果，operator 可以怎么重试 / 跳过 /
   降级？
5. 多 agent 协作如何保留 V4 总 spec 的 local-first / 单 daemon / 人是最终
   gate 约束，不提前进入生产 worker 平台。

## 3. 非目标

V4.6 不做：

- **生产 worker 平台 / cross-machine 并行**。仍是单 daemon、单本地 host；扩
  worker / 调度留给 V3。
- **同一 task 多个 coding agent 竞速**。第一版只允许 1 个 coding agent +
  最多 1 个 reviewer agent + 最多 1 个 test-evidence agent；多 coding agent
  PK / consensus 不在范围。
- **跨 task 的 agent dependency 图**。多 agent 协作的依赖图仍由 V4.2 Task
  Graph 在 task 粒度负责，agent 粒度不引入新的依赖语义。
- **agent role 的运行时动态发现**。所有 agent role 在 workflow YAML 静态
  声明；第一版固定 `coding` / `reviewer` / `test_evidence` 三种 role，不开
  放任意 role 名注入。
- **runner 沙箱级别协议**。runner 仍复用现有 `codex.threadSandbox` /
  `turnSandboxPolicy`；本 spec 不重写沙箱契约。
- **agent 通信总线 / 多 agent 消息协议**。reviewer 和 coding 不直接对话，
  只通过 RunReportArtifact / AgentPass 记录交互。
- **agent 自动应用 V4.5 improvement recommendation**。recommendation
  apply 仍然由 operator 手动 gate，V4.6 不打通 patch apply path。
- **替代 V4.3 evidence 模型**。reviewer / test agent 产出的证据走同一份
  evidence index，不另起 store。
- **GitLab Merge Train / auto-merge**。reviewer agent pass 通过不会触发自动
  merge；label 状态机仍由现有 reconcile 路径控制。

## 4. 设计选项

### 方案 A：Per-role 各自一个 run（独立 runId / 独立 branch）

每个 agent role 都开一个新 RunRecord，挂在同一 TaskNode 下。

优点：

- 与现有 RunReport / slot 模型对齐天然，可分别 cancel / retry。

缺点：

- reviewer / test pass 不需要新 branch；新 branch 会浪费 mirror / worktree，
  操作面也复杂（每个 task 出现 N 个 RunRecord）。
- evidence / Review Packet 渲染需要重新做 cross-run 聚合。
- 与今天单 coding run 的 mental model 偏离过大。

### 方案 B：单一 run，pass 内串行多个 agent role（采用）

每个 TaskNode 仍触发一个 task run；同一 run 内顺序跑：

1. coding pass（强制）。
2. reviewer pass（可选，只读）。
3. test_evidence pass（可选，可执行测试命令）。

每个 pass 记录为 `AgentPass`，挂在已有 `TaskRunLink` 上，
RunReportArtifact 同步增加 per-role breakdown。Worktree、mirror、branch、
MR 仍归 coding pass 所有，reviewer / test 在同一 worktree 上以读为主。

优点：

- 不破坏现有 slot / mirror / worktree / MR 模型。
- evidence / Review Packet 改造最小：reviewer / test 输出只往现有 evidence
  index 追加。
- operator UI 仅在 task 卡片上加 role 标记，不引入新一级实体。
- 失败隔离明确：coding pass 通过后才可能进入 reviewer / test，单独 pass
  失败不必把整个 task run 拉回失败。

缺点：

- 第一版无法把 reviewer / test 并行；但 V4.6 显式不追求并行。
- coding agent 已经把 worktree 改脏的情况下，reviewer 看到的状态是 coding
  pass 后的状态——需要明确「reviewer 看的是 coding pass 之后的 diff」，
  这一点在 prompt 上落实。

V4.6 采用方案 B。

### 方案 C：reviewer / test 作为 Codex turn

在同一 Codex thread 内通过新 turn 让 coding agent 自我 review。

优点：实现最小；继续单一 driveLifecycle 调用。

缺点：

- reviewer / coding 不是同一份 prompt / system，混在一个 thread 容易让
  coding agent 自我背书；不符合「reviewer 独立视角」目标。
- 无法切换不同 runner（Claude 当 reviewer，Codex 当 coding）。
- 难以独立 cancel / retry / 降级。

V4.6 不采用方案 C。

## 5. 产品边界

V4.6 的核心实体是 **AgentRole** 和 **AgentPass**。

| Role | 责任 | 读写权限 |
| --- | --- | --- |
| `coding` | 落地代码变更、创建 / 更新 MR、产出 coding-side summary / validation / risks（V4.3 已有） | 可写 worktree，可读 GitLab Issue / MR，可调 createGitLabTools 全套 |
| `reviewer` | 在 coding pass 之后，独立 diff review，识别遗漏的风险、需要回归测试的位置、与 V4.4 failure pattern 的关系 | 只读 worktree，只读 GitLab MR / discussion；只能产出 review note / risk list / evidence ref，不允许写文件 / 提交 / 推送 / 改 label |
| `test_evidence` | 在 reviewer pass 之后，执行 workflow 推荐的验证命令、补充截图 / playwright walkthrough / 命令输出索引 | 可执行 workflow `agents.test_evidence.commands` 中显式声明的命令，可写到 evidence 目录；不允许修改源代码、不允许 commit / push |

`coding` 是必选 role。`reviewer` 和 `test_evidence` 在 workflow YAML 显式
打开后才会跑；默认关闭。

V4.6 的 hard gate：

- 即便 reviewer pass 通过、test_evidence pass 通过，IssuePilot 也 **不会**
  自动切到 `merge-ready` 或自动 merge。最终 `human-review` 仍是人。
- reviewer / test pass 失败不会回滚 coding pass 的 worktree 或 MR。
- reviewer / test pass 不允许调用任何会触发副作用的 GitLab tool（label
  transition、issue note write、merge request comment）；evidence 写入只允
  许走本 spec §10.3 定义的 evidence emitter。
- 不允许 reviewer / test pass 调用 `@issuepilot/credentials`；token / secret
  只能由 coding pass 通过现有 tracker adapter 注入。
- reviewer / test agent 的 prompt 模板必须从 workflow `agents.<role>.prompt`
  字段读取，不允许从 issue / MR comment 注入（防 prompt injection 推到内部
  workflow surface）。

## 6. 架构

V4.6 在现有 V2.x runtime 上扩出 **Agent Orchestration Layer**：

```text
WorkItem -> TaskNode -> TaskRunLink
                          ├── AgentPass(coding)        (existing runAgent + reconcile)
                          ├── AgentPass(reviewer)      (V4.6 new, optional)
                          └── AgentPass(test_evidence) (V4.6 new, optional)
```

### 6.1 现有 V2.x runtime（继续使用）

- GitLab adapter（label / note / MR）。
- workspace / mirror / branch。
- runner-codex-app-server（driveLifecycle / RPC）。
- event store / RunReportArtifact / V4.3 evidence index。
- V4.2 TaskGraph / V4.1 WorkItem service。

### 6.2 新模块

```text
apps/orchestrator/src/agents/
  roles.ts              # AgentRole 枚举、role -> capability matrix
  passes.ts             # AgentPass 内存表 + 序列化到 TaskRunLink
  reviewer.ts           # reviewer pass orchestrator
  test-evidence.ts      # test/evidence pass orchestrator
  runner-adapter.ts     # RunnerAdapter 接口契约
  prompt-resolver.ts    # 从 workflow agents.<role>.prompt 解析模板
  routes.ts             # /api/runs/:runId/agent-passes/...

packages/runner-codex-app-server/
  src/role-prompts/
    coding.ts           # 原来的 prompt 模板入口（迁移）
    reviewer.ts         # 只读视角 prompt 模板
    test-evidence.ts    # evidence 提交模板（结构化输出）
```

`@issuepilot/workflow` 的 schema 增加 `agents` 段（见 §11）；
`@issuepilot/runner-codex-app-server` 实现 `RunnerAdapter` 接口的具体类
（codex-app-server），是第一版唯一可用 adapter。

V4.6 不强制在本阶段把所有非 Codex runner 实装；目标是把 contract 锁死，让
后续 Claude Code / Cursor / 内部 coding agent 都能以 npm package 形式接入。

## 7. Agent Roles

### 7.1 `coding`

继承 V4.1+V4.3 已有行为：

- 输入：task prompt（含 V4.1 task context）、workflow agents.coding.prompt
  template、workspace state、GitLab issue。
- 输出：worktree diff / MR / RunReportArtifact 的
  `agentSummary` / `agentValidation` / `agentRisks` / `noCodeChangeReason`。
- 失败：维持现有 `failed` / `blocked` / `needs_rework` 分类。
- 在 RunReportArtifact 中新增 `agentPasses[]`（详见 §8）以保持向后兼容。

### 7.2 `reviewer`

V4.6 新增。

- 触发条件：coding pass 状态为 `succeeded` 或 `partial`，且 workflow
  `agents.reviewer.enabled === true`。coding pass 直接 `failed` / `blocked`
  不进入 reviewer。
- 输入：
  - task prompt 摘要（不允许重新规划 task）。
  - coding pass 产生的 diff（`git diff base...HEAD` 字符串裁剪到 token
    上限内，超长进入「diff_truncated」标志位）。
  - coding pass 的 `agentSummary` / `agentValidation` / `agentRisks` 文本。
  - V4.5 Improvement recommendation top-K（如果存在），用于提示 reviewer
    检查重复失败模式。
- 输出（结构化）：
  - `verdict`: `looks_good` / `needs_rework` / `blocked` / `inconclusive`。
  - `notes[]`: 每条带 `severity` / `pointer`（file:line 或 evidence href）
    / `summary` / `suggestedAction`。
  - `riskAssessment`: 文本，对 coding 风险评估的二次确认或补充。
  - `evidenceRefs[]`: 复用 V4.5 的 `ImprovementEvidenceRef` schema，但
    `kind` 限制在 `run` / `task` / `evidence` / `review-comment`。
- 副作用：
  - 仅可写到 `AgentPass` 记录；不允许触碰 worktree、不允许 commit / push、
  不允许写 GitLab note / MR / label。
  - 如果 `verdict === "needs_rework"`，仅在 RunReportArtifact 的
    `handoff.followUps` 上追加一条建议，由现有 V4.3 reconcile 路径决定是
    否最终透出到 GitLab note。**reviewer 自己不发 GitLab 通知**。

### 7.3 `test_evidence`

V4.6 新增。

- 触发条件：reviewer 没有把 task 拉到 `needs_rework` 或 `blocked`，且
  workflow `agents.test_evidence.enabled === true`。
- 输入：
  - 同 reviewer 的输入摘要。
  - workflow `agents.test_evidence.commands[]`（显式声明可执行的命令清单，
    例如 `pnpm test --filter ...` 或 `playwright test --reporter=line`）。
  - V4.3 已有的 evidence index 头部。
- 输出：
  - 每条命令执行的 stdout/stderr 头部摘要 + 完整 log 文件路径。
  - 新增 evidence entries，类型限定在 V4.3 evidence schema 已有的
    `kind`（screenshot / command-output / playwright-walkthrough /
    test-output）。
  - `verdict`: `evidence_ok` / `evidence_gap` / `evidence_failed`。
- 副作用：
  - 可在 worktree 内执行 workflow 显式列出的命令，受现有 `runHook` 沙箱
    限制；不允许跑任意 shell。
  - 可写到 evidence 目录（V4.3 已规定路径）。
  - 不允许修改源代码；执行结束后必须 `git status -s` 确认 worktree 无新
    diff，否则该 pass 直接 `evidence_failed` 并把 stray diff 列入
    artifact。

## 8. 数据模型

### 8.1 新增 shared contract

```ts
export const AGENT_ROLE_VALUES = [
  "coding",
  "reviewer",
  "test_evidence",
] as const;
export type AgentRole = (typeof AGENT_ROLE_VALUES)[number];

export const AGENT_PASS_STATUS_VALUES = [
  "pending",
  "running",
  "succeeded",
  "failed",
  "blocked",
  "skipped",
  "cancelled",
] as const;
export type AgentPassStatus = (typeof AGENT_PASS_STATUS_VALUES)[number];

export interface AgentPassPromptRef {
  templatePath: string;
  templateSha256: string;
}

export interface AgentPassMetrics {
  durationMs: number;
  turnsUsed: number;
  truncatedInputs?: string[];
}

export interface AgentPassEvidenceRef {
  kind:
    | "run"
    | "task"
    | "work-item"
    | "evidence"
    | "review-comment"
    | "quality-drilldown";
  id: string;
  href?: string;
  reason: string;
}

export interface AgentReviewerNote {
  severity: "info" | "warn" | "blocker";
  pointer: string;
  summary: string;
  suggestedAction?: string;
}

export interface AgentReviewerOutcome {
  verdict: "looks_good" | "needs_rework" | "blocked" | "inconclusive";
  notes: AgentReviewerNote[];
  riskAssessment?: string;
  evidenceRefs?: AgentPassEvidenceRef[];
}

export interface AgentTestEvidenceOutcome {
  verdict: "evidence_ok" | "evidence_gap" | "evidence_failed";
  commandResults: Array<{
    command: string;
    exitCode: number;
    stdoutHead: string;
    stderrHead: string;
    logArtifactPath?: string;
  }>;
  newEvidenceIds: string[];
  strayDiff?: boolean;
}

export interface AgentPass {
  passId: string;
  taskRunLinkId: string;
  role: AgentRole;
  runnerAdapterId: string;
  attempt: number;
  status: AgentPassStatus;
  startedAt?: string;
  endedAt?: string;
  prompt?: AgentPassPromptRef;
  metrics?: AgentPassMetrics;
  failureReason?: string;
  /**
   * 角色特定输出。约束：role === "coding" 时为空（coding 输出走 RunReportArtifact
   * 既有字段）；role === "reviewer" 时为 `AgentReviewerOutcome`；
   * role === "test_evidence" 时为 `AgentTestEvidenceOutcome`。
   */
  reviewer?: AgentReviewerOutcome;
  testEvidence?: AgentTestEvidenceOutcome;
}
```

### 8.2 现有契约扩展

`TaskRunLink` 增加 `agentPasses: AgentPass[]`，默认空数组。旧 link 反序列化
时缺字段视为空。

`RunReportArtifact` 增加 `agentSummary.byRole`：

```ts
interface RunReportArtifact {
  ...
  agentPasses?: {
    summary: Record<AgentRole, AgentPassStatus | "not_run">;
    reviewerVerdict?: AgentReviewerOutcome["verdict"];
    testEvidenceVerdict?: AgentTestEvidenceOutcome["verdict"];
  };
}
```

`agentSummary` / `agentValidation` / `agentRisks` 等字段保持不变，coding
pass 仍写入这些字段，向后兼容。

### 8.3 存储路径

```text
agent-passes/<taskRunLinkId>/<passId>.json
```

`@issuepilot/observability.redact` 写盘前过滤；prompt 模板不要直接写入
record（只记录 path + sha256）。

## 9. RunnerAdapter 契约

V4.6 把 agent 的运行抽象成 adapter。第一版只实现 codex-app-server 适配，但
contract 必须稳定到能挂别的 runner。

```ts
export interface RunnerAdapterInput<TRole extends AgentRole> {
  role: TRole;
  runId: string;
  taskRunLinkId: string;
  passId: string;
  workspacePath: string;
  prompt: string;
  promptRef: AgentPassPromptRef;
  /**
   * Role-specific capability bundle the orchestrator already vetted. The
   * adapter MUST NOT widen this on its own. For example, the reviewer
   * bundle never includes `transitionLabels`; the test_evidence bundle
   * never includes any GitLab write tool.
   */
  capabilities: AgentCapabilityBundle;
  signal: AbortSignal;
  onEvent: (
    type: string,
    data?: Record<string, unknown>,
  ) => void;
}

export interface AgentCapabilityBundle {
  /** read-only repo access; always allowed */
  workspaceRead: true;
  /** worktree write (coding only) */
  workspaceWrite: boolean;
  /** allowed shell command prefixes; empty for reviewer */
  shellAllowList: string[];
  /** GitLab tools the adapter may surface to the LLM */
  gitlabTools: Array<
    | "getIssue"
    | "createIssueNote"
    | "updateIssueNote"
    | "createMergeRequest"
    | "updateMergeRequest"
    | "getMergeRequest"
    | "listMergeRequestNotes"
    | "getPipelineStatus"
  >;
  /** structured-output schema name the adapter must request */
  outputSchema:
    | "coding-handoff"
    | "reviewer-outcome"
    | "test-evidence-outcome";
}

export type RunnerAdapterResult<TRole extends AgentRole> =
  TRole extends "reviewer"
    ? { status: AgentPassStatus; reviewer?: AgentReviewerOutcome; failureReason?: string }
    : TRole extends "test_evidence"
      ? {
          status: AgentPassStatus;
          testEvidence?: AgentTestEvidenceOutcome;
          failureReason?: string;
        }
      : {
          status: AgentPassStatus;
          coding?: {
            summary?: string;
            validation?: string;
            risks?: string;
            noCodeChangeReason?: string;
          };
          failureReason?: string;
        };

export interface RunnerAdapter {
  readonly id: string;
  readonly role: AgentRole;
  run<TRole extends AgentRole>(
    input: RunnerAdapterInput<TRole>,
  ): Promise<RunnerAdapterResult<TRole>>;
}
```

`@issuepilot/runner-codex-app-server` 提供 3 个 RunnerAdapter 实例（coding /
reviewer / test_evidence），共享 driveLifecycle 但传入不同 `tools`、
`approvalPolicy`、`turnSandboxPolicy` 和 `outputSchema`。

V4.6 不实现非 Codex adapter，但 plan 文档需要给一份「Claude Code adapter
集成路径」附录，作为接口稳定性的 ack。

## 10. Orchestration

### 10.1 调度时序

```
[V4.2 TaskNode -> ready]
        │
        ▼
   ┌────────────────────┐
   │ coding pass        │  runAgent (existing)
   └─────────┬──────────┘
             │ status in (succeeded, partial)
             ▼
   ┌────────────────────┐
   │ reviewer pass       │  enabled? read-only adapter
   └─────────┬──────────┘
             │ verdict !== needs_rework / blocked
             ▼
   ┌────────────────────┐
   │ test_evidence pass  │  enabled? command allowList
   └─────────┬──────────┘
             │
             ▼
   [aggregate -> RunReportArtifact + WorkItemReport]
```

### 10.2 失败降级

| coding | reviewer | test_evidence | 整体处理 |
| --- | --- | --- | --- |
| `failed`/`blocked` | not_run | not_run | 维持现有失败路径，不进入 reviewer / test |
| `succeeded`/`partial` | `looks_good` | `evidence_ok` | task 进入 `human-review` |
| `succeeded` | `needs_rework` | not_run | task 切到 `needs_rework`，handoff note 追加 reviewer summary |
| `succeeded` | `blocked` | not_run | task 标为 `blocked`，handoff note 写 reviewer blocked reason |
| `succeeded` | `looks_good` | `evidence_gap` | task 仍可进入 `human-review`，但 RunReport 标 `evidence_gap` follow-up |
| `succeeded` | `looks_good` | `evidence_failed` | task 切到 `needs_rework`，handoff note 列出失败命令 |
| `succeeded` | `inconclusive` | (跳过) | task 进入 `human-review` 但 dashboard 标 reviewer pass 未结论 |

> 「整体处理」由 reconcile 层根据 reviewer + test verdict 计算一次，不允许
> reviewer / test pass 直接 transition label。

### 10.3 Evidence Emitter

test_evidence pass 通过 orchestrator 注入的 `EvidenceEmitter` 写新 evidence：

- emitter 只接受白名单 evidence kind。
- emitter 写入路径必须落到 V4.3 evidence 目录；其他路径 reject。
- emitter 严格对应 V4.3 `evidence-scanner` 的输出格式，避免双套索引。
- emitter 在 pass 结束后强制 `git status -s` 检查；如果除了 evidence 目录
  以外还有未跟踪文件，标 `strayDiff: true`。

## 11. Workflow / Config Schema

`@issuepilot/workflow` schema 新增 `agents`：

```yaml
agents:
  coding:
    runner: codex-app-server  # 必填
    enabled: true             # 默认 true，不允许设为 false
    prompt_template_ref: prompts/coding.md  # 兼容现有 promptTemplate
  reviewer:
    runner: codex-app-server
    enabled: false
    prompt_template_ref: prompts/reviewer.md
    max_turns: 4              # 通常 < coding，节省成本
    truncate_diff_lines: 800  # diff 超出长度时如何截断
  test_evidence:
    runner: codex-app-server
    enabled: false
    prompt_template_ref: prompts/test-evidence.md
    max_turns: 6
    commands:
      - "pnpm test --filter @issuepilot/orchestrator"
      - "playwright test --reporter=line"
    evidence_kinds_allowed:
      - command-output
      - playwright-walkthrough
      - screenshot
      - test-output
```

校验约束：

- `runner` 在 V4.6 第一版只允许 `codex-app-server`；其他 runner 名 schema
  校验失败，留 P1。
- `commands[]` 元素必须以 workflow `agents.test_evidence.shell_allow_list`
  中的某个前缀开头；同时不允许 `rm -rf` / `git push` / `gh ...` / 任何
  改 GitLab 状态的命令（黑名单显式列出）。
- prompt_template_ref 必须存在并位于 workflow `prompts/` 或 issuepilot-
  config/skills/ 目录下，禁止跨越 workspace 之外。

team mode `central-workflow` 编译后保持每个 project 独立的 `agents` 配置，
不允许某个 project 的 reviewer prompt 被另一个 project 看到。

## 12. API

新增：

```text
GET  /api/runs/:runId/agent-passes
GET  /api/runs/:runId/agent-passes/:role
POST /api/runs/:runId/agent-passes/:role/retry
POST /api/runs/:runId/agent-passes/:role/cancel
POST /api/runs/:runId/agent-passes/:role/skip
```

行为：

- `GET` 返回 `AgentPass[]` 或单 role 的最新 pass。
- `retry` 在已有 `failed` / `blocked` / `cancelled` pass 之上启动新 attempt；
  attempt 序号递增；coding role 不允许从 V4.6 这个入口 retry（仍走现有
  operator action `retry`），避免双入口。
- `cancel` 中止 `running` pass，标 `cancelled`，并写 `agent_pass_cancelled`
  事件；coding pass 走现有 cancel 注册表。
- `skip` 把 `pending` reviewer/test pass 标 `skipped`，并把 `not_run` 标记
  落到 RunReport。
- team mode 下所有 endpoint 必须带 `x-issuepilot-project`；project 不匹配
  返回 404 `{ code: "project_not_found" }`，404 / 400 形态与 V4.5 路由
  一致。

## 13. UI / Operator Workflow

### 13.1 Work Items detail

每个 task 卡片新增 3 个 role badge：

- coding：复用现有状态徽章。
- reviewer：`未启用 / 未跑 / 通过 / 需要返工 / 阻塞 / 不确定`。
- test_evidence：`未启用 / 未跑 / OK / 证据缺失 / 失败`。

点击 badge 展开该 role 的最新 pass 摘要、prompt template 引用、artifact 链
接、重试按钮（如果允许）。

### 13.2 Review Packet

在 V4.3 Review Packet 中增加「Reviewer Agent」「Test/Evidence Agent」两个
section：

- Reviewer Agent：显示 verdict、notes（按 severity 分组）、risk
  assessment、引用的 evidence。
- Test/Evidence Agent：显示 verdict、命令矩阵（命令、exit code、stdout/
  stderr 摘要、log 链接、新生成的 evidence id）。
- 失败的 pass 显示 `failureReason`，并提供 retry / skip 按钮（与 §12 API
  对接）。

### 13.3 Reports / Quality Analytics

V4.4 Reports：增加按 reviewer verdict / test_evidence verdict 维度的
drilldown；新增 failure pattern `reviewer-needs-rework` 和 `evidence-gap`，
反哺 V4.5 improvement recommendation engine。

### 13.4 i18n / 可访问性

- 所有 badge / button 必须有本地化 `aria-label`，沿用 zh / en 双语。
- 长 diff / 命令 stdout 折叠显示，避免一次性把数 MB 文本送进 DOM。

## 14. Error Handling / Safety

V4.6 仍 fail closed，且新增 multi-agent 特有的不变量：

| 场景 | 行为 |
| --- | --- |
| reviewer pass 调用了非白名单 tool | adapter 立即拒绝；pass 标 `failed`，`failureReason` 带 tool 名 |
| reviewer pass 尝试写文件 | 沙箱拒绝；pass 标 `failed`，evidence emitter 拒绝 |
| test_evidence pass 命令不在 allowList | 不执行；pass 标 `failed`，列出违规命令 |
| test_evidence pass 结束后 worktree 有源文件 diff | 强制 `evidence_failed`，stray diff 列入 artifact，coding pass 的 MR 不受影响 |
| prompt template 路径越界 workspace | workflow 加载阶段就拒绝 |
| runner adapter 失败（RPC 死掉、timeout） | pass 标 `failed`，coding pass 不受影响 |
| reviewer / test pass cancel | 立即标 `cancelled`，并发 `agent_pass_cancelled` 事件 |
| V4.5 improvement recommendation 被 reviewer 引用 | 仅作为 prompt 上下文；reviewer 不允许触发 `accept` API |
| token / secret 泄漏到 AgentPass record | observability redact + 写盘前再 sweep |

## 15. 测试策略

### 15.1 Contract tests

- `AgentRole` / `AgentPassStatus` / verdict 枚举 round-trip。
- `AgentReviewerOutcome` / `AgentTestEvidenceOutcome` 必填字段。
- `TaskRunLink.agentPasses` 序列化向后兼容（缺字段视为空）。
- `RunReportArtifact.agentPasses` 反序列化对老 report 仍为 `undefined`。

### 15.2 Adapter tests

- codex-app-server adapter 对每个 role 输出符合各自 schema。
- reviewer adapter 调用受限 GitLab tool / shell allowList。
- test_evidence adapter 仅允许 workflow 配置的命令前缀。

### 15.3 Orchestration tests

- coding pass `failed` → reviewer / test 未触发。
- coding `succeeded` → reviewer verdict 各分支转换到正确 task status。
- reviewer `needs_rework` → handoff note 追加 reviewer 摘要。
- test_evidence `evidence_failed` 自带 stray diff → MR 不被改写。
- retry / cancel / skip 行为分别覆盖。
- agent pass 之间事件顺序符合 `agent_pass_started` →
  `agent_pass_completed`，且不串到错的 runId。

### 15.4 Workflow schema tests

- `agents.reviewer.runner !== codex-app-server` 校验失败。
- `agents.test_evidence.commands` 命中黑名单时校验失败。
- prompt template 路径越界 workspace 时校验失败。

### 15.5 UI tests

- Work Items / Task Run 卡片在三种 role 状态组合下渲染正确。
- Review Packet 渲染 reviewer notes / test evidence 表格。
- agent pass retry / skip / cancel 按钮按权限禁用。
- 错误 banner 显示 adapter failure，且 `router.refresh()` 收敛状态。

### 15.6 E2E tests

Fake GitLab + fake Codex + seeded workflow agents 配置：

1. workflow.agents.reviewer.enabled = true / test_evidence.enabled = true。
2. 跑通 task：coding `succeeded` → reviewer `looks_good` → test_evidence
   `evidence_ok` → task 进 `human-review`。
3. 跑 reviewer `needs_rework` 分支：task 回到 `needs_rework`，coding MR 不变。
4. 跑 test_evidence stray-diff 失败分支：task 标 `needs_rework`，coding MR
   不变，stray diff 列入 artifact。
5. team mode 下两个 project 独立 reviewer prompt 不串数据。

## 16. 验收标准

V4.6 至少满足：

1. workflow YAML 能声明 `agents.coding` / `agents.reviewer` /
   `agents.test_evidence`，并通过 schema 校验。
2. 一个 task run 在 coding succeed 后能按配置顺序跑 reviewer 和
   test_evidence pass，并把 `AgentPass[]` 写入对应 TaskRunLink。
3. RunReportArtifact 能展示 per-role 状态；老 report 反序列化不报错。
4. reviewer / test_evidence pass 都不会写源文件、不会 commit / push、不会
   动 GitLab label 或 note（除 reconcile 层根据 verdict 决定的 handoff 文
   案）。
5. V4.6 新增 API `/api/runs/:runId/agent-passes/...` 覆盖 list / retry /
   cancel / skip，与 V4.5 路由错误形态一致。
6. Dashboard Work Items / Review Packet 能看到 reviewer / test_evidence
   结果；i18n / aria-label 已加。
7. team mode 下 agent pass 数据按 project 隔离。
8. failure pattern `reviewer-needs-rework` 和 `evidence-gap` 已接入 V4.4
   Quality Analytics 和 V4.5 Improvement engine。
9. `scripts/ci-equivalent-check.sh` 或等价 gate 通过。

## 17. 安全 / 边界回顾

V4.6 上线后必须保持的不变量：

- coding worktree 仍是唯一可能改文件的 surface；reviewer / test_evidence
  在沙箱上是只读 + 显式 allowList。
- agent pass 不允许直接 transition GitLab label；label 仍由 reconcile +
  V4.1 父 Issue label 规则统一控制。
- 任何 prompt 模板必须来自 workflow / issuepilot-config 已审计的目录；
  Issue / MR 中的文本只能作为 task context，不允许作为 reviewer / test
  prompt 的 system 部分注入。
- AgentPass record 走 `redact` + sandbox path 白名单，禁止把 credentials
  落地。
- 第一版只允许 codex-app-server 跑 reviewer / test_evidence；其他 runner
  必须先实装 RunnerAdapter 契约并通过 contract test 才能在 P1 打开。

## 18. 后续边界

V4.6 完成后，后续仍属于 V3 / V4 后续阶段，不在本 spec 中：

- 跨 host 并发跑 agent pass、worker 池、cost / 预算管控（V3）。
- 多 coding agent 竞速 / consensus（V3 之后）。
- reviewer agent 之间的多模型对比（潜在 V4.7 / V5）。
- 把 V4.5 improvement recommendation 的 apply step 让 agent 自动 commit
  到分支（需要 V3 RBAC + 审计）。
- 把 GitLab Merge Train / auto-merge 接入 reviewer verdict（需要 V3）。
