# IssuePilot V4 智能研发工作台总设计

日期：2026-05-17
状态：待用户评审

关联文档：

- `docs/superpowers/specs/2026-05-11-issuepilot-design.md`
- `docs/superpowers/specs/2026-05-15-issuepilot-v2-team-operable-design.md`
- `docs/superpowers/specs/2026-05-16-issuepilot-v25-command-center-design.md`
- `README.md`
- `README.zh-CN.md`

## 实施计划

- V4.1 Workflow Spine：`docs/superpowers/plans/2026-05-17-issuepilot-v4-1-workflow-spine.md`
  （已落地，覆盖 §17 V4.1 验收标准）。
- V4.2 Task Graph：`docs/superpowers/plans/2026-05-17-issuepilot-v4-2-task-graph.md`
  （已落地，覆盖 §7 V4.2 + §12.3 + §12.4 + §14.2 + branch chaining）。
- V4.3 Review Packet + Evidence：`docs/superpowers/plans/2026-05-17-issuepilot-v4-3-review-packet-evidence.md`
  （已落地，覆盖 §7 V4.3 + §14.3 + §14.4 + §15）。
- V4.4 Quality Analytics：
  `docs/superpowers/specs/2026-05-18-issuepilot-v4-4-quality-analytics-design.md`
  （已落地，覆盖 §7 V4.4 + Reports / Process Insights 第一版）。
- V4.5 Workflow / Skills Improvement Loop：
  `docs/superpowers/plans/2026-05-18-issuepilot-v4-5-improvement-loop.md`
  （**实施已完成**，覆盖 V4.5 recommendation queue、patch preview、human apply
  gate、team project isolation、fail-closed 和 acceptance 记录；验收清单见
  `docs/superpowers/plans/2026-05-18-issuepilot-v4-5-improvement-loop-acceptance.md`）。
- V4.6 Multi-Agent Collaboration：
  `docs/superpowers/specs/2026-05-19-issuepilot-v4-6-multi-agent-collaboration-design.md`
  （**实施已完成**，覆盖 §7 V4.6 + Coder/Reviewer/TestEvidence 三角色 pipeline + AgentReport
  中间层 + recipe / publish-revoke / cancel 状态机 / V4.4 quality byRole 切片
  / V4.5 role_configuration 改进目标 / dashboard pipeline & recipe & revoke
  UI；实施计划见 `docs/superpowers/plans/2026-05-19-issuepilot-v4-6-multi-agent-collaboration.md`，
  验收清单见 `docs/superpowers/plans/2026-05-19-issuepilot-v4-6-multi-agent-collaboration-acceptance.md`）。
- V4.7 Runner Adapter Contract：
  `docs/superpowers/specs/2026-05-20-issuepilot-v4-7-runner-adapter-contract-design.md`
  （**实施已完成**；覆盖 runner contract、本地静态 runner registry、
  `codex_app_server` adapter 迁移、capability fail-closed 和 AgentReport
  runner 追溯字段；实施计划见
  `docs/superpowers/plans/2026-05-20-issuepilot-v4-7-runner-adapter-contract.md`，
  验收清单见
  `docs/superpowers/plans/2026-05-20-issuepilot-v4-7-runner-adapter-contract-acceptance.md`）。
- V4.8 第二 Runner 自用验证：
  `docs/superpowers/specs/2026-05-21-issuepilot-v4-8-second-runner-dogfood-design.md`
  （**实施已完成**，覆盖 `claude_code` 第二本地 runner、kind-specific
  options、mixed-runner pipeline、daemon / team daemon wiring、dashboard runner
  trace 和 acceptance 记录；真实 Claude Code CLI 自用验证仍需本机 CLI / 登录态确认；
  实施计划见
  `docs/superpowers/plans/2026-05-21-issuepilot-v4-8-second-runner-dogfood.md`，
  验收记录见
  `docs/superpowers/plans/2026-05-21-issuepilot-v4-8-second-runner-dogfood-acceptance.md`）。
- V4.9 智能 Review 工作流：
  `docs/superpowers/specs/2026-05-21-issuepilot-v4-9-intelligent-review-workflow-design.md`
  （**实施已完成，待用户验收**；目标是把 V2 review feedback sweep 和 V4.6 reviewer
  findings 升级为可审计的 `ReviewReworkPlan`，由 operator 确认后注入下一轮
  `ai-rework` agent 输入；实施计划见
  `docs/superpowers/plans/2026-05-21-issuepilot-v4-9-intelligent-review-workflow.md`，
  验收记录见
  `docs/superpowers/plans/2026-05-21-issuepilot-v4-9-intelligent-review-workflow-acceptance.md`）。
- V4.10 Release Lock / Dog-food Closure：
  `docs/superpowers/specs/2026-05-22-issuepilot-v4-10-release-lock-design.md`
  （设计待评审；目标是在进入 V3 前收口 V4.1-V4.9：完成 V4.9 用户验收与
  review-rework dog-food、确认 V4.8 第二 runner 真实 CLI dog-food 状态、明确
  single daemon / team daemon 能力矩阵，并同步 README / CHANGELOG / V4 总 spec
  的 roadmap 状态）。

## 1. Roadmap 决策

IssuePilot 接下来先做 V4，再做 V3。这里的 V3 / V4 是能力域编号，不表示
必须按数字顺序交付。

当前路线原则是：**先把本地版 / 团队机器版的研发流程能力打磨到足够完备，
再做生产可用版本**。

因此：

1. **V4 智能研发工作台先做**。V4 运行在现有 V2.x runtime 上，继续复用本地
   daemon、team config、Command Center、RunReportArtifact、GitLab note、
   workspace 和 event store。V4 的任务是补齐研发流程智能和体验闭环。
2. **V3 生产化执行平台后做**。V3 负责把 V2.x runtime 和 V4 已验证的流程能力
   平台化：登录、权限、预算、生产部署、Postgres、审计、观测、多 worker、
   production sandbox 和生产合并策略。

V4 不引入 `V4 preview` / `V4 Pro` 这样的中间版本。V4 就是下一阶段产品工作；
V3 是后续生产化承载层。

## 2. V4 / V3 边界

### V4 范围

- 大 Issue 理解与拆解。
- 子任务计划、依赖和执行顺序。
- 多个现有 IssuePilot run 的编排和汇总。
- 大 Issue 级 Review Packet。
- 验收材料自动生成和索引。
- 质量指标、失败模式和流程洞察。
- workflow / skills / prompt / 项目规则改进建议。
- 多 agent / 多 runner 的产品语义设计。

### V3 范围

- 登录态和 RBAC。
- 企业权限、团队权限、管理员权限。
- Docker / Kubernetes production sandbox。
- 多 worker 调度平台。
- Postgres / centralized storage。
- 成本预算、配额和 approval policy。
- GitLab 审计、secret governance 和合规记录。
- OpenTelemetry、Grafana、Loki 或内部观测平台。
- 生产级自动 merge 策略。

### 约束

V4 可以增强流程智能，但不能提前把系统拖进生产平台化复杂度。例如：

- 可以设计多 agent 协作语义，但第一版仍可在单 daemon 中串行或有限并行执行。
- 可以生成质量指标，但先从本地 report store 聚合，不引入 Postgres。
- 可以提出 workflow / skills 改进建议，但不能静默修改配置或生产规则。

## 3. 产品目标

V4 把 IssuePilot 从“单 Issue 单 run 执行器”升级为“本地优先的智能研发工作台”。

IssuePilot 的长期愿景是做一个和 Harness Engineer 互补的研发流程层：

- **有 Harness Engineer 的项目**：Harness Engineer 继续负责项目内的工程规则、
  代码约束、验证矩阵、实现纪律和局部执行质量；IssuePilot 负责跨 Issue / 多 run
  的流程编排、状态管理、报告、证据、review feedback 和持续改进闭环。IssuePilot
  不复制或覆盖 Harness Engineer 的项目规则，而是把它们作为执行上下文和验收证据的一部分。
- **没有 Harness Engineer 的项目**：IssuePilot 仍然可以直接使用。此时
  `issuepilot-config/` 的 project facts、workflow profile、repo-local rules 和
  skills 构成最小工程约束层；V4 的拆解、编排、Review Packet 和 evidence 能独立工作。

V4 要帮助团队推进一个真实研发任务的完整流程：

1. 理解一个大 Issue 的意图、约束和验收标准。
2. 拆成可执行子任务，并标出依赖和推荐顺序。
3. 基于子任务执行多个 run，保留每个 run 的报告、风险和证据。
4. 汇总成面向 reviewer / tech lead 的总 Review Packet。
5. 从运行结果中发现流程问题，给出 workflow / skills / 项目规则改进建议。

## 4. 用户

| 用户 | 核心问题 | 主入口 |
| --- | --- | --- |
| Operator / Maintainer | 任务怎么拆、哪些子任务在跑、哪里卡住、下一步做什么？ | Work Items / Task Queue |
| Reviewer | 子任务改了什么、验证了什么、风险在哪里、是否可以 review？ | Parent Review Packet / Evidence |
| Tech Lead | 整体质量如何，返工和失败集中在哪里，流程要怎么改？ | Reports / Process Insights |

## 5. 非目标

V4 不做：

- 登录、RBAC、企业权限。
- Kubernetes / Docker 生产部署和 production sandbox。
- Postgres / centralized storage。
- 生产级多 worker 调度平台。
- 成本预算、配额和 approval policy。
- 企业审计平台。
- 默认自动 merge。
- 通用 Linear / Jira 替代品。
- 完全自动项目经理；人仍然决定拆解是否接受、是否执行、是否 merge。

## 6. 设计选项

### 方案 A：端到端 Workflow Spine（采用）

第一阶段先做一条最小主干：大 Issue → 子任务 → accepted plan → 子任务 run →
总 Review Packet。每个能力只做最小可用深度，但流程完整。

优点：

- 最符合 local-first 完备度优先的路线原则。
- 很快能 dog-food。
- 后续每个阶段都能沿着主干加深。

缺点：

- 第一版每个模块都不会特别深。

### 方案 B：Planner-first

先把大 Issue 理解、拆解、依赖图和执行计划做深，执行、验收和质量分析先弱化。

优点：基础规划模型扎实。

缺点：容易变成“会规划但闭不了环”，短期产品感弱。

### 方案 C：Review/Evidence-first

先强化每个 run 的 Review Packet、风险总结和验收材料，再接大 Issue 拆解。

优点：立刻提升交付可信度。

缺点：没有解决 V4 的核心变化：从单 Issue 单 run 走向多子任务编排。

## 7. 阶段结构

V4 原按 6 个中阶段设计；V4.6 落地后新增 V4.7 作为 runner adapter
contract 收口阶段，V4.8 用第二本地 runner 自用验证该 contract；V4.9 把 review
feedback 升级成可审计返工计划；V4.10 作为进入 V3 前的 release lock /
dog-food closure。
V4.1 必须先做；V4.2-V4.10 可根据自用验证反馈调整顺序。

### V4.1：Workflow Spine

目标：从一个大 Issue 出发，跑通最小端到端闭环。

能力：

- 读取大 Issue，生成 2-5 个子任务草案。
- 每个子任务包含标题、目标、范围、依赖和建议验证方式。
- Operator 可以接受、编辑、删除、重排或跳过子任务。
- IssuePilot 根据 accepted plan 创建执行计划。
- 子任务可以逐个触发现有 IssuePilot run。
- 最终生成一个总 Review Packet，汇总每个子任务的状态、验证、风险和 follow-up。

成功标准：

- 一个复杂 Issue 能从“未拆解”走到“多个子任务 run + 汇总报告”。
- 不要求拆解算法很强，但要求流程完整、状态可追踪、报告能看懂。
- V4.1 只实现 workflow spine 所需的最小能力；V4.2-V4.9 的深度图形视图、
  长期质量趋势、自动改进建议、多 agent 分工和 runner contract 均在后续阶段展开。

#### V4.1 Task execution contract

V4.1 中，`TaskNode` 到现有 IssuePilot run 的映射必须遵守以下契约：

- **不创建 child GitLab Issue**。父 GitLab Issue 仍是唯一 tracker source of
  truth；子任务只存在于 IssuePilot 本地 WorkItem / TaskPlan / WorkItemReport 中。
- **每个 TaskNode 触发一个 synthetic task run**。run 复用现有 IssuePilot runner、
  workspace、event store 和 RunReportArtifact，但 prompt context 额外带上
  `workItemId`、`taskId`、task title、task goal、task scope、依赖摘要和建议验证方式。
- **V4.1 只自动执行 independent tasks**。`dependsOn` 为空、或依赖已由人工确认
  不需要共享代码状态的 task 才能进入 `ready`。需要继承上游代码变更的依赖链保持
  `blocked_by_dependency`，由 operator 合并上游 MR 后重试，或进入 V4.2 的
  dependency-aware branch chaining 设计。
- **默认一 task 一 branch / worktree，base 为 workflow `base_branch`**。branch 建议形态为
  `<branch_prefix>/<iid>-<task-slug>`，workspace 仍位于当前 IssuePilot workspace
  root 下；V4.1 不做多个 task 共享同一 branch，也不做从上游 task branch 派生
  下游 task branch。
- **GitLab note 以父 Issue 为落点**。V4.1 不为每个子任务新建 Issue，也不要求每个
  task 写独立 handoff note；父 Issue 最终写入或更新 WorkItem 级 handoff / summary
  note，dashboard 负责展示 task 粒度细节。
- **MR 策略保持保守**。每个 task run 创建或更新独立 MR。是否合并多个 task MR
  到一个总 MR 不属于 V4.1。
- **per-task run 不直接推进父 Issue workflow label**。synthetic task run 不允许把父
  Issue 从 `ai-running` 切到 `human-review`，也不允许因单个 task 失败直接把父 Issue
  切到 `ai-failed` / `ai-blocked`。父 Issue 的 handoff / failure / blocked / closing
  note 和 label transition 由 WorkItem 汇总阶段统一决定：所有必需 task 完成后才能
  进入 `human-review`；存在失败 / blocked task 时 WorkItem 保持 `partial` / `blocked`
  并等待 operator 决策。实现上 synthetic task run 必须绕过现有 per-run 父 Issue
  label writer，只允许 WorkItem 聚合阶段调用该 writer。
- **Evidence 通过 report 绑定**。子任务 evidence 不复制到 `TaskNode`；`TaskRunLink`
  指向 run/report，`WorkItemReport` 汇总各 task report 的 evidence index。
- **状态回写只影响本地 WorkItem**。子任务状态变化不直接改 GitLab label；父 Issue
  的 workflow label 仍由现有 IssuePilot run / human-review / rework 机制控制。

### V4.2：Task Graph

目标：把子任务从列表升级为任务图。

能力：

- 子任务之间支持 `blocks` / `depends_on` / `can_parallelize_with`。
- dashboard 展示 Task Graph 或分阶段队列。
- 支持推荐执行顺序。
- 支持子任务失败后的局部重试和跳过。
- 支持把某个子任务打回重新规划。

### V4.3：Review Packet + Evidence

目标：让 reviewer 能判断整个大 Issue 是否可以交付。

能力：

- 总 Review Packet 聚合所有子任务报告。
- 每个子任务有 diff summary、测试结果、风险、CI、review feedback。
- 自动生成并索引验收材料：截图、录屏、Playwright walkthrough、命令输出摘要。
- GitLab note、dashboard 和 Markdown export 使用同一个总报告渲染。
- 明确哪些是 AI 判断，哪些需要人确认。

### V4.4：Quality Analytics

目标：从多 run / 多子任务中看到质量趋势。

能力：

- 成功率、失败率、返工率、CI pass rate、review 命中率。
- 按 project / workflow / task type 聚合。
- 识别常见失败模式：测试缺失、需求不清、权限不足、环境问题、review 返工。
- Reports 页面展示趋势和 drill-down。

### V4.5：Workflow / Skills Improvement Loop（实施已完成）

目标：让 IssuePilot 能从失败中提出流程改进建议。

能力：

- 根据失败模式推荐 workflow front matter、prompt、skills、项目规则调整。
- 每条建议有证据来源：哪些 run、哪些失败、哪些 review comment。
- Operator 可以接受、拒绝或延后建议。
- `accept` 只记录 operator 决策，不直接静默改文件；`patch-preview` 单独生成
  inert diff，并通过 sandbox / stale source / missing target fail closed。

### V4.6：Multi-Agent / Multi-Runner Collaboration（实施已完成）

目标：在本地优先模型中引入多角色协作，但不做生产 worker 平台。

能力（已落地）：

- Coder → Reviewer → Test/Evidence 三角色 pipeline，单一 Codex app-server
  + 多 role profile 驱动；recipe 三档（`full_pipeline` /
  `coding_plus_reviewer` / `coding_only`），允许 operator 启动前 override。
- 每个 agent 产出独立 `AgentReport` 落盘（supersede 双向链），统一进入
  `PipelineRun` 模型，由 dashboard `PipelineProgress` / `AgentReportTabs`
  渲染。
- Reviewer 默认把 findings + inline comments 推送到 GitLab MR；失败
  fail soft（不阻断 pipeline，dashboard 显示 publish_failed / scope_insufficient）；
  支持 `RevokeAiReviewButton` 幂等撤回。
- Cancel 写入 `last_cancelled_at`，下一次 startPipeline 自动清零并恢复
  auto_advance。
- V4.4 quality 增加 13 个 V4.6 失败模式 + `byRole` 切片；V4.5 改进环增加
  `role_configuration` target kind。
- 实施细节见
  `docs/superpowers/specs/2026-05-19-issuepilot-v4-6-multi-agent-collaboration-design.md`
  / `docs/superpowers/plans/2026-05-19-issuepilot-v4-6-multi-agent-collaboration.md`
  / `docs/superpowers/plans/2026-05-19-issuepilot-v4-6-multi-agent-collaboration-acceptance.md`。

### V4.7：Runner Adapter Contract（实施已完成）

目标：把 V4.6 中写死的 Codex app-server lifecycle 抽成稳定 runner adapter
contract，但不接入第二个真实 runner，也不做生产 worker 平台。

能力（已落地）：

- `packages/shared-contracts` 新增 `RunnerDescriptor`、`RunnerCapability`、
  `RunnerRunInput`、`RunnerResult`、`RunnerError` 和 runner artifact contract。
- `packages/workflow` 支持本地静态 `runners:` registry 与
  `roles.<role>.runner` 引用；开发期默认 runner 是 `codex_app_server`。
- `apps/orchestrator` 新增 runner registry / resolver，并把现有 Codex
  lifecycle 迁移为 `codex_app_server` adapter。
- adapter 只输出标准 `RunnerResult`；Coder / Reviewer / TestEvidence agent
  factory 继续负责生成 role-specific `AgentReport`。
- capability missing / unknown runner fail closed；`AgentReport` 新增
  `runnerId`、`runnerKind`、`runnerRunId?` 追溯字段。
- 不做动态 discovery、Claude Code / 内部 agent adapter、多 worker 调度、
  fan-out 并发或生产 sandbox。

设计 spec：
`docs/superpowers/specs/2026-05-20-issuepilot-v4-7-runner-adapter-contract-design.md`。
实施计划：
`docs/superpowers/plans/2026-05-20-issuepilot-v4-7-runner-adapter-contract.md`。
验收清单：
`docs/superpowers/plans/2026-05-20-issuepilot-v4-7-runner-adapter-contract-acceptance.md`。

### V4.8：第二 Runner 自用验证（已实现，真实 CLI dog-food 待确认）

目标：在 V4.7 Runner Adapter Contract 上接入第二个真实本地 runner，先验证
contract，而不是提前建设 V3 runner 平台。

能力（已实现）：

- `RunnerKind` 扩展 `claude_code`，同步 shared contracts、workflow parser /
  resolver、dashboard i18n 和 `AgentReport.runnerKind` 展示。
- 新增 `claude_code` adapter，adapter 只输出标准 `RunnerResult` /
  `RunnerEvent`，不直接写 `AgentReport`、GitLab note 或 pipeline store。
- workflow 仍用静态 `runners:` registry；最小自用验证是
  `coder=codex_app_server`、`reviewer=claude_code`、
  `test_evidence=codex_app_server`。
- `claude_code` 默认只用于 reviewer read-only role；coder role 需要证明
  workspace write sandbox 可控后才能显式 opt-in。
- 不做 dynamic discovery、worker pool、remote runner service、SDK、自动 runner
  selection 或 production sandbox。
- 默认 gate 和 code review follow-up gate 已通过；真实 Claude Code CLI 自用验证
  仍待本机 CLI / 登录态确认，因此作为 dog-food follow-up 保留。

设计 spec：
`docs/superpowers/specs/2026-05-21-issuepilot-v4-8-second-runner-dogfood-design.md`。

实施计划：
`docs/superpowers/plans/2026-05-21-issuepilot-v4-8-second-runner-dogfood.md`。

验收记录：
`docs/superpowers/plans/2026-05-21-issuepilot-v4-8-second-runner-dogfood-acceptance.md`。

### V4.9：智能 Review 工作流（实施完成，待用户验收）

目标：把 V2 Review Feedback Sweep 收集到的人工 MR 评论、V4.6 reviewer agent
产出的 `ReviewerAgentReport.findings`、CI / evidence 状态和 task context 合并为
可审计的 `ReviewReworkPlan`，由 operator 确认后作为下一轮 `ai-rework` agent
输入。

能力（已实现）：

- 新增 `ReviewReworkPlan` / `ReviewReworkItem` shared contract，记录分类、
  优先级、目标文件、source refs、建议验证和状态。
- planner 从 `ReviewFeedbackSummary`、`ReviewerAgentReport.findings`、CI /
  evidence gaps 生成 draft plan，并按目标文件 / normalized title 去重。
- dashboard 在 Run Detail / Work Item Review Packet 展示返工计划，支持
  accept / dismiss / mark resolved。
- dispatch 在 accepted plan 存在时 prepend `## Review rework plan`；planner
  失败或未 accept 时保留 V2 `## Review feedback` fallback。
- `RunReportArtifact` / `WorkItemReport` / Quality Analytics 消费同一个
  review rework facts；V4.8 mixed runner reviewer report 的 source refs 保留
  `runnerKind`。
- 不做自动 merge、GitLab webhook 实时回流、自动改代码、discussion resolve
  双向同步或 V3 runner platform。

设计 spec：
`docs/superpowers/specs/2026-05-21-issuepilot-v4-9-intelligent-review-workflow-design.md`。

实施计划：
`docs/superpowers/plans/2026-05-21-issuepilot-v4-9-intelligent-review-workflow.md`。

验收记录：
`docs/superpowers/plans/2026-05-21-issuepilot-v4-9-intelligent-review-workflow-acceptance.md`。

### V4.10：Release Lock / Dog-food Closure（设计待评审）

目标：在进入 V3 生产化执行平台前，把 V4.1-V4.9 从“功能已实现”收口成“可以
对内试点”的状态。

能力：

- V4.9 用户验收闭环：用真实/准真实 review feedback、reviewer findings、CI /
  evidence context 证明 `ReviewReworkPlan` 能生成、accept、注入下一轮
  `ai-rework` prompt，并在 Run Detail、Parent Review Packet 和 Reports 中形成
  一致事实。
- V4.8 第二 runner dog-food：确认 `claude_code` CLI / 登录态是否可真实运行
  reviewer read-only role；若环境不可用，记录 blocker 和保守降级判断。
- single daemon / team daemon 能力矩阵：明确 V4.8 / V4.9 哪些能力已接入、
  哪些属于后续 multi-project 服务化 follow-up，避免 roadmap 过度承诺。
- 文档状态收口：同步 V4 总 spec、README 三语版本、CHANGELOG、V4.8 / V4.9
  acceptance 记录。
- 不新增智能功能、不做 V3 platform 能力、不静默修改 workflow / skills /
  prompt / 项目规则。

V4.10 的 team-mode 结论必须保守：`claude_code` runner registry 和 mixed-runner
contract wiring 可以 release-lock；V4.9 review workflow service 在 team daemon
中的完整 project-scoped binding 仍作为后续 multi-project 服务化 follow-up，不在
V4.10 中宣称已完成。

设计 spec：
`docs/superpowers/specs/2026-05-22-issuepilot-v4-10-release-lock-design.md`。

## 8. 架构

V4 不替换 V2.x runtime，而是在现有结构上新增一层 **Workflow Intelligence Layer**。

### 8.1 现有 V2.x Runtime

继续负责：

- GitLab Issue / labels / notes。
- workspace / mirror / branch。
- runner / Codex app-server lifecycle。
- event store。
- RunReportArtifact。
- dashboard API。

### 8.2 Workflow Intelligence Layer

新增 V4 核心能力：

- Issue decomposition。
- Task planning。
- Task orchestration。
- Evidence collection。
- Quality insights。
- Improvement recommendations。

这层不复制 run record，也不替代 existing report store；它围绕 WorkItem 和 TaskPlan
组织多个现有 run。

### 8.3 Command Center / Reports UI

扩展现有 dashboard：

- Work Items。
- Task Queue / Task Graph。
- Parent Review Packet。
- Evidence tab。
- Process Insights / Recommendations。

## 9. 数据模型

### 9.0 生命周期状态

V4.1 planning 前必须固定核心对象状态，避免实现时各 package 使用不同枚举。

| 对象 | 状态 | 含义 |
| --- | --- | --- |
| `WorkItem` | `planning` | 已创建本地 work item，正在生成或编辑 plan |
| `WorkItem` | `ready` | plan 已接受，存在可执行 task |
| `WorkItem` | `running` | 至少一个 task run 正在执行 |
| `WorkItem` | `partial` | 部分 task 成功，部分失败 / blocked / skipped |
| `WorkItem` | `completed` | 所有必需 task 完成并生成总报告 |
| `WorkItem` | `blocked` | 缺少信息、权限、依赖或人工决策 |
| `TaskPlan` | `draft` | AI 生成或 operator 正在编辑的 plan |
| `TaskPlan` | `accepted` | operator 接受，可进入执行 |
| `TaskPlan` | `rejected` | operator 拒绝，保留为历史版本 |
| `TaskPlan` | `superseded` | 被后续版本替换 |
| `TaskNode` | `planned` | 在 accepted plan 中，但依赖尚未判断 |
| `TaskNode` | `blocked_by_dependency` | 上游 task 未完成或失败 |
| `TaskNode` | `ready` | 可触发 run |
| `TaskNode` | `running` | 至少一个 linked run 正在执行 |
| `TaskNode` | `completed` | 当前 task 满足建议验证并产出 report |
| `TaskNode` | `failed` | run 失败，需要重试或重规划 |
| `TaskNode` | `blocked` | 缺少信息、权限或环境条件 |
| `TaskNode` | `needs_rework` | review / CI / operator 要求返工 |
| `TaskNode` | `skipped` | operator 明确跳过 |
| `WorkItemReport` | `draft` | 正在聚合或部分数据缺失 |
| `WorkItemReport` | `partial` | 可读但存在失败 / blocked / skipped task |
| `WorkItemReport` | `complete` | 所有必需 task 均已汇总 |
| `WorkItemReport` | `incomplete` | report 依赖的 run / evidence 缺失 |

父 GitLab Issue label 在 V4.1 中只由 WorkItem 聚合状态驱动：

| 事件 | WorkItem 状态 | 父 Issue label 行为 |
| --- | --- | --- |
| 点击 `Plan work item` | `planning` | 不改 label |
| 接受 plan | `ready` | 可保持原 label；开始执行时切 `ai-running` |
| task run 开始 | `running` | 保持 `ai-running` |
| 单个 task 完成 | `running` / `partial` | 不切 `human-review` |
| 单个 task 失败 / blocked | `partial` / `blocked` | 不直接切 `ai-failed` / `ai-blocked` |
| 所有必需 task 完成并生成完整报告 | `completed` | 统一写 WorkItem handoff note，并切 `human-review` |
| operator 取消 WorkItem | `blocked` | 由 operator 决定是否切 `ai-blocked` |

### 9.1 WorkItem

代表一个大 Issue 的 V4 工作单元。它不是替代 GitLab Issue，而是 IssuePilot 对
“大 Issue 流程”的本地结构化视图。

关键字段：

- `workItemId`
- `sourceIssue`
- `title`
- `goal`
- `acceptanceCriteria`
- `status`
- `taskIds`
- `summaryReportId`
- `createdAt`
- `updatedAt`

### 9.2 TaskPlan

代表大 Issue 拆出来的子任务集合。TaskPlan 支持多版本；只有 accepted version
进入执行。

关键字段：

- `planId`
- `workItemId`
- `version`
- `tasks`
- `dependencies`
- `operatorEdits`
- `status`
- `acceptedAt`

### 9.3 TaskNode

代表一个可执行子任务。TaskNode 要小到能被现有 IssuePilot run 执行，也要大到
reviewer 能独立理解。

关键字段：

- `taskId`
- `title`
- `goal`
- `scope`
- `nonGoals`
- `dependsOn`
- `suggestedValidation`
- `status`
- `runIds`
- `riskLevel`

### 9.4 TaskRunLink

连接子任务和现有 run / report。V4.1 中它是 synthetic task run 的唯一绑定记录；
实现不得只靠 branch name、MR title 或 report 文件名反推 task 归属。

关键字段：

- `taskId`
- `runId`
- `attempt`
- `status`
- `reportId`
- `branch`
- `mergeRequest`
- `startedAt`
- `completedAt`

### 9.5 WorkItemReport

大 Issue 级别的总报告，是 Parent Review Packet、GitLab note、Markdown export
的统一来源。

关键字段：

- `workItemId`
- `taskSummaries`
- `overallStatus`
- `validationSummary`
- `riskSummary`
- `evidence`
- `openQuestions`
- `recommendedNextActions`

### 9.6 ImprovementRecommendation

流程改进建议。第一版只生成建议，不自动应用。

关键字段：

- `recommendationId`
- `scope`
- `evidenceRunIds`
- `problemPattern`
- `suggestedChange`
- `confidence`
- `status`

## 10. 存储策略

V4 继续 local-first，存储在 `~/.issuepilot/...` 下，和 reports / events 并排。

推荐路径：

```text
work-items/<workItemId>.json
task-plans/<planId>.json
task-run-links/<taskId>/<runId>.json
work-item-reports/<workItemId>.json
recommendations/<recommendationId>.json
```

`TaskRunLink` 也可以在实现中被索引回 `WorkItem.taskIds` / `TaskNode.runIds`，但
`task-run-links/<taskId>/<runId>.json` 是 canonical binding record。

V4 不引入 Postgres。生产级 schema、migration、backup / restore 留给 V3。

## 11. 主流程

1. Operator 选择一个 GitLab Issue，点击 `Plan work item`。
2. IssuePilot 立即创建 `WorkItem(status=planning)`，并读取 Issue 标题、描述、
   labels、已有 comments、关联 MR / run history。
3. Workflow Intelligence Layer 生成 `TaskPlan(status=draft)` 草案，绑定同一个
   `workItemId`。
4. Dashboard 展示子任务列表 / Task Graph，Operator 可以接受、编辑、删除、重排。
   拒绝或重新生成 plan 时保留 draft / rejected plan version。
5. Operator 接受 plan 后，IssuePilot 写入 accepted `TaskPlan`，并把 WorkItem 切到
   `ready`。
6. 每个 `TaskNode` 按 V4.1 Task execution contract 触发现有 IssuePilot run。
7. 子任务 run 完成后，`TaskRunLink` 记录 task、run、branch、MR 和 report 的关系。
8. `WorkItemReport` 汇总所有子任务结果。
9. Dashboard、GitLab note、Markdown export 都从 `WorkItemReport` 渲染。

## 12. 错误处理

### 12.1 拆解失败

场景：

- Issue 描述太短。
- 验收标准缺失。
- LLM 无法生成合理子任务。
- 输入超过上下文限制。

处理：

- 不创建 accepted plan。
- 写 `planning_failed` event。
- Dashboard 显示“需要补充信息”。
- 给出可复制的问题清单，例如缺少目标、缺少验收标准、范围过大。

### 12.2 Operator 拒绝计划

处理：

- 保留 rejected plan version。
- 支持重新生成或手工编辑。
- 所有 operator edits 进入 `TaskPlan.operatorEdits`，为后续质量分析提供数据。

### 12.3 子任务执行失败

处理：

- 不影响其他可并行子任务继续执行。
- TaskNode 标为 `failed` / `blocked` / `needs_rework`。
- WorkItemReport 标记为 `partial`。
- Dashboard 给出“重试该子任务 / 重新规划后续子任务 / 暂停整个 work item”三种操作。

### 12.4 依赖阻塞

处理：

- 被阻塞任务保持 `blocked_by_dependency`。
- Task Graph 明确展示阻塞边。
- 上游完成但 MR 尚未合入 workflow `base_branch` 时，下游仍保持
  `blocked_by_dependency`；V4.1 不从上游 task branch 派生下游 task branch。
- 只有当 operator 明确确认下游不需要共享代码状态，或上游 MR 已合入
  `base_branch` 并刷新 workspace 后，下游才进入 `ready`。
- 上游取消时，下游需要 operator 决定跳过、重规划或取消。

### 12.5 汇总报告不完整

处理：

- WorkItemReport 仍生成，但标记 `incomplete`。
- 缺失内容进入 `openQuestions` / `dataGaps`。
- 不允许输出 `ready_to_merge`，只能输出 `needs_human_review`。

### 12.6 ImprovementRecommendation 风险

处理：

- 第一版只生成建议，不自动应用。
- 每条建议必须带 evidence links。
- Operator 必须手动接受。
- 接受后生成可审查 patch。
- 没有证据链的建议不展示为 actionable。

## 13. 关键不变量

- V4 不能因为一个子任务失败就丢失整个 WorkItem 状态。
- 所有 AI 生成的拆解、总结和建议都必须可追溯到输入和 evidence。
- 人可以在关键节点介入：接受 plan、编辑 task、重试 run、跳过 task、接受建议。
- GitLab note、dashboard、Markdown export 不能各自拼接不同版本的报告。
- V4 不直接修改生产权限、部署、存储或审计模型。

## 14. UI / 报告体验

### 14.1 Work Items

大 Issue 级别入口。展示每个 WorkItem 的标题、来源 Issue、整体状态、子任务进度、
风险、最近更新时间。

### 14.2 Task Graph / Task Queue

WorkItem detail 中展示子任务依赖图和执行队列。第一版可以先用分组列表，不强制
做复杂图形视图。

### 14.3 Parent Review Packet

大 Issue 级汇总报告，回答：

- 这个大 Issue 被拆成了哪些任务？
- 哪些完成了，哪些失败了，哪些被跳过？
- 每个任务做了什么？
- 验证证据在哪里？
- 风险还有哪些？
- 是否建议进入人工 review / merge？
- 下一步建议是什么？

### 14.4 Evidence

按子任务聚合截图、录屏、Playwright walkthrough、命令输出、CI、测试结果。

### 14.5 Process Insights

展示质量指标和 workflow / skills 改进建议。第一版可以在 Reports 页面中增加一个
section，不单独开复杂分析产品。

## 15. 报告分层

V4 报告分两层：

1. **Task Report**：复用现有 `RunReportArtifact`，描述单个子任务 run 的结果。
2. **WorkItemReport**：新增大 Issue 汇总报告，聚合所有 Task Report 和 evidence。

所有 GitLab note、dashboard、Markdown export 都应从同一份 `WorkItemReport` 渲染。

## 16. 测试策略

### 16.1 Contract tests

- `WorkItem`
- `TaskPlan`
- `TaskNode`
- `TaskRunLink`
- `WorkItemReport`
- `ImprovementRecommendation`

重点验证状态枚举、必填字段、版本兼容和 JSON round-trip。

### 16.2 Planner tests

- 大 Issue 输入 → TaskPlan 草案。
- 缺少验收标准 → `planning_failed`。
- 子任务数量控制在 2-5。
- 依赖关系不能形成环。
- operator edits 能生成新 plan version。

### 16.3 Orchestration tests

- accepted plan → ready tasks。
- dependency blocking。
- 子任务失败后其他无依赖任务继续。
- retry / skip / replan 操作。
- run 完成后正确写 `TaskRunLink`。

### 16.4 Report tests

- 多个 `RunReportArtifact` → 一个 `WorkItemReport`。
- 缺失 evidence 时报告标记 `incomplete`。
- partial 状态不会输出 `ready_to_merge`。
- GitLab note、dashboard、Markdown export 使用同一渲染源。

### 16.5 E2E tests

- Fake GitLab + fake Codex：大 Issue → 拆解 → 接受 plan → 两个子任务 run →
  汇总报告。
- 子任务失败场景。
- 子任务依赖场景。
- operator edit plan 场景。

### 16.6 UI tests

- Work Items 列表。
- WorkItem detail。
- Task Queue / Task Graph。
- Parent Review Packet。
- Evidence tab。
- Reports / Process Insights section。

## 17. V4.1 验收标准

V4.1 至少满足：

1. 一个大 Issue 能被拆成两个子任务。
2. Operator 能接受或编辑 plan。
3. 两个子任务各自产生 run report。
4. 系统生成一个 `WorkItemReport`。
5. Dashboard 能看到子任务状态、验证结果、风险和 Parent Review Packet。
6. Fake GitLab + fake Codex E2E 能跑通完整闭环。
