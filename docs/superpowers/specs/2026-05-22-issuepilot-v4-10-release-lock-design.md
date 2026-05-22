# IssuePilot V4.10 Release Lock / Dog-food Closure 设计

日期：2026-05-22
状态：待用户评审

关联文档：

- `docs/superpowers/specs/2026-05-11-issuepilot-design.md`
- `docs/superpowers/specs/2026-05-17-issuepilot-v4-intelligent-workbench-design.md`
- `docs/superpowers/specs/2026-05-21-issuepilot-v4-8-second-runner-dogfood-design.md`
- `docs/superpowers/specs/2026-05-21-issuepilot-v4-9-intelligent-review-workflow-design.md`
- `docs/superpowers/plans/2026-05-21-issuepilot-v4-8-second-runner-dogfood-acceptance.md`
- `docs/superpowers/plans/2026-05-21-issuepilot-v4-9-intelligent-review-workflow-acceptance.md`

## 1. 决策

V4.10 不新增一个更大的智能功能。它是 V4 智能研发工作台进入对内试点前的
release lock / dog-food closure 阶段。

当前状态是：

- V4.1-V4.9 的主要能力已经合入 `main`。
- V4.8 第二 runner 已完成实现和默认 gate，但真实 `claude_code` CLI dog-food
  仍需本机 CLI / 登录态确认。
- V4.9 智能 review 工作流已完成实现和 CI-equivalent gate，但仍需要用户验收
  和真实/准真实 review-rework dog-food。
- V4 总 spec、README、CHANGELOG 中仍有少量状态文字落后于实现状态。

因此下一步先锁定 V4 试点边界，而不是直接进入 V3 生产化执行平台，也不是继续
堆新的 V4 功能。

## 2. 目标

V4.10 的目标是把 V4.1-V4.9 从“功能已实现”收口成“可以对内试点”的状态。

成功后，团队应该能回答：

1. V4 当前哪些能力已经可以在本地/团队机器版本里使用？
2. V4.8 第二 runner 是否经过真实 CLI dog-food，哪些角色可用，哪些仍需保守
   opt-in？
3. V4.9 的 `ReviewReworkPlan` 是否能从 review feedback / reviewer findings
   生成、accept、注入下一轮 `ai-rework` prompt，并在 dashboard / report /
   quality analytics 中形成一致事实？
4. team mode 与 single daemon 在 V4.8 / V4.9 上还有哪些明确缺口？
5. 进入 V3 前，哪些能力已经 release-locked，哪些必须留为 follow-up？

## 3. 非目标

V4.10 不做：

- 新的智能规划能力。
- 自动 merge 或 GitLab discussion resolve 双向同步。
- GitLab webhook 实时 review feedback 回流。
- dynamic runner discovery、worker pool、remote runner service 或 SDK。
- Postgres、RBAC、生产 sandbox、多 worker、预算配额或 OpenTelemetry。
- dashboard 大布局重构。
- 静默修改 workflow、skills、prompt 或项目规则。

这些都属于后续 V3 或独立 V4 follow-up，不应进入 V4.10 release lock。

## 4. 范围

### 4.1 V4.9 用户验收闭环

V4.10 需要定义并执行一条可复现的 V4.9 dog-food 场景：

1. 准备一个带 review feedback / reviewer findings / CI 或 evidence context 的
   run 或 work item。
2. 触发 planner 生成 draft `ReviewReworkPlan`。
3. operator accept plan 或 accept 单个 item。
4. 下一轮 `ai-rework` dispatch prompt prepend `## Review rework plan`。
5. Run Detail 展示 plan，Parent Review Packet 聚合 `reviewReworkSummary`，
   Reports 展示 `reviewWorkflow` quality slice。
6. planner 失败或未 accept 时，仍 fallback 到 V2 `## Review feedback`。

验收材料必须记录实际命令、输入 fixture 或真实 run id、输出摘要和失败回滚方式。

### 4.2 V4.8 第二 runner dog-food

V4.10 需要把 V4.8 的真实 CLI dog-food 从“待确认”推进到明确状态：

- 若本机 `claude_code` CLI / 登录态可用，运行 reviewer read-only role 的
  mixed-runner dog-food。
- 若 CLI / 登录态不可用，记录 blocker、环境要求和不影响 V4 release lock 的
  降级判断。
- dog-food 只证明 runner adapter contract 能承载第二本地 runner；不把
  `claude_code` 扩展到 coder write role，除非 sandbox 可控性另行设计。

### 4.3 Single daemon / team mode 对齐

V4.10 需要明确 V4.8 / V4.9 在 single daemon 和 team daemon 的状态矩阵。

最小矩阵：

| 能力 | single daemon | team daemon | V4.10 处理 |
| --- | --- | --- | --- |
| `claude_code` adapter registry | 已接入 | 已接入 | dog-food 或记录环境 blocker |
| mixed-runner reviewer provenance | 已覆盖 | 已覆盖 contract / wiring | 验证 fixture 与 doc 状态 |
| review workflow service | 已接入 V4.9 路径 | 当前属于后续 multi-project 服务化范畴 | 设计绑定策略或明确 follow-up |
| dashboard project-scoped review plan | single project 可用 | 依赖 team service binding | 不静默宣称已完成 |

如果 V4.10 选择不实现 team review workflow service binding，必须把它记录为
release follow-up，并确保 README / V4 spec 不把该能力描述成 team mode 已完整可用。

### 4.4 文档状态收口

V4.10 需要同步以下文档状态：

- V4 总 spec：V4.9 从“设计中/待评审”修正为“实施完成，待用户验收”；新增 V4.10
  release lock 阶段。
- `README.md` / `README.zh-CN.md` / `README.en.md`：Roadmap 增加 V4.10 当前
  下一步，并避免把未 dog-food 的能力描述成已试点完成。
- `CHANGELOG.md`：增加 V4.10 设计入口和 release-lock 目标。
- V4.8 / V4.9 acceptance：如 dog-food 完成，追加具体证据；如受环境阻塞，
  写明阻塞条件和降级状态。

## 5. 交付物

V4.10 结束时应至少产出：

1. V4.10 实施计划：
   `docs/superpowers/plans/2026-05-22-issuepilot-v4-10-release-lock.md`。
2. V4.10 验收记录：
   `docs/superpowers/plans/2026-05-22-issuepilot-v4-10-release-lock-acceptance.md`。
3. 更新后的 V4 总 spec、README 三语版本和 CHANGELOG。
4. V4.8 真实 CLI dog-food 结果或明确 blocker。
5. V4.9 review-rework dog-food 结果。
6. single daemon / team daemon 能力矩阵。

## 6. 验收标准

V4.10 视为完成必须满足：

- `git status --short --branch` 显示工作树只包含本次相关文档或实现变更。
- 文档类变更至少通过 `git diff --check`。
- 如涉及代码修复，必须通过 `SKIP_E2E=1 bash scripts/ci-equivalent-check.sh`；
  发布/合并前至少有一种完整 gate 通过。
- V4.9 dog-food 能证明 accepted `ReviewReworkPlan` 被注入下一轮 rework prompt。
- V4.8 dog-food 有明确结果：通过、环境阻塞或保守降级，不能继续停留在含糊
  “待确认”。
- README / V4 spec / CHANGELOG 对 V4.8、V4.9、V4.10 状态描述一致。

## 7. 回滚

V4.10 本身主要是 release-lock 和文档/验收收口。

若 V4.9 dog-food 暴露问题：

- 不删除已落盘的 `ReviewReworkPlan`，保留审计材料。
- daemon 可不注入 `reviewWorkflow` slice，让 dispatch 和 sweep 回退到 V2
  review feedback 路径。
- 文档把 V4.9 状态退回“实施完成，dog-food 修复中”，并记录阻塞项。

若 V4.8 第二 runner dog-food 暴露问题：

- 保留 `claude_code` adapter contract，但 README 只声明默认 runner 仍是
  `codex_app_server`。
- `claude_code` 继续限制为显式 opt-in reviewer read-only role。
- 不把失败解释成 V3 runner platform 的启动理由；V3 仍需等 V4 release lock
  后再规划。

## 8. 下一步

用户确认本 spec 后，进入 implementation plan：

`docs/superpowers/plans/2026-05-22-issuepilot-v4-10-release-lock.md`

计划应拆成可独立验证的任务：文档状态同步、V4.9 dog-food、V4.8 CLI dog-food、
team-mode 能力矩阵、验收记录、最终 gate。
