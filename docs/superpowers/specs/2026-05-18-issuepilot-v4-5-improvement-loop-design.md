# IssuePilot V4.5 Workflow / Skills Improvement Loop 设计

日期：2026-05-18
状态：待 spec review

关联文档：

- `docs/superpowers/specs/2026-05-17-issuepilot-v4-intelligent-workbench-design.md`
- `docs/superpowers/specs/2026-05-18-issuepilot-v4-4-quality-analytics-design.md`
- `docs/superpowers/plans/2026-05-18-issuepilot-v4-4-quality-analytics.md`
- `README.md`

## 实施计划

- V4.5 Workflow / Skills Improvement Loop：
  `docs/superpowers/plans/2026-05-18-issuepilot-v4-5-improvement-loop.md`

## 1. 背景

V4.1-V4.3 已经把大 Issue 拆解、Task Graph、Parent Review Packet 和 Evidence
闭环跑通。V4.4 在 `/reports` 上新增 Quality Analytics，能从
`RunReportArtifact`、`WorkItemReport`、`TaskPlan`、`TaskRunLink` 和本地 store
聚合成功率、失败模式、missing evidence、review rework、CI failure 等质量事实。

V4.5 的目标是把这些质量事实继续往前推进一步：从“看到问题”变成“提出可审查的流程改进建议”。

V4.5 不做自动自我改写。系统可以生成 `ImprovementRecommendation` 和 patch
preview，但不能静默修改 workflow、skills、prompt、项目规则或生产策略。

## 2. 目标

V4.5 需要回答：

1. 哪些失败模式已经重复出现，值得形成流程改进建议？
2. 每条建议对应哪些 run、work item、task、review comment 或 evidence？
3. 建议应该改哪个目标面：workflow front matter、prompt template、project rules
   还是 skill instruction？
4. 建议的置信度、风险和影响范围是什么？
5. Operator 如何接受、拒绝或延后建议，并查看可审查 patch preview？

## 3. 非目标

V4.5 不做：

- 不自动应用 patch，不自动 commit，不自动推送 MR。
- 不静默修改 workflow、skills、prompt、`AGENTS.md` 或 project facts。
- 不修改 GitLab label 状态机、Issue state transition、merge policy 或 runner
  调度策略。
- 不写入 token、凭据、secret 或私有环境变量。
- 不引入 Postgres、对象存储、后台分析 job 或生产 worker 平台。
- 不做 V4.6 的多 agent / 多 runner 协作。
- 不使用 LLM 作为第一版核心分类器；第一版以 deterministic template 为主。

## 4. 设计选项

### 方案 A：只做洞察增强

继续在 Reports 中展示“可能需要改进”的说明，但不生成 durable recommendation，也不生成 patch preview。

优点是实现最小；缺点是和 V4.4 边界重叠，不能形成真正的 improvement loop。

### 方案 B：Recommendation Queue + Patch Preview（采用）

从 V4.4 的 quality facts 生成 durable `ImprovementRecommendation`，在 Reports 中展示
recommendation queue。Operator 可以 `accept` / `reject` / `defer`。`accept` 后生成
patch preview，但不直接改文件。

优点：

- 明显区别于 V4.4，从观测进入改进闭环。
- 所有建议都有 evidence trace，便于 reviewer / tech lead 判断。
- patch preview 能验证建议是否可执行，但仍保留人类 gate。

缺点：

- 第一版需要新增 recommendation store、API、UI 和 patch preview contract。

### 方案 C：Accept 后直接修改文件

Operator 接受建议后直接修改 workflow / skill / prompt / project rules 文件。

优点是闭环更完整；缺点是风险过高，容易把 IssuePilot 变成 self-modifying control
plane，不符合 V4 总 spec 的安全边界。V4.5 不采用。

## 5. 产品边界

V4.5 的核心对象是 `ImprovementRecommendation`。它不是普通 dashboard alert，而是一个可审计的流程改进提案。

每条 recommendation 必须包含：

- 问题模式：来自 V4.4 `FailurePatternId` 或 human-review checklist。
- 证据来源：pattern、drilldown item、run、work item、task、review comment 或 evidence。
- 建议目标面：workflow front matter、prompt template、project rules、skill instruction。
- 建议改动：可读说明 + patch preview 所需结构化信息。
- 置信度、风险、影响范围和状态。

V4.5 的 hard gate：

- `accept` 表示 operator 认可建议，可生成 patch preview。
- `accept` 不表示立即写文件。
- `reject` / `defer` 只改变 recommendation 状态。
- Patch preview 是 inert artifact；实际 apply 属于后续实现阶段或人工操作。

## 6. 架构

V4.5 新增独立的 **Improvements Layer**，复用 V4.4 的 quality facts，但不把
`quality` 聚合器扩大成 policy engine。

### 6.1 现有事实源

V4.5 只消费已有事实，不新增采集链路：

| 来源 | 用途 |
| --- | --- |
| `QualitySummaryResponse` | 当前筛选窗口内的指标、failure patterns、drilldown |
| `QualityDrilldownItem` | recommendation 的最小证据引用 |
| `RunReportArtifact` | run 状态、CI、review feedback、lastError、validation、risks |
| `WorkItemReport` | human review checklist、missing evidence、overall status |
| `TaskPlan` / `TaskRunLink` | task type、attempt、branch、MR、task-to-run binding |
| team config / project registry | project scope、workflow profile、effective workflow source |

### 6.2 新模块

建议实现边界：

```text
apps/orchestrator/src/improvements/
  collect.ts          # 从 quality / report / work-item facts 组装候选输入
  templates.ts        # pattern -> recommendation template 映射
  engine.ts           # 聚合、dedupe、confidence、risk、status 计算
  patch-preview.ts    # 生成 inert patch preview
  store.ts            # recommendations/<id>.json
  routes.ts           # recommendation API
```

`apps/orchestrator/src/quality/*` 继续只负责 quality summary 和 failure pattern
classification。`improvements` 可以调用 quality aggregator，但不能反向污染 quality contract。

## 7. Recommendation 类型

第一版固定四类 target。

| `target.kind` | 说明 | 示例 |
| --- | --- | --- |
| `workflow_front_matter` | workflow runtime/config 层建议 | CI policy、retention、max attempts、sandbox warning |
| `prompt_template` | agent prompt 输入要求 | evidence 要求、验证输出格式、review feedback rework 格式 |
| `project_rules` | repo-local 工程规则 | `AGENTS.md`、project facts、acceptance discipline |
| `skill_instruction` | skill 规则或新 skill 建议 | 补充 evidence skill、更新 review workflow skill |

不允许 target：

- GitLab token、secret、credential。
- label 状态机和 workflow transition。
- merge automation、RBAC、预算、生产 worker policy。
- 任意无法定位到明确文件或规则面的自由文本修改。

## 8. 数据模型

新增 shared contract：

```ts
type ImprovementTargetKind =
  | "workflow_front_matter"
  | "prompt_template"
  | "project_rules"
  | "skill_instruction";

type ImprovementRecommendationStatus =
  | "open"
  | "accepted"
  | "rejected"
  | "deferred"
  | "blocked"
  | "stale"
  | "superseded";

interface ImprovementEvidenceRef {
  kind: "quality-drilldown" | "run" | "work-item" | "task" | "evidence" | "review-comment";
  id: string;
  href?: string;
  reason: string;
}

interface ImprovementPatchPreview {
  status: "not_generated" | "generated" | "blocked" | "stale";
  targetPath?: string;
  targetDescription: string;
  sourceSnapshot?: {
    targetPath: string;
    sha256: string;
    capturedAt: string;
  };
  diff?: string;
  blockedReason?: string;
  rollbackNotes?: string;
}

interface ImprovementActionHistoryEntry {
  action: "generated" | "accepted" | "rejected" | "deferred" | "patch_preview_generated";
  actor: "operator" | "system";
  at: string;
  note?: string;
}

interface ImprovementRecommendation {
  recommendationId: string;
  /**
   * 权威 projectId。single-project 模式始终就是当前 daemon 服务的
   * project；team-project 模式镜像自 `x-issuepilot-project` header
   * 解析到的 project。所有 store 索引、API filter 以及 audit log 都以
   * 这个字段为准。
   */
  projectId: string;
  scope: {
    mode: "single-project" | "team-project";
    /**
     * 仅 team-project 模式下镜像顶层 `projectId`，方便 dashboard 直接
     * 在 `scope` 对象上做展示和后续 filter（与 V4.4
     * `QualitySummaryResponse.scope.projectId` 对齐）；single-project
     * 模式下省略。出现冲突时以顶层 `projectId` 为准。
     */
    projectId?: string;
    workflow?: string;
    taskType?: string;
  };
  problemPattern: string;
  title: string;
  summary: string;
  target: {
    kind: ImprovementTargetKind;
    path?: string;
    description: string;
  };
  evidenceRefs: ImprovementEvidenceRef[];
  suggestedChange: string;
  patchPreview: ImprovementPatchPreview;
  confidence: "low" | "medium" | "high";
  risk: "low" | "medium" | "high";
  status: ImprovementRecommendationStatus;
  actionHistory: ImprovementActionHistoryEntry[];
  createdAt: string;
  updatedAt: string;
  supersedes?: string[];
}
```

存储路径沿用 V4 总 spec：

```text
recommendations/<recommendationId>.json
```

Team mode 下 recommendation store 必须按 project 隔离，API 继续使用
`x-issuepilot-project`。

## 9. Recommendation Engine

第一版采用 deterministic-first。

### 9.1 Template 映射

| Pattern | 默认建议方向 |
| --- | --- |
| `missing-evidence` | 补充 prompt / project rules 中的 evidence 要求 |
| `missing-tests` | 补充验证矩阵、测试输出要求或 skill instruction |
| `environment-issue` | 补充 workflow / project rules 中的环境预检和失败说明 |
| `permission-issue` | 补充 token/env 前置检查说明；不得写 secret |
| `review-rework` | 补充 review feedback rework 输入格式和 retry 纪律 |
| `unclear-requirements` | 补充 issue acceptance criteria / planning prompt 要求 |
| `ci-failure` | 补充 CI failure 处理策略、重试边界和人工提示 |

### 9.2 聚合与去重

Recommendation 去重 key：

```text
projectId + scope.workflow + target.kind + target.path + problemPattern
```

同一 key 再次出现时：

- 如果旧 recommendation 仍 `open` / `deferred`，追加 evidence refs 并刷新 `updatedAt`。
- 如果旧 recommendation 已 `rejected`，新 evidence 数量或严重度超过阈值时生成新记录，并在
  `supersedes` 中引用旧记录。
- 如果 target source 已变化，旧 patch preview 标记 `stale`。

### 9.3 Confidence / Risk

`confidence` 基于证据数量、pattern 一致性、最近发生时间和是否跨多个 work item。

`risk` 基于 target kind 和 patch 范围：

- prompt / project rules 小段补充通常是 `low`。
- workflow front matter 影响 runner 行为，默认至少 `medium`。
- skill instruction 影响后续 agent 行为，默认至少 `medium`。

## 10. Patch Preview

Patch preview 是 V4.5 的核心安全边界。

要求：

- 每个 preview 只能指向一个明确 target surface。
- diff 必须可读，并带 rollback notes。
- 生成 preview 时必须记录 `sourceSnapshot.sha256`。后续刷新或展示时，如果 target
  file 内容的 sha256 和 snapshot 不一致，preview 进入 `stale`，需要重新生成。
- 如果 target file 不存在、source hash 不匹配、或无法安全定位插入点，preview 进入
  `blocked`，不能猜测写入。
- Preview 不触发文件系统写入。
- Preview 不触发 git add / commit / push。

第一版 patch preview 可以先支持：

1. prompt template 追加一小段 evidence / validation 规则。
2. project rules 追加一小段 acceptance / review feedback 规则。
3. workflow front matter 生成建议 YAML diff，但默认需要更高风险提示。
4. skill instruction 生成建议 diff 或“建议创建 skill”的占位 preview。

## 11. API

新增 API：

```text
GET  /api/improvements/recommendations
GET  /api/improvements/recommendations/:id
POST /api/improvements/recommendations/generate
POST /api/improvements/recommendations/:id/accept
POST /api/improvements/recommendations/:id/reject
POST /api/improvements/recommendations/:id/defer
POST /api/improvements/recommendations/:id/patch-preview
```

行为：

- `generate` 使用当前 quality filters 或显式 request body 生成建议。
- list/detail 支持 `status`、`pattern`、`targetKind`、`workflow`、`taskType`。
- action endpoints 只更新 recommendation record 和 action history。
- `accept` 只把 recommendation 状态改为 `accepted` 并追加 action history；它不自动生成
  preview。`patch-preview` 是独立动作，只生成或刷新 preview，不写目标文件。
- Team mode 下未知 project id 必须拒绝；不同 project 的 recommendation 互不可见。

## 12. UI / Operator Workflow

V4.5 第一版放在 `/reports`，不新建复杂产品区。

### 12.1 Reports Recommendations Section

Quality Analytics 下新增 Recommendations section：

- 显示 open / deferred recommendation 数量。
- 支持从当前 filters 生成 recommendations。
- 列表展示 title、pattern、target kind、confidence、risk、evidence count、status。
- 点击 recommendation 进入详情或打开详情面板。

### 12.2 Recommendation Detail

详情面展示：

- 问题说明和建议摘要。
- Evidence refs，能回到 run / work item / task / evidence。
- Target surface 和目标路径。
- Patch preview diff。
- Confidence、risk、rollback notes。
- `accept` / `reject` / `defer` 操作。

UI 风格应延续 Command Center / Reports 的 operator console：

- 高密度、可扫描。
- 明确状态和风险。
- 按钮有 loading / disabled / error 状态。
- icon-only controls 必须有 `aria-label`。
- 错误提示就地展示，并提供恢复动作。

## 13. Error Handling

V4.5 fail closed。

| 场景 | 行为 |
| --- | --- |
| evidence 不足 | 不生成高置信建议，或 recommendation 标为 `blocked` |
| target 文件不存在 | patch preview 标为 `blocked`，保留建议 |
| target source 变化 | patch preview 标为 `stale`，要求重新生成 |
| 重复建议 | dedupe 或 supersede |
| unknown project | API 返回错误，不泄露其他 project 数据 |
| patch 无法安全生成 | 不猜测，不写文件，只返回 blocked reason |
| action 失败 | recommendation 状态不变，记录错误事件 |

## 14. 测试策略

### 14.1 Contract tests

- `ImprovementRecommendation` JSON round-trip。
- status / target kind / confidence / risk 枚举。
- evidence refs 必填字段。
- patch preview blocked / stale / generated 状态。

### 14.2 Engine tests

- 每个 failure pattern 映射到正确 template。
- 多个 drilldown item 聚合成一条 recommendation。
- dedupe / supersede / stale 行为。
- confidence / risk 计算。

### 14.3 Patch Preview tests

- prompt template / project rules / workflow front matter 生成预览 diff。
- target 不存在或 source 不匹配时 blocked。
- preview 生成不写文件。

### 14.4 API tests

- list / detail / generate / accept / reject / defer / patch-preview。
- filters 生效。
- team mode project isolation。
- unknown project 拒绝。

### 14.5 UI tests

- Recommendations section 空态、加载态、错误态。
- recommendation 列表和详情。
- accept / reject / defer 操作。
- patch preview diff 展示。
- keyboard navigation 和 aria label。

### 14.6 E2E tests

Fake GitLab + fake Codex + seeded quality data：

1. 生成 missing-evidence failure pattern。
2. 调用 recommendation generate。
3. Reports 展示 recommendation。
4. Operator accept。
5. 生成 patch preview。
6. 验证目标文件没有被写入。

## 15. 验收标准

V4.5 至少满足：

1. 能从 V4.4 quality facts 生成 `ImprovementRecommendation`。
2. 每条 recommendation 都有 evidence trace。
3. Reports 能展示 recommendation queue 和详情。
4. Operator 能 `accept` / `reject` / `defer`。
5. `accept` 后能生成 patch preview。
6. Patch preview 不会静默修改目标文件。
7. Team mode 下 recommendation 按 project 隔离。
8. 重复建议能 dedupe 或 supersede。
9. 缺少 evidence、target 不存在、source stale 时 fail closed。
10. `scripts/ci-equivalent-check.sh` 或等价 gate 通过。

## 16. 后续边界

V4.5 完成后，后续可以继续扩展：

- 引入 LLM 对 recommendation 文案做润色，但不替代 deterministic evidence mapping。
- 增加 explicit apply step，把 patch preview 应用到本地工作区，但仍必须人类确认。
- 把 accepted recommendation 写入 review packet / GitLab note。
- V4.6 再引入 reviewer agent / test agent 等多 agent 角色协作。
