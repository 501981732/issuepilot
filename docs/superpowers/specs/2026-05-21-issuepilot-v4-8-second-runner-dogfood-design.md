# IssuePilot V4.8 第二 Runner 自用验证设计

日期：2026-05-21
状态：已实现；真实 Claude Code CLI 自用验证待本机 CLI / 登录态确认

关联文档：

- `docs/superpowers/specs/2026-05-17-issuepilot-v4-intelligent-workbench-design.md`
- `docs/superpowers/specs/2026-05-20-issuepilot-v4-7-runner-adapter-contract-design.md`
- `docs/superpowers/plans/2026-05-20-issuepilot-v4-7-runner-adapter-contract-acceptance.md`
- `README.md`
- `README.zh-CN.md`
- `README.en.md`

## 实施计划

- V4.8 第二 Runner 自用验证（Second Runner Dog-food）：
  `docs/superpowers/plans/2026-05-21-issuepilot-v4-8-second-runner-dogfood.md`
  （实施已完成，覆盖 shared runner contract、workflow parser / resolver、
  `claude_code` adapter、daemon / team daemon wiring、agent report runner trace、
  dashboard i18n、mixed-runner fixture 和 acceptance 记录）。
- V4.8 验收记录：
  `docs/superpowers/plans/2026-05-21-issuepilot-v4-8-second-runner-dogfood-acceptance.md`
  （默认 gate 与 code review follow-up gate 已通过；真实 CLI smoke 仍待本机环境确认）。

## 1. 背景

V4.7 已经把 V4.6 三角色 pipeline 从 Codex-specific lifecycle 抽成
Runner Adapter Contract：`RunnerDescriptor`、`RunnerRunInput`、
`RunnerResult`、`RunnerEvent`、静态 `runners:` registry、role runner
引用、capability fail-closed 和 `AgentReport` runner 追溯字段都已经落地。

但 V4.7 仍然只有一个真实 runner kind：`codex_app_server`。这说明边界已经
抽出来了，却还没有被第二个真实执行器验证。继续在同一个 Codex adapter 内部
打磨，只能证明原有路径被整理干净，不能证明 contract 真的足以承载 Claude
Code、内部 coding agent 或其他本地 runner。

V4.8 的目标是做一次受控自用验证（dog-food）：接入第二个本地 runner kind，
但不进入 V3 的多 worker、动态 discovery、远程 runner service 或 SDK 平台化。
它要回答一个具体问题：V4.7 的 contract 在真实非 Codex 执行器上是否够用？

## 2. 目标

V4.8 需要完成：

1. 新增第二个 runner kind：`claude_code`，并让 `RUNNER_KIND_VALUES`、
   `RunnerDescriptor`、type guard、workflow parser / resolver、dashboard i18n
   和测试都接受它。
2. 新增 `claude_code` adapter，adapter 通过真实本地 CLI lifecycle 产出标准
   `RunnerResult` 和 `RunnerEvent`，但不直接生成 `AgentReport`。
3. 支持静态 workflow 配置把某个 role 指向 `claude_code` runner，最小自用验证
   先落在 `reviewer` role；`coder` role 必须显式 opt-in。
4. 保持 V4.6 pipeline 语义不变：Coder / Reviewer / TestEvidence agent factory
   继续把标准 `RunnerResult` 转成 role-specific `AgentReport`。
5. 用 mixed-runner pipeline 验证 contract：例如 `coder=codex_app_server`、
   `reviewer=claude_code`、`test_evidence=codex_app_server`。
6. 把 runner kind 纳入现有 dashboard trace、quality failure drilldown 和
   acceptance 记录，确保 operator 能看出每个 role 由哪个 runner 执行。

## 3. 非目标

V4.8 不做：

- 不做动态 runner discovery、manifest 协商、插件市场或 runner SDK 发布。
- 不做 worker pool、远程 runner service、队列调度、生产 sandbox 或集中存储。
- 不把 `claude_code` 设为默认 runner；默认仍是 `codex_app_server`。
- 不自动根据任务选择 runner；runner 选择仍来自静态 workflow `runners:` registry
  和 `roles.<role>.runner`。
- 不做 runner A/B benchmark 产品化；本期只记录自用验证证据和基础成功/失败。
- 不允许 workflow YAML 持久化 token、secret、OAuth credential、环境变量值、
  `cwd`、`workspaceRoot`、shell snippet 或任意 CLI args。
- 不承诺旧 V4.7 fixture 的长期兼容；开发期 fixture 可以直接升级。

## 4. 设计选项

### 方案 A：`local_command` shim（不采用）

新增一个通用 `local_command` runner，让 workflow 配置任意命令来模拟第二 runner。

优点是实现最快；缺点是它不是一个真实 coding/review agent，无法验证
prompt、event、artifact、cancel、timeout 和输出解析这些 runner contract 的核心
压力点。更重要的是，允许 workflow 持久化任意命令容易变成安全边界倒退。

### 方案 B：`claude_code` adapter 自用验证（采用）

新增 `claude_code` runner kind，adapter owns 本地 Claude Code CLI 的调用、
事件解析、cancel / timeout、stdout / stderr redaction 和结果映射。workflow
只声明 runner id、kind、capabilities 和少量 allowlist options；CLI 具体 flags
是 adapter 内部实现细节，由实施阶段根据本机 CLI 行为验证。

优点：

- 真正验证第二个 agent runner，而不是 mock contract。
- 与 README 和总设计里"多执行器生态"方向一致。
- 能先从 read-only reviewer role 自用验证，风险比直接替换 coder 小。
- 不需要提前引入 V3 worker platform。

缺点：

- 本地 CLI 能力和 permission model 需要实施阶段实测；如果 CLI 不支持稳定的
  non-interactive / sandbox 行为，不能把 V4.8 标为 landed。
- CI 不能依赖开发者机器上的 Claude Code 登录态，因此需要 hermetic mock driver
  + opt-in local self-test smoke 双层验证。

### 方案 C：动态 discovery / runner SDK（不采用）

让 runner 自带 manifest，IssuePilot 启动时动态探测 capabilities，并发布 SDK
给外部 runner 集成。

优点是长期扩展性强；缺点是没有第二 runner 自用验证前就设计生态协议，容易把
V4.8 拖进 V3 平台化。本期先验证真实 adapter，再决定是否需要 discovery / SDK。

## 5. 产品边界

V4.8 是 **第二 runner 自用验证**，不是 runner ecosystem product。

边界原则：

- 第二 runner 必须通过 V4.7 的 `RunnerAdapter` 接口接入。
- `claude_code` adapter 只返回 `RunnerResult`、emit sanitized `RunnerEvent`；
  role-specific `AgentReport` 仍由 agent factory 负责。
- `PipelineCoordinator` 不认识 `claude_code`，只认识 role runner 抽象。
- workflow 静态选择 runner；dashboard 只展示 trace 和失败原因，不新增大页面。
- 最小可交付自用验证是 reviewer role；coder role 需要显式配置且不作为默认。

## 6. Contract 变更

### 6.1 RunnerKind

`packages/shared-contracts/src/runner.ts`：

```ts
export const RUNNER_KIND_VALUES = ["codex_app_server", "claude_code"] as const;
export type RunnerKind = (typeof RUNNER_KIND_VALUES)[number];
```

`AgentReport.runnerKind` 自动跟随 `RunnerKind` 扩容。dashboard
`runnerKindLabel()` 必须 exhaustive，i18n 至少补：

- `workItem.agentReportTab.runnerTrace.kinds.codex_app_server`
- `workItem.agentReportTab.runnerTrace.kinds.claude_code`

### 6.2 Options discriminated union

V4.7 的 `RunnerDescriptor.options` 目前只服务 `codex_app_server`。V4.8 需要改成
按 kind 分支的 allowlist，避免把 Codex-specific `approvalPolicy` /
`threadSandbox` 误套到 `claude_code`。

建议 shape：

```ts
interface CodexAppServerRunnerOptions {
  command?: string;
  maxTurns?: number;
  turnTimeoutMs?: number;
  approvalPolicy?: "never";
  threadSandbox?: "workspace-write";
}

interface ClaudeCodeRunnerOptions {
  command?: string;
  model?: string;
  turnTimeoutMs?: number;
}

type RunnerOptionsByKind = {
  codex_app_server: CodexAppServerRunnerOptions;
  claude_code: ClaudeCodeRunnerOptions;
};
```

禁止字段保持 fail closed：`env`、`token`、`secret`、`credential`、`cwd`、
`workspaceRoot`、`repoRoot`、`shell`、`args`、`script`、`stdinTemplate`。
`claude_code` 不暴露 `maxTurns`，因为当前本地 Claude Code CLI help 未提供稳定
`--max-turns` 参数；V4.8 只把 `turnTimeoutMs` 接入 adapter 超时。

### 6.3 RunnerEvent

V4.7 为了避免误导，把 failed tool call 映射成 `runner_message`。V4.8 接入第二
runner 后，contract 需要保留工具失败语义：

```ts
export const RUNNER_EVENT_TYPE_VALUES = [
  "runner_started",
  "turn_started",
  "tool_call_started",
  "tool_call_completed",
  "tool_call_failed",
  "runner_message",
  "runner_completed",
  "runner_failed",
  "runner_cancelled",
] as const;
```

现有 Codex adapter 也同步改回标准 `tool_call_failed`，dashboard / event store
继续按事件 type 渲染，不读取 raw runner payload。

## 7. Workflow 配置

V4.8 继续使用 V4.7 的本地静态 registry：

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
      - filesystem.readonly
      - filesystem.worktree_write

  claude_reviewer:
    kind: claude_code
    display_name: Claude Code Reviewer
    capabilities:
      - roles.reviewer
      - events.streaming
      - cancel
      - artifacts
      - filesystem.readonly
    options:
      command: claude
      model: sonnet
      turn_timeout_ms: 600000

roles:
  coder:
    runner: codex_app_server
  reviewer:
    runner: claude_reviewer
  test_evidence:
    runner: codex_app_server
```

规则：

- `claude_code` runner 可以声明 `roles.reviewer` 和 `roles.test_evidence`；
  `roles.coder` 只有在 adapter 能证明 workspace write sandbox 可控时才允许。
- resolver 继续校验 role capability、sandbox capability 和 tool grants。
- 如果 `claude_code` descriptor 声明了它不能满足的 sandbox / tool capability，
  resolve 阶段 fail closed。
- 未声明 `runners:` 或 role runner 时，开发期默认仍注入 `codex_app_server`。

## 8. Adapter 架构

新增：

```text
apps/orchestrator/src/runners/claude-code.ts
apps/orchestrator/src/runners/claude-code-driver.ts
apps/orchestrator/src/runners/__tests__/claude-code.test.ts
```

分层：

- `claude-code.ts` 实现 `RunnerAdapter`，负责 `RunnerRunInput` 到
  `RunnerResult` / `RunnerEvent` 的标准映射。
- `claude-code-driver.ts` 封装本地 CLI process，实施阶段根据本机 CLI 验证
  non-interactive 调用、streaming 输出、cancel 和 timeout。单元测试用 fake
  driver，不依赖真实登录态。
- daemon / team daemon 在 workflow descriptor 中出现 `kind: claude_code` 时
  注册 `createClaudeCodeAdapter()`；否则不注册。

adapter 必须遵守：

- `cwd` 只能来自 `RunnerRunInput.cwd`。
- 不读取 workflow 里的 env / token / cwd / shell / args。
- 进程 cancel 必须 kill child process，并 emit `runner_cancelled`。
- timeout 必须 kill child process，并返回 `RunnerResultTimeout`。
- stdout / stderr / event message / finalMessage / artifact summary 必须在 emit /
  return 前 redaction。
- adapter 不写 `AgentReport`、不写 GitLab note、不直接改 `PipelineStore`。

## 9. Role 策略

### 9.1 Reviewer-first

V4.8 首个自用验证 role 是 reviewer：

- 输入是 coder diff、MR metadata、test summary 和 evidence summary。
- 默认 sandbox 是 readonly。
- reviewer 输出继续走现有 reviewer JSON schema，由
  `createReviewerAgent()` 解析为 `ReviewerAgentReport`。
- GitLab inline publish / revoke 仍由 tracker-gitlab 和 reviewer agent factory
  的既有路径处理；`claude_code` adapter 不直接调用 GitLab。

### 9.2 TestEvidence optional

`test_evidence` 可以作为第二阶段 opt-in，但不作为 V4.8 landed 的硬 gate。原因是
现有 evidence collector 已经承担 deterministic 采集；让第二 runner 参与测试建议
有价值，但不应拖慢最小自用验证。

### 9.3 Coder guarded opt-in

`coder` role 可以进入设计范围，但必须满足额外 hard gate：

- adapter 能证明 workspace write 权限被限制在 issue worktree。
- diff artifact 由真实 `git diff --stat` / branch capture 产生，而不是
  finalMessage 散文。
- MR artifact 在 failed / cancelled / timeout 时仍能透传，保持 V4.7 修复语义。

若这些 gate 不满足，V4.8 不允许 `claude_code` 声明 `roles.coder` capability。

## 10. 错误处理

新增或复用错误映射：

| RunnerErrorCode | 场景 | AgentReport.lastError.code |
| --- | --- | --- |
| `runner_unavailable` | CLI 不存在、未登录、adapter 未注册 | `runner_unavailable` |
| `runner_timeout` | role run 超时 | `runner_unavailable` |
| `sandbox_violation` | adapter 检测到越权写入或不允许的 cwd | `runner_unavailable` |
| `tool_denied` | CLI 拒绝工具或权限不足 | `runner_unavailable` |
| `output_unparseable` | reviewer JSON 无法解析 | reviewer agent 映射为 `parse_failed` |
| `artifact_collection_failed` | diff / log / evidence artifact 采集失败 | `runner_unavailable` |

runner 层错误不直接推进 GitLab label。V4.6 pipeline 按既有规则产出 failed
`AgentReport`，再由 WorkItem 汇总路径决定 human handoff。

## 11. 安全与隔离

V4.8 仍是本地自用验证，不声称提供 V3 production sandbox。但它不能倒退当前
安全边界：

- token / secret 不得进入 workflow YAML、runner options、event、artifact、
  finalMessage 或 dashboard。
- CLI 登录态只来自宿主机本地工具，不由 IssuePilot 持久化。
- adapter 不允许 arbitrary args / shell script；只接受 allowlist options。
- `cwd` 由 IssuePilot issue worktree 控制。
- read-only role 不能声明 `filesystem.worktree_write`。
- 如果本地 CLI 没有可验证的 non-interactive / permission behavior，实施不能
  把 `claude_code` 标为自用验证通过，只能保留为 experimental opt-in。

## 12. Dashboard / Reports

V4.8 不新增页面，只扩现有展示：

- `AgentReportTabs` runner trace 显示 `runnerKind=claude_code` 的 i18n label。
- runner failure 在现有 role panel 和 failure drilldown 中可见。
- `/reports` 继续消费 `AgentReport.runnerKind`；如已有 byRole 切片，可在同一
  数据模型上增加 byRunner 维度，但不是新页面。
- acceptance 文档必须记录至少一次 mixed-runner pipeline 的 `AgentReport`
  trace 和 verification command。

## 13. 测试策略

必须覆盖：

- shared-contracts：`isRunnerKind("claude_code")`、descriptor options guard、
  `tool_call_failed` event guard。
- workflow parser / resolver：`claude_code` registry parse、forbidden options
  fail closed、capability missing fail closed、mixed runner role refs 通过。
- orchestrator adapter：fake driver 覆盖 completed / failed / cancelled /
  timeout、redaction、artifact mapping、event emission、process kill。
- agent factories：reviewer role 通过 `claude_code` RunnerResult 生成
  `ReviewerAgentReport`，并保留 `runnerId` / `runnerKind` / `runnerRunId`。
- daemon wiring：workflow 同时声明 `codex_app_server` 与 `claude_code` 时，
  registry 为每个 descriptor 注册正确 adapter。
- dashboard：`claude_code` i18n label、unknown kind fallback 仍然安全。
- E2E：hermetic mixed-runner fixture 通过；真实 Claude Code 自用验证 smoke
  用 opt-in 环境变量执行并记录在 acceptance。

验证入口仍优先使用：

```bash
SKIP_E2E=1 NODE_BIN_DIR=... bash scripts/ci-equivalent-check.sh
```

真实 CLI 自用验证不能进入默认 CI gate，建议单独提供：

```bash
ISSUEPILOT_CLAUDE_CODE_E2E=1 npx vitest run apps/orchestrator/src/__tests__/v4-8-claude-code-dogfood.test.ts
```

## 14. 验收标准

V4.8 标为 landed 前至少满足：

1. `RUNNER_KIND_VALUES` 支持 `claude_code`，且所有 type guard / i18n / dashboard
   trace 与之同步。
2. workflow `runners:` registry 能声明 `claude_code`，resolver 对 capability /
   forbidden options fail closed。
3. daemon / team daemon 能按 descriptor 注册 `claude_code` adapter。
4. reviewer role 能通过 `claude_code` adapter 产出 `ReviewerAgentReport`，
   且 `runnerKind=claude_code` 进入持久化 report。
5. mixed-runner pipeline fixture 通过：Codex coder + Claude reviewer + Codex
   test/evidence。
6. adapter 对 finalMessage、event message、stderr summary 和 artifact summary
   做 redaction，并记录 `redactedFields[]`。
7. cancel / timeout 都能终止 child process 并返回标准 `RunnerResult`。
8. `tool_call_failed` 作为标准 `RunnerEventType` 被 Codex 和 Claude adapter
   同步支持。
9. `scripts/ci-equivalent-check.sh` 通过；真实 CLI 自用验证必须在至少一台开发机
   通过后，才能把 V4.8 标为自用验证通过 / landed。若因本机未安装或未登录
   无法运行，acceptance 必须记录精确跳过原因，并保持 V4.8 为 experimental
   opt-in。

## 15. 回滚路径

如果 `claude_code` adapter 在本地自用验证中不稳定：

- 保留 V4.7 `codex_app_server` 默认路径不变。
- workflow 移除或注释 `claude_code` descriptor 后自动回到 Codex runner。
- `RunnerKind` 扩容可以保留；adapter registration 可以 feature-gate。
- dashboard 对 unknown runner kind 已有 fallback，不会阻断旧 report 查看。

## 16. 与 V4.7 / V3 的关系

V4.7 负责抽出 runner contract，V4.8 负责用第二个真实本地 runner 验证它。

V4.8 仍不做 V3：

- 不做多 worker。
- 不做远程 runner service。
- 不做生产 sandbox。
- 不做集中存储、权限、预算或审计平台。

V4.8 的产出应该是一个被真实自用验证过的 adapter contract。如果第二 runner
暴露出 contract 不足，先修 contract；不要绕过 contract 在 agent factory 或
PipelineCoordinator 里写 runner-specific 分支。
