# IssuePilot V4.6 Multi-Agent Collaboration 设计

日期：2026-05-19
状态：待 spec review

关联文档：

- `docs/superpowers/specs/2026-05-17-issuepilot-v4-intelligent-workbench-design.md`
- `docs/superpowers/specs/2026-05-18-issuepilot-v4-4-quality-analytics-design.md`
- `docs/superpowers/specs/2026-05-18-issuepilot-v4-5-improvement-loop-design.md`
- `docs/superpowers/plans/2026-05-17-issuepilot-v4-1-workflow-spine.md`
- `docs/superpowers/plans/2026-05-17-issuepilot-v4-2-task-graph.md`
- `docs/superpowers/plans/2026-05-17-issuepilot-v4-3-review-packet-evidence.md`
- `README.md`

## 实施计划

- V4.6 Multi-Agent / Multi-Runner Collaboration：实施计划待写（见 `docs/superpowers/plans/2026-05-19-issuepilot-v4-6-multi-agent-collaboration.md`，将由 `writing-plans` skill 产出）。

## 1. 背景

V4.1 已经把大 Issue 拆解、子任务 run 和 Parent Review Packet 跑通。V4.2 补上
Task Graph、依赖执行和 branch chaining。V4.3 把 Review Packet 与 Evidence 统一
到 `WorkItemReport`。V4.4 让 operator / reviewer / tech lead 从多 run / 多子任务
中看到质量趋势。V4.5 把质量事实进一步推进到可审查的 `ImprovementRecommendation`
和 inert patch preview。

V4.6 的目标是在这条链路上增加多角色协作。当前 IssuePilot 的每个 task run 都由
一个 coder agent 承担：它写代码、解释自己改了什么、把结果交给人 review。在
真实工程里，review、test 和 evidence 收集是有专门角色的活儿，让同一个 agent
身兼数职会带来三类问题：

1. coder agent 自报自评 review，缺乏独立视角，容易遗漏风险。
2. test 与 evidence 的覆盖度依赖 coder agent 的自觉，无法稳定保证质量。
3. 现有 `RunReportArtifact` 把所有角色产物挤在一份报告里，audit 时无法分清
   "代码改动"、"review 判断"、"evidence 采集"各自的输入输出。

V4.6 在保持本地优先单 runner 架构的前提下，把 task 的执行切成三段：coding、
reviewer、test/evidence。三个角色都跑在现有 Codex app-server 上，以 role
profile 区分 prompt / sandbox / tools，每段产出一份 `AgentReport`。最终统一
进入 V4.3 的 human-review 通道。

## 2. 目标

V4.6 需要回答：

1. 一个 task 怎么按 coding → reviewer → test/evidence 流水线自动跑完，并在
   任一步失败或被跳过时仍能进入 V4.3 的 human-review？
2. 三角色的产物如何稳定落入 `AgentReport`，并被 V4.3 / V4.4 / V4.5 复用为
   evidence、质量事实和改进建议来源？
3. reviewer agent 给出的 inline comments 如何安全推送到 GitLab MR，又不会
   污染 reviewer 视角和审计链？
4. workflow YAML 怎么承载三角色配置（prompt、sandbox、tools、timeout），
   并允许 plan accept 时针对单个 task override recipe？
5. dashboard 怎么让 operator 一眼看到 pipeline 当前进度、每个角色产物、
   失败 reason 和下一步的可介入点？
6. 怎么保证多角色协作没有把 IssuePilot 拖进多 runner / 多 worker 平台化
   复杂度，把这一层留给 V4.7+ 与 V3？

## 3. 非目标

V4.6 不做：

- 不引入第二个 runner adapter。所有角色都跑在现有 Codex app-server 上。
  Claude Code、Cursor agent、内部 coder agent 等 runner adapter 的通用
  contract 留给 V4.7+。
- 不并行 fan-out：reviewer 和 test/evidence 不会同时跑，pipeline 始终是
  coding → reviewer → test/evidence 的严格顺序。任何并行编排留给 V4.7+。
- 不引入 agent 间消息总线 / blackboard / shared context store。三角色之间
  只通过 AgentReport 的结构化字段交换信息。
- 不允许 reviewer 或 test/evidence agent 写代码、改 workflow 文件、修改
  `AGENTS.md` 或 project rules。只有 coder agent 拥有 task worktree 的
  写权限。test/evidence 可以写 evidence 子目录，但不能改任何源码。
- 不自动 merge MR。reviewer 的 `decision` 不会触发 IssuePilot 直接接受
  task；human-review 仍是唯一的 merge gate。
- 不引入 LLM 自我评判（agent A 评判 agent B 的提示词）。reviewer 直接
  对 coder 的产物（diff、test、CI、evidence）做 deterministic + LLM 混合
  判断，但不评判 coder agent 本身的"思路"。
- 不持久化 prompt 完整内容。AgentReport 只保存可重放需要的 `role_profile_id`
  + `prompt_template_hash` + 入参摘要，避免日志爆炸和 secret 泄露。
- 不把 V4.6 设计成"全自动 review pipeline"。每一步都可在 dashboard 上
  retry / skip / replan，关键节点仍由 operator gate。

## 4. 设计选项

### 方案 A：Single-agent + Role Phases（不采用）

继续让一个 coder agent 顺序产出 coding 改动 + 自评 review + 自补 evidence，
仅在 RunReportArtifact 内拆 sections。

优点：实现最小，无新组件。

缺点：

- 不能引入"独立 reviewer 视角"，本质上没有解决 V4.6 想解决的问题。
- AgentReport / audit 链路仍混在一起，V4.4 / V4.5 拆分质量信号困难。
- 与 V4 总 spec §7 V4.6 "三角色分工"的目标背离。

### 方案 B：Pipeline + AgentReport Layer（采用）

引入 Agent Orchestrator 编排 coding → reviewer → test/evidence 三段顺序
pipeline。每段触发一次 Codex run，写一份 `AgentReport`。多角色都通过
`workflow.roles.*` 配置区分 prompt template、sandbox、tools 和 timeout。

优点：

- 三角色产物分离，audit、V4.4 质量事实和 V4.5 改进建议都能按 role 拆分。
- 单 runner 单 worker，复杂度可控。
- 与 V4.3 human-review 通道、V4.2 retry/skip 状态机、V4.4 QualityAnalytics
  采集自然对齐。
- 通过 recipe（`full pipeline` / `coding+reviewer` / `coding-only`）让
  operator 在不同场景下取舍。

缺点：

- 需要新增 AgentReport store、API、UI；TaskNode 状态机要细化。
- 三角色串行跑总时长比单 agent 长，需要在 dashboard 上明确呈现 ETA。

### 方案 C：Runner Adapter Contract 先行（不采用）

先抽出通用 runner adapter contract，让 Codex、Claude Code、内部 agent
都能挂上来，再考虑角色分工。

优点：基础设施扎实，多 runner 一次到位。

缺点：

- 与"本地优先、不提前平台化"原则冲突，V4 总 spec §2 V4 / V3 边界明确
  把多 worker 调度推给 V3。
- 没有具体的角色产品语义做 dog-food，adapter contract 很容易设计得
  和实际需求脱节。

V4.6 采用方案 B；runner adapter contract 推到 V4.7+ 或与 V3 合流。

## 5. 产品边界

V4.6 的核心对象是 `PipelineRun` 和 `AgentReport`。它们不替代现有
`RunReportArtifact`，而是承担"多角色协作"的产品语义。

每个 TaskNode 启动后会创建一个 `PipelineRun`，按 recipe 顺序产出 1-3 份
`AgentReport`：

- **coding**：在 task worktree 内写代码，产出 diff、MR、build/test summary
  和 RunReportArtifact。这是已有的 IssuePilot run 流程，本质上没变。
- **reviewer**：在同一 worktree（read-only）跑，扫 diff、CI、test 结果，
  产出 review summary、decision、risks、evidence_request、findings 和
  inline comments。
- **test/evidence**：在同一 worktree（read-only 源码，但可写
  `<worktree>/.issuepilot/evidence/<taskId>/`）跑，按 reviewer 的
  `evidence_request[]` 补 CI / pnpm test / Playwright walkthrough 等证据。

V4.6 的 hard gate：

- recipe 默认 `full_pipeline`；操作员可在 plan accept 阶段以及 TaskNode 进入 `ready` 之后改单个 task 的
  recipe，直到 pipeline 启动 coding 步骤为止（详见 §18.1）。workflow YAML 的 `default_recipe` 是唯一的 system default。
- reviewer 默认推送 inline comments 到 GitLab MR；这是 P0 选定的产品决策，
  并伴随 §12 的 6 条护栏。
- AgentReport 的 `role`、`roleProfileId`、`promptTemplateHash`、角色专属内容字段
  （`coder.diffSummary`、`reviewer.summary` / `decision` / `confidence` / `risks`
  / `evidenceRequest` / `findings` / `inlineComments`、`testEvidence.evidenceItems`
  / `baselineEvidence`）一经写入即不可变；`status`、`completedAt`、`lastError`、
  `evidenceLinks`、`redactedFields`、`mrPublication.{status, noteIds, publishedAt,
  lastError}` 在 AgentReport 终态前可流转。重跑产生新的 `agentReportId`，旧版本以
  `supersededBy` 引用方式保留，参考 V4.5 `ImprovementRecommendation` 的 supersede 模式。
- 失败的 pipeline 不能自动重跑：所有 retry / skip / replan 都需要 operator
  在 dashboard 上显式触发，沿用 V4.2 状态机。

## 6. 架构

V4.6 在 V4.2 的 task pipeline 之下新增 **Agent Orchestrator**：

```text
TaskPlan (accepted)
  └─ TaskNode (ready)
        └─ PipelineRun (per task, V4.6 新增)
              ├─ AgentReport: coder    -> 已有 RunReportArtifact 复用
              ├─ AgentReport: reviewer -> 新增（inline comments、findings）
              └─ AgentReport: test_evidence -> 新增（evidence collector 触发）
```

### 6.1 沿用的 V2.x / V4.x runtime

- `apps/orchestrator` 的 Codex app-server lifecycle、event store、cancel
  registry 不动。
- `packages/runner-codex-app-server` 不动，所有角色复用同一份 spawn 流程。
- `packages/workflow` 做 schema 扩展，但保留向后兼容（参见 §10）。
- `packages/tracker-gitlab` 已有的 note API 复用；新增 inline note path
  封装由 reviewer 调用。
- V4.3 的 evidence collector 接口（`apps/orchestrator/src/evidence/`）由
  test/evidence agent 触发，不重新发明。
- V4.4 QualityAnalytics 直接消费新的 AgentReport，按 role 拆分指标。
- V4.5 ImprovementRecommendation 新增 `roleConfiguration` 目标面（见 §19）。

### 6.2 新增 Agent Orchestrator 模块

新模块位于 `apps/orchestrator/src/agents/`：

- `pipeline.ts`：消费 TaskNode、按 recipe 编排三段顺序、写 PipelineRun。
- `coder.ts` / `reviewer.ts` / `test-evidence.ts`：三角色的 role profile
  装载、prompt 构造、Codex run 启动、AgentReport 落盘。
- `agent-report-store.ts`：AgentReport 的 CRUD + supersede + per-task 查询。
- `pipeline-store.ts`：PipelineRun 的 CRUD + per-TaskNode 反查。
- `recipes.ts`：recipe 解析（workflow YAML default → per-task override），
  返回有序的 role 列表。
- `mr-publisher.ts`：reviewer 把 inline comments / summary 推到 GitLab MR，
  封装 §12 的 6 条护栏。

### 6.3 与 dashboard 的关系

dashboard 复用 V4.3 已有的 Task / WorkItem detail 页：

- Task detail 顶部新增 pipeline progress bar（三段 step indicator）。
- Task detail 下方新增 Coder / Reviewer / Evidence 三 AgentReport tab。
- Reports 页面（V4.4）新增按 role 拆分的成功率 / 失败模式过滤器。
- Improvements 页面（V4.5）新增 `roleConfiguration` 目标面的 recommendation
  分类。

详见 §17。

## 7. 协作语义

三角色固定串行：

```text
coding → reviewer → test/evidence → awaiting_human_review
```

### 7.1 推进规则

- coding step 完成（exit success、RunReportArtifact 写入）后，若 recipe 包含
  reviewer 步骤，自动起 reviewer；否则（`coding_only`）直接进入
  `awaiting_human_review`。
- reviewer step 完成（AgentReport 写入）后：
  - operator 的默认动作按 §7.3 的 reason code 解释，可能是 retry coder / retry
    reviewer / fix workflow & retry reviewer。pipeline 自身的状态机仅停在 reviewer
    step（PipelineRun.status = `awaiting_rework` 或 `failed`），等待 operator 在
    dashboard 上触发新的 AgentReport（reviewer / test_evidence 单角色重跑）或
    新的 PipelineRun（coder 重跑）。
  - 如果 `decision = approve_with_comments` 且 recipe 包含 test_evidence 步骤，
    继续 test/evidence step。
  - 如果 reviewer 输出的 `evidence_request[]` 为空且 decision 是
    `approve_with_comments`，test/evidence 仍会跑一次"基线证据收集"
    （CI summary + lint summary），不会被完全跳过。这是为了让所有
    走完 pipeline 的 task 都至少有一份 evidence baseline。
- test/evidence step 完成（不论成功或 `incomplete`）后，TaskNode 进
  `awaiting_human_review`；具体失败回路见 §14.3。
- 如果 recipe 是 `coding_plus_reviewer`，test/evidence step 被显式跳过，
  AgentReport 不创建，pipeline 直接到 `awaiting_human_review`，但
  WorkItemReport 在汇总时会标 `evidence_status = skipped_by_recipe`。
- 如果 recipe 是 `coding_only`，pipeline 不创建 reviewer / test_evidence
  step。task 完成后直接到 `awaiting_human_review`。

### 7.2 触发模型

- 默认 `auto_advance`：上一 step success → orchestrator 立即起下一 step。
- operator gate 只在三个点：
  - **起始**：task 在 plan-accept 时可改 recipe。进入 `ready` 后仍可在 dashboard 上调整 recipe，直到 pipeline 启动 coding 步骤（即 `running_coding`）为止。
  - **中途**：任一 step 在 dashboard 上可 retry / skip / replan，沿用 V4.2；具体 retry 目标按 §7.3 reason code 解释。
  - **终点**：pipeline 完成 → `awaiting_human_review`，进入 V4.3 通道。
- 失败时 orchestrator 不自动重跑：必须 operator 显式触发，避免循环燃料。
- cancel 后 TaskNode 回 `ready` 时同时写 `last_cancelled_at` 标记；orchestrator auto_advance 检查该标记并跳过，直到 operator 在 dashboard 显式触发新一轮 pipeline。

### 7.3 失败传播

| 角色 | 失败类型 | TaskNode 状态 | reason code | dashboard 提示 | operator 默认动作 |
| --- | --- | --- | --- | --- | --- |
| coder | 任何 (CI / build / runtime) | `failed` | `coding_failed` | "coder agent 失败，请 retry 或 replan" | retry coder |
| reviewer | agent 自身崩 (context、tool、timeout) | `blocked` | `reviewer_unavailable` | "reviewer agent 不可用，可重试" | retry reviewer |
| reviewer | decision = request_changes | `needs_rework` | `reviewer_requested_changes` | "reviewer 要求返工，已写入 review summary" | retry coder |
| reviewer | decision = cannot_review (例如 token scope 不足、prompt 渲染失败) | `blocked` | `reviewer_cannot_review` | "reviewer 跳过原因 X，可手动接管" | fix workflow & retry reviewer |
| test_evidence | agent 自身崩 | `awaiting_human_review` | `evidence_unavailable` | AgentReport 标 `incomplete`，仍可送 human review | retry test_evidence（可选） |
| test_evidence | 部分 evidence_request 失败 | `awaiting_human_review` | `evidence_partial` | dashboard 列出"未采集 evidence_request" 清单 | retry test_evidence（可选） |

reason code 的意义：

- `reviewer_unavailable` / `reviewer_cannot_review` 进 `blocked` 而非 `needs_rework`，
  是因为根因在 "agent 环境 / 配置"，不是 "代码需要返工"；这让 V4.4 QualityAnalytics
  能把"配置类问题"和"代码类问题"分桶。
- `reviewer_requested_changes` 进 `needs_rework`，沿用 V4.2 既有 needs_rework 通道。
- `evidence_*` 不阻塞 pipeline 进入 `awaiting_human_review`，因为 reviewer summary
  是核心信号；evidence 不完整由 human reviewer 自行决定补料。

### 7.4 边界：哪些情况不进 pipeline

- TaskNode 状态非 `ready` 时，PipelineRun 不会被创建。
- 当 recipe 解析失败（workflow YAML schema 错误、role profile 缺失），
  写 `pipeline_init_failed` event，TaskNode 不离开 `ready`，dashboard 弹
  workflow 配置错误提示。
- 当 task 已经 `skipped` 或 `blocked_by_dependency`，pipeline 永远不创建。

## 8. 数据模型

### 8.0 TaskNode 状态机扩展

V4.2 现有：`planned / blocked_by_dependency / ready / running / completed /
failed / blocked / needs_rework / skipped`。

V4.6 把 `running` 拆细，新增一个 `awaiting_human_review`：

| 状态 | 含义 |
| --- | --- |
| `planned` | （V4.2 沿用） |
| `blocked_by_dependency` | （V4.2 沿用） |
| `ready` | （V4.2 沿用） |
| `running_coding` | coder agent 在跑 |
| `running_reviewer` | reviewer agent 在跑 |
| `running_test_evidence` | test/evidence agent 在跑 |
| `awaiting_human_review` | AI pipeline 跑完，等 V4.3 human-review 通道 |
| `completed` | human 接受 AI pipeline 产物（不是 AI pipeline 跑完就 completed） |
| `failed` | 沿用，扩展含义见 §7.3 |
| `blocked` | 沿用 |
| `needs_rework` | 沿用，扩展含义见 §7.3 |
| `skipped` | 沿用 |

`completed` 语义微调：原 V4.2 是"AI pipeline 跑完且不失败"。V4.6 起严格
绑定到 V4.3 human-review 通道的 `accepted`。这样 V4.4 QualityAnalytics 的
success rate 才能反映"人接受的成功"，而不是"AI 自我标记成功"。

向后兼容：写入 `running_*` 三态前，orchestrator 仍能读取旧 task store 里的
`running`；旧值会被映射成 `running_coding` 作为兼容默认。

### 8.1 PipelineRun

代表一次完整的"多角色 task 执行"。一个 TaskNode 可以有多个 PipelineRun
（每次 replan / retry 创建新版本）。

关键字段：

- `pipelineRunId`
- `workItemId`
- `taskId`
- `recipe` (`full_pipeline` / `coding_plus_reviewer` / `coding_only`)
- `recipeSource` (`workflow_default` / `operator_override`)
- `agentReportIds`：按 role 索引的 AgentReport ID 列表
- `status`：枚举
  - `running_coding` / `running_reviewer` / `running_test_evidence`：对应 step 在跑
  - `awaiting_human_review`：AI pipeline 全部完成（成功或 evidence partial），等 human-review 接收
  - `awaiting_rework`：reviewer 跑完且 `decision = request_changes`，等 operator 触发 coder retry
  - `partial`：test_evidence 部分失败（reason code ∈ `evidence_unavailable` / `evidence_partial`），pipeline 仍推到 `awaiting_human_review`，本字段记录"AI pipeline 完成但 evidence 不完整"
  - `failed`：coder 失败 / reviewer 自身崩 / sandbox violation / scope probe 失败
  - `cancelled`：operator 主动取消
- `currentRole` (`coder` / `reviewer` / `test_evidence` / null)
- `createdAt` / `updatedAt` / `completedAt?`
- `supersedes?` / `supersededBy?`：retry / replan 时形成线性历史

注：PipelineRun.status 是 pipeline 自身的 lifecycle，**与 TaskNode.status 不重合**。
例如 PipelineRun.status = `partial` 时 TaskNode.status 仍是 `awaiting_human_review`。

### 8.2 AgentReport

每个角色一份。

公共字段：

- `agentReportId`
- `pipelineRunId`
- `taskId`
- `role` (`coder` / `reviewer` / `test_evidence`)
- `roleProfileId`：workflow YAML 中 `roles.<role>` 的稳定 ID
- `promptTemplateHash?`：当时使用的 prompt template 的 sha256（用于复现）；
  agent 未启动场景（token scope 不足、prompt 渲染失败）下可为 `null`
- `status` (`running` / `complete` / `incomplete` / `failed` / `cancelled`)
- `startedAt`：probe 触发或 Codex run 启动时刻；agent 未启动场景下仍写入，等于
  orchestrator 决策时刻
- `completedAt?`
- `runId?`：对应 Codex run 的 ID（与 RunReportArtifact 绑定）；agent 未启动场景下为 `null`
- `evidenceLinks`：指向 evidence files / RunReportArtifact 中的 anchor
- `lastError?` (`{ code, message, hint? }`)
- `redactedFields[]`：记录哪些字段在写盘时被 redaction（V4.4 已有机制）

角色专属字段（coder）：

- `coder`:
  - `diffSummary`
  - `branch`
  - `mergeRequest`
  - `runReportArtifactId`
  - `buildStatus` / `testStatus` / `lintStatus`

角色专属字段（reviewer）：

- `reviewer`:
  - `summary` (markdown)
  - `decision` (`approve_with_comments` / `request_changes` / `cannot_review`)
  - `confidence` (0..1)
  - `risks[]`
  - `evidenceRequest[]`：每条
    `{ kind: 'screenshot' / 'playwright_walkthrough' / 'ci_log' / 'test_run' / 'custom', target, rationale }`
  - `findings[]`：`{ severity (low/medium/high/critical), category, message,
    locationHint?: { filePath, lineRange? } }`
  - `inlineComments[]`：`{ filePath, lineRange: { start, end },
    severity (medium/high/critical), category, message, suggestedFix? }`
  - `mrPublication`: `{ status: 'pending' / 'published' / 'publish_failed' /
    'skipped_by_config' / 'revoked', noteIds[], publishedAt?, lastError? }`

角色专属字段（test_evidence）：

- `testEvidence`:
  - `evidenceItems[]`：每条对应 reviewer.evidenceRequest 的一项，
    `{ kind, target, source, status: 'collected' / 'failed' / 'skipped',
    artifactPath?, lastError? }`
  - `baselineEvidence`：固定收集的"基线证据"（CI summary、lint summary、
    test summary、覆盖率快照），即使 evidenceRequest 为空也会写。

### 8.3 TaskNode 字段扩展

`TaskNode` 在 V4.2 基础上新增：

- `currentPipelineRunId?`
- `roleFailureReason?` (string，§7.3 reason code)
- `last_cancelled_at?` (ISO timestamp)：在 PipelineRun cancel 把 TaskNode 拉回 `ready`
  时写入；orchestrator auto_advance 跳过带该标记的 TaskNode，直到 operator 在
  dashboard 显式触发新一轮 pipeline，触发时清空该字段

`runIds[]` 不再直接 append；改为通过 `PipelineRun.agentReportIds` 间接索引。
保留 `runIds[]` 字段做兼容（写入时同步），但 V4.7+ 计划弃用。

### 8.4 WorkItemReport 字段扩展

V4.3 现有 WorkItemReport 在 `taskSummaries[]` 内每条 task 新增：

- `pipelineRunId?`
- `coderReportId?` / `reviewerReportId?` / `testEvidenceReportId?`
- `reviewerDecision?` / `reviewerConfidence?`
- `evidenceStatus`: `complete` / `partial` / `skipped_by_recipe` / `unavailable`

WorkItemReport.overallStatus 仍由 V4.3 规则决定，但新增检查：如果任一 task
的 `evidenceStatus = unavailable` 且 reviewer decision 不是
`approve_with_comments`，overallStatus 不允许 `ready_to_merge`。

## 9. 存储策略

V4.6 沿用 `~/.issuepilot/<project>/` 本地优先布局：

```text
pipelines/<workItemId>/<taskId>/<pipelineRunId>.json
agent-reports/<taskId>/<role>/<agentReportId>.json
agent-reports/<taskId>/<role>/index.json    # 包含 supersede 链
```

- `pipelines/` 嵌 workItemId，是为了和 V4.2 `task-run-links/<workItemId>/`
  对齐，便于按 work item 维度 list / GC。
- `agent-reports/` 不嵌 workItemId，是为了和 V4.5 `recommendations/` 平级，
  方便 V4.5 ImprovementRecommendation 直接以 `agentReportId` 引用证据；
  taskId 在 V4.2 内已全局唯一，足以唯一定位 AgentReport。
- 不引入 Postgres / SQLite / 远端存储。生产化留给 V3。
- evidence artifact 文件（截图 / Playwright trace）仍写入 V4.3 已有的
  `~/.issuepilot/<project>/evidence/<taskId>/`，AgentReport 只记 path。

向后兼容：缺失 `pipelines/` / `agent-reports/` 时，orchestrator 视为
没有 V4.6 数据，dashboard 退化展示 V4.5 视图。

## 10. workflow YAML 扩展

新增顶层 `default_recipe` 字段和 `roles:` 节点：

```yaml
default_recipe: full_pipeline   # full_pipeline | coding_plus_reviewer | coding_only

roles:
  coder:
    prompt_template: prompts/coder.md
    sandbox: read_write_worktree
    tools:
      - name: gitlab.create_mr
      - name: gitlab.update_mr
      - name: run.command
        allow:
          - "pnpm build"
          - "pnpm test"
          - "pnpm lint"
          - "pnpm --filter * test"
    timeout_seconds: 1800
  reviewer:
    prompt_template: prompts/reviewer.md
    sandbox: read_only_worktree
    tools:
      - name: gitlab.read_mr
      - name: gitlab.note_inline      # V4.6 新增封装
    publish_to_mr: true         # default: true
    severity_threshold: medium  # default: medium
    max_inline_comments: 25     # default: 25
    timeout_seconds: 900
  test_evidence:
    prompt_template: prompts/test-evidence.md
    sandbox: read_only_source_write_evidence
    tools:
      - name: run.command
        allow:
          - "pnpm test"
          - "pnpm lint"
          - "pnpm --filter * test"
      - name: playwright.walkthrough
      - name: evidence.collect
    timeout_seconds: 1200
```

- `sandbox` 是受限枚举：
  - `read_write_worktree`（仅 coder）：可读写 task worktree，但仍受 Codex
    全局 sandbox 限制（不能逃出 workspace、不能改 `~/.issuepilot`）。
  - `read_only_worktree`：可读 worktree，写操作一律拒绝。
  - `read_only_source_write_evidence`：源码 read-only；只允许写
    `<worktree>/.issuepilot/evidence/<taskId>/`。
- `tools[]` 是白名单对象数组，每项必填 `name`，可选 `allow[]`：
  - `name` 是受限枚举：`gitlab.create_mr` / `gitlab.update_mr` /
    `gitlab.read_mr` / `gitlab.note_inline` / `run.command` /
    `playwright.walkthrough` / `evidence.collect`。
  - `allow[]` 只对 `name = run.command` 有效，列出允许的命令前缀
    （支持 `*` 单段通配，但**不允许** `allow: ['*']` 这样的全通配；
    sandbox 在执行前做前缀匹配）。
  - 未列入 `tools[]` 的能力（包括 file system write、git push、
    GitLab labels 写、note write 之外的 API、未列出的 `run.command` 命令）
    一律由 sandbox 拒绝。
- 缺失 `roles:` 时，orchestrator fallback 到 hardcoded 内置默认 role
  profile（仅 V4.6 P0 提供一份 best-effort 默认，rollout 后 deprecate）。
- prompt_template 路径相对 `issuepilot-config/`，文件不存在视为配置错误，
  写 `role_profile_invalid` event，TaskNode 不进 pipeline。

向后兼容：旧 workflow YAML 没有 `default_recipe` / `roles:` 时，orchestrator
使用 hardcoded `full_pipeline` + 内置 role profile，但在 dashboard 上提示
"workflow YAML 尚未为 V4.6 配置 roles，建议显式加入"。

## 11. reviewer 产物契约

reviewer AgentReport 是 V4.6 的核心新对象。契约必须先定死，避免实现层面
来回改 shape。

### 11.1 必填字段

- `summary` (markdown)：≤ 4000 字符，给 human reviewer 的一段总览。
- `decision`：见 §8.2。
- `confidence`：0..1，浮点数，保留两位小数。
- `risks[]`：每条 `{ severity, message }`，severity ∈ `low/medium/high/critical`。
- `evidenceRequest[]`：可以为空数组；每条结构见 §8.2。
- `findings[]`：包括非 inline-level 的发现（例如"整体测试覆盖率不足"）。
- `inlineComments[]`：file+line 级评论；P0 要求支持，但允许空数组（小变更
  可能没必要 inline）。
- `mrPublication`：见 §12。

### 11.2 字段约束

- `findings[].locationHint.lineRange` 可省，可只给 `filePath`。
- `inlineComments[].lineRange.start <= lineRange.end`。允许 `start = end`
  表示单行。
- 所有 message 字段经过 V4.4 / V4.5 已有 redaction 处理；token / 凭据 /
  secrets 被替换为 `[REDACTED]`，并在 AgentReport.redactedFields[] 中标记。
- `inlineComments[].severity` 仅允许 `medium/high/critical`。`low` 级
  finding 只能进 findings[]，不会进 MR。
- `decision = cannot_review` 时必须填 `lastError.hint` 解释为什么无法 review
  （例如 "missing notes:create scope"、"reviewer prompt rendering failed"）。

### 11.3 与现有 contract 的关系

新 contract 加在 `packages/shared-contracts/src/agents.ts`（V4.6 新增）：

```ts
export type AgentRole = 'coder' | 'reviewer' | 'test_evidence';
export type ReviewerDecision = 'approve_with_comments' | 'request_changes' | 'cannot_review';

export interface AgentReportCommon { /* §8.2 公共字段 */ }
export interface AgentReportCoder { /* §8.2 coder 字段 */ }
export interface AgentReportReviewer { /* §8.2 reviewer 字段 */ }
export interface AgentReportTestEvidence { /* §8.2 test_evidence 字段 */ }

export type AgentReport =
  | (AgentReportCommon & { role: 'coder'; coder: AgentReportCoder })
  | (AgentReportCommon & { role: 'reviewer'; reviewer: AgentReportReviewer })
  | (AgentReportCommon & { role: 'test_evidence'; testEvidence: AgentReportTestEvidence });

export interface PipelineRun { /* §8.1 */ }
```

discriminated union 让 dashboard / orchestrator 在 narrow 后类型安全访问角色专属字段。

`@issuepilot/shared-contracts` 的 schema export 同步给 dashboard、orchestrator
和 V4.5 ImprovementRecommendation 使用。

## 12. MR 联动护栏

reviewer 默认推送到 GitLab MR。spec 强制以下 6 条护栏，违反任意一条都视
为实现 bug：

1. **明确 prefix**：所有 AI 写的 note / inline comment 开头必须是
   `[ai-reviewer]`（推到 MR 时统一格式：`[ai-reviewer] ...`）。dashboard
   渲染时也展示同样 prefix，便于 human 一眼区分。
2. **聚合主 note**：每次 reviewer publish 必须有 **1 条** review summary
   note（包含 decision、risks、evidence_request），再加 N 条 file/line
   inline comments。绝不允许只发 inline 不发 summary。
3. **严重度门槛**：findings.severity ≥ `medium` 才作为 inline comments
   推到 MR。`low` 级仅出现在 dashboard AgentReport.findings[]。
   `severity_threshold` 在 workflow YAML 可调，但不能低于 `low`（即
   不允许把 noise level 全推到 MR）。
4. **fail soft**：MR push 失败不阻塞 pipeline。AgentReport.mrPublication
   标 `publish_failed`、写 lastError；TaskNode 仍继续 test/evidence。
   `[ai-reviewer]` summary 仍写入本地 AgentReport，dashboard 可见。
5. **可撤回**：dashboard 上 reviewer tab 顶部提供"撤回 ai-review"按钮：
   调用 `POST /api/agent-reports/:id/revoke-ai-review`，orchestrator
   通过保存的 `mrPublication.noteIds[]` 调 GitLab API 删 AI 写的 notes，
   不动 human 写的 notes。撤回后 AgentReport.mrPublication.status
   置为 `revoked`。
6. **redaction**：reviewer 写入 MR 的所有内容预先过
   `@issuepilot/observability` 的 redaction。token / 凭据 / 私有 URL
   被替换；redactedFields[] 同步进 AgentReport。

额外约束：

- `max_inline_comments`（默认 25）限制每次 publish 的 inline 数量。超过
  时按 severity 排序保留前 N 条，剩余进 findings[] 但不上 MR，dashboard
  显示 "因数量限制，N 条 medium 级 finding 未上 MR"。
- 同一 PipelineRun 的 reviewer 在 retry 时：先 revoke 上一版的 noteIds，
  再 publish 新版本，避免 MR 上 ai-review 累积。

## 13. test/evidence agent 范围

P0 能力：

- 调用现有 CI / `pnpm test` / linter 等命令（通过 `run.command` tool，
  受 workflow YAML 限制为白名单）。
- 跳 V4.3 Playwright walkthrough（通过 `playwright.walkthrough` tool）。
- 复用 V4.3 evidence collector 接口写 evidence artifact。
- 输出 baseline evidence（即使 reviewer.evidenceRequest 为空）：包含
  最近一次 CI summary、lint summary、test summary 和覆盖率快照（如
  reports 已存在）。

P0 不做：

- 不写新测试代码。如果 reviewer 提出 "需要新增 X 测试" 的 finding，那
  归到 needs_rework 让 coder 在下一个 pipeline 版本补，不让 test/evidence
  改源码。
- 不修复 lint。
- 不重跑 reviewer。
- 不触发 deploy 或外部环境操作。

工程约束：

- test/evidence agent 的 sandbox 是 `read_only_source_write_evidence`，
  任何写源码的尝试都会被 Codex sandbox 拒绝并写入 `sandbox_violation`
  event；TaskNode 标 `failed` reason `evidence_sandbox_violation`。
- evidence 写入路径必须落在 `<worktree>/.issuepilot/evidence/<taskId>/`
  之下；越界由 Codex sandbox 兜底。

## 14. 失败处理

### 14.1 coding 失败

- TaskNode → `failed` reason `coding_failed`。
- PipelineRun.status → `failed`。
- reviewer / test-evidence 不创建。
- operator 在 dashboard 触发 retry 或 replan，产生新 PipelineRun。

### 14.2 reviewer 失败

| 子场景 | TaskNode | PipelineRun（见 §8.1 枚举） | dashboard 行为 |
| --- | --- | --- | --- |
| Codex run 崩 / timeout | `blocked` reason `reviewer_unavailable` | `failed` | 提供"重跑 reviewer"按钮 |
| LLM 输出 schema 解析失败 | 同上 | 同上 | AgentReport.lastError 记 parse error，可 retry |
| token scope 不足（notes API 缺）/ prompt 渲染失败 | `blocked` reason `reviewer_cannot_review` | `failed` | 指引 operator 检查 token scope 或 workflow YAML |
| decision = request_changes | `needs_rework` reason `reviewer_requested_changes` | `awaiting_rework` | "查看 review summary 并触发 coding 返工" |

`PipelineRun.status = awaiting_rework` 显式表示 "reviewer 跑完且明确要返工"，
和 `failed`（reviewer 自身崩 / 配置错）区分。这影响 V4.4 QualityAnalytics 的
failure pattern 拆分（一个反映 agent 配置质量，一个反映 coder 输出质量）。

### 14.3 test/evidence 失败

- TaskNode 仍进 `awaiting_human_review`，但 AgentReport.status = `incomplete`，
  PipelineRun.status = `partial`（见 §8.1 枚举）。
- human reviewer 通过 dashboard 看到"evidence 不完整"提示，自行决定是否要
  补 evidence 后 merge。
- WorkItemReport.taskSummaries[].evidenceStatus 标 `partial` 或
  `unavailable`，§8.4 的"不允许 ready_to_merge" 规则启用。

### 14.4 Sandbox 违规

- 任一角色试图越界（reviewer 写源码、test-evidence 改源码、coder 改
  `AGENTS.md` 等）都视为 critical bug。
- Codex sandbox 拒绝，orchestrator 写 `sandbox_violation` event，
  AgentReport.status = `failed`，lastError.code = `sandbox_violation`。
- TaskNode → `failed`，dashboard 给出明确指引："agent 试图越界，已停止；
  请查看 audit log 并联系维护者"。

### 14.5 MR push 失败

- 不阻塞 pipeline。详见 §12 第 4 条。
- 但 publish_failed 计数过高（同一 task 连续 3 次失败）时 dashboard 弹
  warning，建议 operator 检查 GitLab token。

### 14.6 PipelineRun cancel

- operator 在 dashboard 上 cancel：orchestrator 通过现有 cancel registry
  发信号给 Codex run，AgentReport.status = `cancelled`，TaskNode 回
  `ready`（如果在第一步）或 `needs_rework`（如果中途），同时写入
  `TaskNode.last_cancelled_at`。
- orchestrator auto_advance 检查 `last_cancelled_at` 并跳过该 TaskNode，
  直到 operator 在 dashboard 上显式触发新一轮 pipeline（清空标记）。
  这一约束确保 cancel 行为符合 §7.2 "失败时不自动重跑"。
- 取消后已 publish 的 MR notes 不自动 revoke；需要 operator 显式按
  "撤回 ai-review"。dashboard 上 "撤回 ai-review" 按钮在 cancelled
  AgentReport 上的可见 / 可点状态见 §17.2。

## 15. workspace / sandbox

V4.6 的 sandbox 模型在 Codex sandbox 之上做角色级精细化：

- **coder**：`read_write_worktree`。和 V4.2 既有 coding run 完全相同。
- **reviewer**：`read_only_worktree`。Codex sandbox 配置为：
  - workspace 根目录挂载只读；
  - 不允许任何写文件操作；
  - 不允许 git push / git commit / git merge；
  - 允许 `gitlab.read_mr` 和 `gitlab.note_inline`（向 MR 写 note 但不
    改源码）；
  - 不允许 `gitlab.update_mr_attribute`、`gitlab.set_label` 等改 MR 状态
    的 API。
- **test_evidence**：`read_only_source_write_evidence`。Codex sandbox 配置：
  - workspace 源码挂载只读；
  - 仅 `<worktree>/.issuepilot/evidence/<taskId>/` 目录可写；
  - 允许 `run.command` 但只白名单：`pnpm test`、`pnpm lint`、
    `pnpm --filter ... test` 等；shell-level free-form 不允许。
  - 允许 `playwright.walkthrough`（封装的 evidence-only 调用）。

实现注意：

- 三角色共享同一个 task worktree，避免 V4.6 P0 引入"多 worktree 合流"
  复杂度。
- sandbox 设定由 `apps/orchestrator/src/agents/coder.ts` 等模块在 spawn
  Codex run 前显式传入；不在 runner package 内 hardcode。
- workflow YAML 中 `sandbox` 是用户可见但只读枚举：operator 可以选
  哪个角色用哪个 sandbox profile，但不能新增任意 sandbox 描述符。

## 16. 凭据

V4.6 复用 `workflow.tracker.token_env` 指向的 GitLab token：

- 启动 reviewer 前 orchestrator 执行 token scope probe（调用 GitLab
  `/personal_access_tokens/self` 或读取已知 scopes），确认包含 notes
  写入权限。GitLab personal / project / group access token 的实际 scope
  模型是粗粒度的，通常需要 `api` scope；若未来引入 fine-grained token，
  能力等价的 scope 列表写在 `tracker.token_scope_requirements` 配置中。
- scope 不足：reviewer 直接进 `decision = cannot_review` reason
  `reviewer_cannot_review`，AgentReport.lastError 包含缺失 scope 列表与
  修复指引（hint），dashboard 给出指引。
- 不引入独立 reviewer bot token；如果未来需要分离审计身份，作为 P1 在
  workflow YAML 增加 `roles.reviewer.token_env` 覆写。
- 所有 token / secret / `tracker.token_env` 的值在 AgentReport、event
  store、dashboard 上都被 redaction。
- 不在 prompt 里暴露 token；reviewer agent 通过 orchestrator-side
  `gitlab.note_inline` tool 完成 push，token 不下发到 Codex run 上下文。

#### 16.1 agent 未启动场景下 AgentReport 的写入约定

当 reviewer 因 scope probe 失败 / prompt template 缺失 / prompt 渲染失败等
原因**未启动 Codex run**时，orchestrator 仍写一份 reviewer AgentReport：

- `runId = null`
- `promptTemplateHash = null`（probe 阶段尚未确定具体 hash）
- `startedAt` = probe / 渲染触发时刻
- `status = failed`
- `decision = cannot_review`
- `confidence = 0`
- `risks = []`、`evidenceRequest = []`、`findings = []`、`inlineComments = []`
- `mrPublication.status = skipped_by_config`
- `lastError.code` ∈ `scope_insufficient` / `prompt_template_missing` /
  `prompt_render_failed`
- `lastError.hint` 包含缺失 scope 列表 / 文件路径 / 修复指引

同样规则适用于 test_evidence 在 agent 未启动场景下的失败：写一份带
`runId = null` 的 AgentReport，`status = failed`、`testEvidence.evidenceItems = []`、
`testEvidence.baselineEvidence = null`、`lastError.code` 区分原因。

## 17. UI / dashboard

V4.6 在现有 dashboard 里做最小化改动：

### 17.1 Task detail 顶部 pipeline progress bar

- 三段 step indicator：Coder / Reviewer / Evidence。
- 状态表达双重编码（颜色 + 文本 label + 图标）：
  - 未开始：浅色 + "Pending"
  - 进行中：进度色 + spinner + "Running 03:42"
  - 完成：成功色 + "Done" + 已用时
  - 失败：danger 色 + 图标 + 文本 reason（"reviewer unavailable" 等）
  - 跳过：低饱和 + "Skipped (recipe / failed dependency)"
- 当前 step 显示 elapsed 时间，每 10 秒刷新。
- pipeline 进入 `awaiting_human_review` 时整条 bar 高亮 + 提示
  "AI pipeline 完成，请进入 human review"。
- 遵循 `ui-ux-pro-max` 的 `color-not-only`、`progressive-disclosure`、
  `error-clarity` 规则。

### 17.2 AgentReport tab

Task detail 下方新增三 tab：Coder / Reviewer / Evidence。

- **Coder tab**：复用 V4.3 已有 RunReportArtifact 视图（diffSummary、
  buildStatus、testStatus、lastError）。
- **Reviewer tab**：
  - summary（markdown 渲染）
  - decision badge + confidence
  - risks list
  - findings table（severity / category / message / locationHint）
  - inline comments preview（file / line / message / suggestedFix）
  - MR publication status banner（pending / published / publish_failed / skipped_by_config / revoked）
  - "撤回 ai-review" 按钮的可见 / 可点规则：
    - 当 `AgentReport.status ∈ {complete, incomplete, failed, cancelled}` 且
      `mrPublication.status = published` 时，按钮**可用**。
    - 当 `mrPublication.status ∈ {pending, publish_failed, revoked, skipped_by_config}`
      时，按钮 **disabled**，tooltip 解释原因（"尚未推送 / 推送失败请先重试 /
      已撤回 / workflow 配置 publish_to_mr=false"）。
    - 撤回成功后 banner 切换到 `revoked`，按钮 disabled。
- **Evidence tab**：
  - baseline evidence 卡片
  - 每条 evidenceRequest 对应一条 evidenceItem，渲染 status + artifact
    download link（截图缩略图、Playwright trace 链接、CI log 摘要）
  - evidenceStatus banner（complete / partial / unavailable）

### 17.3 Recipe override

plan-accept 页面（V4.1 已有）在每个 task 行旁加 recipe 下拉：
`Default / Full pipeline / Coding + Reviewer / Coding only`。下拉默认值
为 workflow YAML 的 `default_recipe`。

进入 `ready` 状态后，Task detail 顶部 pipeline progress bar 上方仍展示
recipe 标签 + "调整"按钮（仅在 task 状态 ∈ `{ planned, blocked_by_dependency,
ready }` 时显示）；点击后弹 inline 编辑器，调用 §18.1 的 recipe-override
endpoint。pipeline 进入 `running_coding` 后按钮 disabled，tooltip
解释 "coding step 已启动，不可改 recipe"，与 §18.1 的 409 `recipe_override_locked`
对应。

### 17.4 Reports 页面（V4.4）扩展

- 在 V4.4 现有 success rate 指标基础上增加 by-role 切片：
  - `coder.success_rate` = `count(coder.status = complete) / total_coder_attempts`
  - `reviewer.approve_rate` = `count(decision = approve_with_comments) / count(decision != null)`
  - `reviewer.cannot_review_rate` = `count(decision = cannot_review) / count(decision != null OR status = failed)`
  - `reviewer.unavailable_rate` = `count(reviewer.status = failed AND lastError.code ∈ {reviewer_unavailable, runner_unavailable}) / count(reviewer_attempted)`
  - `test_evidence.evidence_complete_rate` = `count(testEvidence.status = complete) / count(test_evidence_attempted)`
  - `test_evidence.partial_rate` = `count(PipelineRun.status = partial) / count(pipelines_with_test_evidence)`
- 失败模式表格新增 `role` 列：每个 failure pattern 显示集中在哪个角色。
- drill-down 增加 `agentReportId` link，跳转到 AgentReport tab。

### 17.5 Improvements 页面（V4.5）扩展

- V4.5 ImprovementRecommendation 的 `scope.target` 新增枚举
  `role_configuration`：建议改 workflow YAML 的 `roles.<role>` 节点。
- patch preview 支持 role profile 字段的 inert diff（参考 V4.5
  existing patch-preview 实现，加 sandbox 路径白名单包含 workflow YAML）。

### 17.6 i18n

新增中英文 key（完整列表，保持与 §8.1 / §8.4 / §8.2 mrPublication / §7.3 reason code 一一对应）：

- `pipeline.role.coder`, `pipeline.role.reviewer`, `pipeline.role.test_evidence`
- `pipeline.status.running_coding`, `running_reviewer`, `running_test_evidence`,
  `awaiting_human_review`, `awaiting_rework`, `partial`, `failed`, `cancelled`
- `reviewer.decision.approve_with_comments`, `request_changes`, `cannot_review`
- `evidence.status.complete`, `partial`, `skipped_by_recipe`, `unavailable`
- `mr.publish.status.pending`, `published`, `publish_failed`, `skipped_by_config`, `revoked`
- `roleFailure.coding_failed`, `reviewer_unavailable`, `reviewer_requested_changes`,
  `reviewer_cannot_review`, `evidence_unavailable`, `evidence_partial`,
  `sandbox_violation`, `runner_unavailable`, `pipeline_init_failed`,
  `role_profile_invalid`, `storage_full`, `redaction_failed`
- `pipeline.action.revoke_ai_review`
- `pipeline.action.retry_role` / `pipeline.action.skip_role` / `pipeline.action.replan_pipeline`
- `pipeline.recipe.full_pipeline`, `coding_plus_reviewer`, `coding_only`

## 18. API

orchestrator HTTP API 新增以下 endpoints。错误响应沿用 V4.5 已建立的
`{ code, message, details? }` 结构。

### 18.1 PipelineRun

- `GET /api/work-items/:wid/tasks/:tid/pipeline`
  - 返回当前 TaskNode 上最新的 PipelineRun + 关联 AgentReport summary。
  - 404 当 task 不存在；200 + `pipelineRun: null` 当尚未创建。
- `GET /api/work-items/:wid/tasks/:tid/pipelines`
  - 返回该 task 上所有 PipelineRun 的历史列表（含 supersede 关系）。
- `POST /api/work-items/:wid/tasks/:tid/pipeline/recipe-override`
  - body: `{ recipe }`。允许 task 状态 ∈ `{ planned, blocked_by_dependency, ready }`；
    进入 `running_coding` 或之后返回 409 `recipe_override_locked`。
  - 写入 PipelineRun.recipeSource = `operator_override`（PipelineRun 在
    `running_coding` 之前由 orchestrator 创建为 draft；在 `ready` 阶段调用本
    endpoint 只更新尚未启动的 PipelineRun.recipe）。

### 18.2 AgentReport

- `GET /api/agent-reports/:id`
  - 404 当不存在；与 V4.5 detail route 统一约定。
- `GET /api/work-items/:wid/tasks/:tid/agent-reports`
  - 可选 query：`role`（`coder` / `reviewer` / `test_evidence`）、`include_superseded`。
  - 返回该 task 上的 AgentReport summary 列表，按 `createdAt` 倒序。供 §17.4
    drill-down 跳转使用。
- `GET /api/pipeline-runs/:id/agent-reports`
  - 返回该 PipelineRun 下所有 AgentReport summary，按 role 顺序。
- `POST /api/agent-reports/:id/revoke-ai-review`
  - 仅 reviewer AgentReport 允许；其他 role 返回 400 + `role_mismatch`。
  - 仅当 `mrPublication.status = published` 时允许；否则 409 + `not_revocable`。
  - 触发 MR notes 删除 + AgentReport.mrPublication.status = `revoked`。
- `POST /api/agent-reports/:id/retry`
  - 重新跑该角色的 step；orchestrator 创建新的 AgentReport，旧的保留
    并互相 supersede 引用。reviewer / test_evidence 单角色重跑不创建新
    PipelineRun；coder 重跑会创建新 PipelineRun（见 §18.1）。
- `POST /api/agent-reports/:id/skip`
  - 跳过该角色的 step（仅 reviewer / test_evidence 允许）。

### 18.3 Workflow YAML 验证

- `GET /api/workflows/:workflowId/roles/validate`
  - dry-run 校验 `default_recipe` / `roles.*` 配置是否合法。
  - 返回 `{ valid: bool, errors[] }`，dashboard 在 workflow YAML 编辑时
    可调用。

## 19. 与 V4.3 / V4.4 / V4.5 的关系

### 19.1 与 V4.3 Evidence

- V4.3 的 evidence collector 接口由 test/evidence agent 调用。原有
  `apps/orchestrator/src/evidence/` 不需要重写，只新增"角色驱动"的
  调用方。
- WorkItemReport 渲染逻辑增加 `evidenceStatus` 字段输出（§8.4）。

### 19.2 与 V4.4 QualityAnalytics

- V4.4 的 `quality summary` aggregator 在采集时新增 by-role 切片：
  - `coder.success_rate`：(coder.status='complete') / total。
  - `reviewer.approve_rate`：(decision='approve_with_comments') /
    (decision !=  null)。
  - `test_evidence.evidence_complete_rate`：(status='complete') /
    (status != null)。
- `FailurePatternId` 新增：`reviewer_unavailable`、
  `reviewer_requested_changes`、`evidence_unavailable`、
  `sandbox_violation`。
- drill-down 增加按 role 过滤。

### 19.3 与 V4.5 ImprovementRecommendation

- `ImprovementRecommendation.scope.target` 枚举新增 `role_configuration`：
  `packages/shared-contracts` 中相关 TS 类型同步发版；老 recommendation 数据
  不需要 backfill（缺枚举值时不会损坏，仍以原 target 渲染）。
  V4.6 plan 同时负责把这个枚举升级落地。
- `suggestedChange` 指向 `workflow.roles.<role>.prompt_template` /
  `.tools[]` / `.timeout_seconds` 等。
- patch preview 沙箱白名单新增 workflow YAML 的角色节点路径
  （`workflow.roles.<role>.*`）。
- 当 V4.4 检测到 `reviewer_requested_changes` 在某 task type 上反复出现，
  V4.5 自动生成"是否需要改 coder.prompt_template"的 recommendation；evidence
  里直接引用对应的 reviewer AgentReport.findings[]。

### 19.4 与 V4.1 / V4.2

- V4.1 TaskPlan / WorkItem 不变。
- V4.2 TaskNode 状态机如 §8.0 扩展。dependency graph、retry / skip /
  replan 操作完全沿用。
- V4.1 Task execution contract（不创建 child Issue、父 Issue 不被单 task
  推进 label、MR 策略保守）继续生效。reviewer 推 inline comments 是
  在 task MR 上，不在父 Issue 上。

## 20. 关键不变量

- AgentReport 的**内容字段**写入后不可变（见 §5 详细列表）：`role`、
  `roleProfileId`、`promptTemplateHash`、`coder.*`、`reviewer.summary` /
  `decision` / `confidence` / `risks` / `evidenceRequest` / `findings` /
  `inlineComments`、`testEvidence.evidenceItems` / `baselineEvidence`。
  生命周期字段（`status`、`completedAt`、`lastError`、`evidenceLinks`、
  `redactedFields`、`mrPublication.{status, noteIds, publishedAt, lastError}`）
  在终态前可流转。retry / replan 创建新 AgentReport，以 supersedes /
  supersededBy 串成线性历史。
- reviewer 和 test/evidence 都**不能写任何源码**。Codex sandbox 是
  唯一硬约束，违规直接 task `failed`。
- pipeline 的状态机严格串行：不允许两个角色同时跑同一个 TaskNode。
- pipeline 不允许跳过 coding：`coding-only` 是有效 recipe，
  `reviewer-only` / `evidence-only` 不是。
- reviewer 的 decision 不直接 merge 或切 GitLab label；human-review 仍
  是唯一 merge gate。
- 所有 AI 写入 MR / dashboard / 报告 的内容都通过 redaction。
- workflow YAML 是 V4.6 配置的 single source of truth；orchestrator
  不在代码里 hardcode 角色定义（除 fallback 默认 profile 外）。
- 失败的 pipeline 不自动重跑；retry / replan 必须由 operator 显式触发。

## 21. 错误处理

补充 §14 之外的边界：

- **Codex app-server 启动失败**：写 `runner_unavailable` event，
  PipelineRun.status = `failed`。所有 task `failed` reason `runner_unavailable`。
- **prompt template 文件缺失**：role_profile_invalid，TaskNode 停在 `ready`，
  dashboard 提示 workflow YAML 错误。
- **token redaction 失败**：被视为 critical bug，写 `redaction_failed`
  event 并阻止 publish（fail-closed）。
- **AgentReport 序列化失败**：fail-closed，PipelineRun.status = `failed`。
  这种情况通常意味着 contract 不一致，应触发 spec / shared-contracts
  审查。
- **磁盘空间不足**：写 `storage_full` event，TaskNode `blocked` reason
  `storage_full`。
- **GitLab rate-limit**：reviewer 写 note 时 429，记录 lastError；fail
  soft（同 §12 第 4 条）；MR publication backoff 跳过本次。
- **workflow YAML 包含已知未来字段**：忽略并 dashboard warn"未知字段
  X，可能是 V4.7+ 配置"。
- **redaction snippet 误伤**：保留 redactedFields 列表 + 原长度，让
  operator 能判断是否伤到关键信息。

### 21.1 event keys → V4.4 FailurePatternId 映射表

V4.6 新增 / 复用的 event keys 与 V4.4 QualityAnalytics 的 FailurePatternId、
dashboard event filter bucket 的对应：

| event key | TaskNode 终态 | PipelineRun 终态 | V4.4 FailurePatternId | dashboard filter bucket |
| --- | --- | --- | --- | --- |
| `pipeline_init_failed` | 仍 `ready` | n/a | `pipeline_init_failed` | configuration |
| `role_profile_invalid` | 仍 `ready` | n/a | `role_profile_invalid` | configuration |
| `runner_unavailable` | `failed` (coder) / `blocked` (reviewer 等) | `failed` | `runner_unavailable` | infrastructure |
| `sandbox_violation` | `failed` | `failed` | `sandbox_violation` | safety |
| `redaction_failed` | `blocked` | `failed` | `redaction_failed` | safety |
| `storage_full` | `blocked` | n/a | `storage_full` | infrastructure |
| `reviewer_unavailable` | `blocked` | `failed` | `reviewer_unavailable` | agent-quality |
| `reviewer_cannot_review` | `blocked` | `failed` | `reviewer_cannot_review` | configuration |
| `reviewer_requested_changes` | `needs_rework` | `awaiting_rework` | `reviewer_requested_changes` | code-quality |
| `evidence_unavailable` | `awaiting_human_review` | `partial` | `evidence_unavailable` | agent-quality |
| `evidence_partial` | `awaiting_human_review` | `partial` | `evidence_partial` | agent-quality |
| `coding_failed` | `failed` | `failed` | `coding_failed` | code-quality |

`dashboard filter bucket` 列对应 §17.4 Reports 页面按 bucket 的过滤器；
`configuration` / `infrastructure` / `safety` / `agent-quality` / `code-quality`
五桶。 V4.5 在生成 ImprovementRecommendation 时按 bucket 选择目标面
（`configuration` → role profile / workflow YAML；`code-quality` → coder prompt 等）。

## 22. 测试策略

### 22.1 Contract tests

- `AgentReport`（每个 role 独立）。
- `PipelineRun`。
- `WorkItemReport.taskSummaries[]` 新字段。
- 重点：状态枚举、必填字段、版本兼容、JSON round-trip。

### 22.2 Orchestration tests（`apps/orchestrator/src/agents/__tests__/`）

- recipe 解析：default / per-task override / 未知 recipe 报错。
- pipeline 串行推进：mock Codex run，coding success → 自动起 reviewer →
  自动起 test/evidence；每步成功 / 失败都覆盖。
- TaskNode 状态机：每个 reason code 覆盖一次状态转换。
- supersede：retry / replan 后 AgentReport 历史串成线性，未来查询走最新。
- workflow YAML schema：缺 `roles:` fallback；缺 prompt template 报错；
  非法 sandbox 报错。

### 22.3 Reviewer findings / MR publisher tests

- findings → inline comments 转换：severity threshold、
  max_inline_comments 截断、prefix 注入。
- MR publish flow：fake GitLab，验证 1 主 note + N inline 的语法。
- revoke flow：先 publish 再 revoke，验证 noteIds[] 删除。
- token scope 不足 → `cannot_review` 转换。
- redaction：token / 凭据 / URL 在 publish 前必须被替换。

### 22.4 test/evidence agent tests

- evidence_request 解析与 evidence_items 落盘。
- baseline evidence 在 evidence_request 为空时仍写。
- sandbox 违规：写源码 → fail，写 evidence 目录 → success。
- Playwright walkthrough 失败 → AgentReport.testEvidence.evidenceItems[]
  标 `failed` 但不阻塞 pipeline。

### 22.5 API tests（`apps/orchestrator/src/server/__tests__/`）

- 新增的 `GET /api/work-items/:wid/tasks/:tid/pipeline` 等 routes 全部
  覆盖 200 / 404 / 400 / 409 路径。
- recipe-override 在非 `ready` 状态下返回 409。
- revoke-ai-review 在非 reviewer role 返回 400 `role_mismatch`。

### 22.6 UI tests（dashboard component tests）

- pipeline progress bar 渲染：每个状态 + 双重编码 + dark mode。
- AgentReport tab 切换。
- Recipe 下拉 default 值。
- Reviewer tab 撤回 ai-review 按钮的 happy path 与失败提示。
- i18n key 渲染覆盖中英文。

### 22.7 E2E tests

- 假 Codex + 假 GitLab：
  - 完整 pipeline（coder approve → reviewer approve → evidence collected →
    awaiting_human_review）。
  - reviewer request_changes → TaskNode needs_rework → operator 触发
    coder retry → new PipelineRun → 第二轮 reviewer approve。
  - test/evidence 部分失败 → awaiting_human_review + WorkItemReport
    evidenceStatus = partial。
  - reviewer cannot_review (token scope) → TaskNode `blocked`，dashboard
    指引 fix token；带 §16.1 约定的 AgentReport 字段。
  - reviewer agent 试图写源码 → Codex sandbox 拒绝 → AgentReport
    `failed` lastError.code = `sandbox_violation` → TaskNode `failed`
    + dashboard 提示。
  - pipeline 在 reviewer 进行中被 operator cancel → AgentReport
    `cancelled` → TaskNode `needs_rework` + `last_cancelled_at` 写入
    → orchestrator auto_advance 跳过，直到 operator 显式触发新 pipeline。
  - recipe = `coding_only`，pipeline 仅创建 coder AgentReport 即进入
    `awaiting_human_review`，WorkItemReport.evidenceStatus = `skipped_by_recipe`。

## 23. UI / 报告体验补充

- 默认 light + dark mode 都测：reviewer findings 表格颜色编码不能在
  dark mode 失效。
- 进度条按 `ui-ux-pro-max` 的 `progressive-disclosure` 原则：默认折叠
  详细信息，hover / click 展开。
- Reviewer 的 inline comments 列表使用 `truncation-strategy`：超长
  message 截断 + tooltip 展示全文。
- MR publication banner 使用 `success-feedback` / `error-clarity`：
  published 短暂闪动 + 持久 badge；publish_failed 显示 retry button。
- recipe 下拉旁加 helper tooltip 解释每种 recipe 的含义和耗时影响，
  符合 `input-helper-text`。

## 24. V4.6 验收标准

V4.6 至少满足：

1. **三角色 pipeline 跑通**：一个 task 走完 coding → reviewer →
   test/evidence，三份 AgentReport 齐全，TaskNode 进入
   `awaiting_human_review`。
2. **Recipe 生效**：workflow YAML `default_recipe = full_pipeline` 与
   `coding_only` 都能正确解析；plan-accept 时 per-task override 改写
   `coding+reviewer` 后只产生 coder + reviewer 两份 AgentReport。
3. **AgentReport 数据完整**：reviewer.decision、confidence、risks、
   evidenceRequest、findings、inlineComments、mrPublication 字段都按
   contract 写入；schema 通过 contract tests。
4. **MR 联动护栏**：reviewer 的 1 主 note + N inline 推到 fake GitLab
   MR；severity_threshold / max_inline_comments / prefix /
   revoke / redaction 五条都通过 unit + E2E 验证。
5. **失败 reason 显式**：reviewer_unavailable / reviewer_requested_changes
   / reviewer_cannot_review / evidence_unavailable / coding_failed /
   sandbox_violation 各自的 dashboard 展示和 V4.4 quality summary 切片
   都能跑通；by-role 切片至少包括 `coder.success_rate`、
   `reviewer.approve_rate`、`reviewer.cannot_review_rate`、
   `reviewer.unavailable_rate`、`test_evidence.evidence_complete_rate`、
   `test_evidence.partial_rate`。
6. **dashboard 体验**：Task detail pipeline progress bar、AgentReport
   三 tab、recipe 下拉、revoke ai-review 按钮、i18n 中英文都覆盖。
7. **E2E 闭环**：fake GitLab + fake Codex 跑出完整 pipeline、reviewer
   request_changes 返工、test/evidence partial 三个核心场景。
8. **V4.4 / V4.5 联动**：by-role success rate、failure pattern
   `reviewer_*` / `evidence_*` 出现在 Reports；V4.5
   `scope.target = role_configuration` 在 patch preview 中可生成 inert
   diff。
9. **不破坏现有 V4.1-V4.5**：旧 task store / WorkItemReport / Reports /
   Improvements 在缺 V4.6 数据时正常退化展示。
10. **凭据安全**：token redaction 在所有写入路径生效；scope 不足时
    reviewer 不静默失败而是显式 `cannot_review` + dashboard 指引。

## 附录 A：与 V4 总 spec 的对应

| V4 总 spec §7 V4.6 能力 | 本 spec 章节 |
| --- | --- |
| coder agent、reviewer agent、test/evidence agent 角色分工 | §5–§7、§8、§11、§13 |
| 支持 Claude Code、内部 coder agent 等 runner adapter 的产品语义 | **推延到 V4.7+**（§3、§4） |
| 每个 agent 产物进入统一 report / audit 模型 | §8、§9 |
| 初期仍可串行或有限并行，生产级 worker 调度留给 V3 | §3、§7（仅串行）、§15 |

## 附录 B：迁移指引（V4.5 → V4.6）

P0 不要求 operator 手工迁移：

- 不存在 V4.6 数据时 dashboard / orchestrator 退化展示 V4.5 视图。
- workflow YAML 不写 `roles:` 时 fallback 到 hardcoded 内置 role
  profile，dashboard 提示"建议显式配置 roles"。
- WorkItemReport 旧版本无 `evidenceStatus` 字段时按 `unavailable`
  处理。

正式上线建议：

1. 启用 V4.6 后先用 `coding-only` recipe 跑一个 sprint，验证 pipeline 编排
   稳定；
2. 再切到 `coding+reviewer`，关注 reviewer publish_to_mr 的 false positive；
3. 最后切到 `full_pipeline`，让 test/evidence 介入。

## 附录 C：未来工作（V4.7+ / V3）

- runner adapter contract（支持多 runner，包括 Claude Code、Cursor、
  内部 coder agent）。
- 并发 pipeline（fan-out reviewer / test-evidence）。
- agent-to-agent 协作（reviewer 可在线问 coder "你为什么这样改"）。
- 多 worker 调度、worker 池、生产级超时 / 重试策略。
- LLM-driven failure pattern 分类。
- 自动 evidence 重采集（CI 重跑 + 截图）。
- 角色级 RBAC（不同 operator 可触发不同 role 的 retry）。
