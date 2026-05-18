# IssuePilot V4.4 Quality Analytics 设计

日期：2026-05-18
状态：待 spec review

关联文档：

- `docs/superpowers/specs/2026-05-17-issuepilot-v4-intelligent-workbench-design.md`
- `docs/superpowers/specs/2026-05-16-issuepilot-v25-command-center-design.md`
- `docs/superpowers/plans/2026-05-17-issuepilot-v4-3-review-packet-evidence.md`
- `README.md`

## 1. 背景

V4.1 已经把大 Issue 拆解、子任务 run 和 Parent Review Packet 跑通。V4.2
补上 Task Graph、依赖执行和 branch chaining。V4.3 已经把 Review Packet 与
Evidence 统一到 `WorkItemReport`，并明确区分 AI claim、system-derived 和
human-confirmed evidence。

V4.4 的目标是利用这些已有事实源，让 operator、reviewer 和 tech lead 能从多
run、多子任务中看到质量趋势，而不是逐个打开 run detail 或 work item detail
手工判断。

V4.4 第一版采用 **Reports-first Quality Analytics**：在现有 `/reports` 页面
增加质量指标、趋势、失败模式和 drill-down，而不是新建独立 BI 产品。

## 2. 目标

V4.4 需要回答：

1. 最近一段时间 IssuePilot 的成功率、失败率、返工率和 CI 通过率如何？
2. 失败、blocked、返工和 missing evidence 集中在哪些 project、workflow 或
   task type？
3. 常见失败模式是什么，例如测试缺失、需求不清、权限不足、环境问题或 review
   返工？
4. 每个指标和失败模式背后对应哪些 run、work item、task 和 evidence？
5. 当前质量趋势是否说明 workflow、skills 或项目规则需要后续改进？

## 3. 非目标

V4.4 不做：

- 不自动生成 workflow、skills、prompt 或项目规则 patch。这是 V4.5 的范围。
- 不引入 Postgres、数据仓库或长期分析服务。V4.4 继续 local-first，从现有
  report store、work-item store 和 team config 聚合。
- 不做登录、RBAC、企业审计、预算、生产 worker 或 production sandbox。这些仍是
  V3 范围。
- 不把 Reports 做成通用 BI。V4.4 只服务 IssuePilot 质量判断。
- 不使用 LLM 做失败模式分类。第一版必须使用可复现的规则分类。

## 4. 设计选项

### 方案 A：Quality Summary API + Reports 页面扩展（采用）

orchestrator 新增一个质量聚合 API，dashboard `/reports` 页面新增 Quality
Analytics section。API 从 `RunReportArtifact`、`WorkItemReport`、
`TaskPlan` 和 `TaskRunLink` 聚合指标、趋势、失败模式和 drill-down。

优点：

- 产品价值可见，符合 V4 总 spec 的 Reports / Process Insights 方向。
- 复用已有 Reports 页面和 report store，不提前引入复杂平台能力。
- API 与 UI 边界清楚，dashboard 不需要自己推导质量事实。

缺点：

- 第一版分析能力会比较聚焦，暂不做自动推荐 patch。

### 方案 B：Shared-contract 先行，UI 最小化

先固化 `QualityMetric`、`FailurePatternSummary`、`QualityDrilldownItem` 等
contract，UI 只展示少量结果。

优点是架构更保守；缺点是短期产品体验弱，不能很好验证 V4.4 是否真正帮助
operator 看清质量趋势。

### 方案 C：Failure-pattern first

先专攻失败模式识别，把指标和趋势弱化。

优点是更接近智能洞察；缺点是会提前进入 V4.5 的 workflow / skills
recommendation 边界，也容易因为分类规则不清导致第一版不可验收。

## 5. 数据来源

V4.4 不新增采集链路，使用现有事实源：

| 来源 | 用途 |
| --- | --- |
| `RunReportArtifact` | run 状态、耗时、CI、review feedback、风险、checks、merge readiness |
| `WorkItemReport` | 多 task 汇总、overall status、human review checklist、evidence index、missing evidence |
| `TaskPlan` | task type、operator edits、replan 记录、建议验证方式 |
| `TaskRunLink` | task 到 run 的 canonical binding、attempt、MR、branch、状态 |
| team config / project registry | project、workflow profile、project-scoped 聚合 |

旧数据缺少 workflow 或 task type 时，必须进入 `unknown` bucket，不得丢弃。

## 6. 指标口径

V4.4 第一版固定以下指标。

### 6.1 Success rate

`completed / terminal runs`。

terminal runs 只使用现有 `RunStatus` 合约中的结束态：`completed`、`failed`、
`blocked`。`claimed`、`running`、`retrying`、`stopping` 不进入分母。

`stop` / `cancel` 路径如果最终把 run 持久化为 `failed` 并在
`RunReportArtifact.run.lastError.classification` 标为 `cancelled`，V4.4 仍把它计入
terminal runs，并在 failure drill-down 中显示 `cancelled` classification；V4.4
不得为 run status 引入新的 `cancelled` 枚举。CI 的 `canceled` 仍只属于
`PipelineStatus`，不能混入 run status。

### 6.2 Failure rate

`(failed + blocked) / terminal runs`，同时分开展示 failed rate 与 blocked rate。

### 6.3 Rework rate

task 状态进入 `needs_rework`，或存在 `needsReworkReason` 的 task 占比。若一个
task 多次 rework，summary 计一次，drill-down 保留最近一次原因和相关 run。

### 6.4 CI pass rate

`ci.status === "success" / reports with known CI status`。

没有 CI 数据的 run 不进入分母，但单独展示 unknown CI 数，避免把未接 CI 的项目
错误算成失败。

### 6.5 Review hit rate

进入 `human-review` 后出现 unresolved review feedback 的 run 或 task 占比。
`reviewFeedback.unresolvedCount > 0` 视为命中。

### 6.6 Missing evidence rate

满足任一条件视为 missing evidence：

- `WorkItemReport.humanReviewChecklist` 中存在 `reason === "missing-evidence"`。
- `WorkItemReport.overallStatus === "incomplete"` 且 missing reason 指向
  `no-run-report`、`no-link` 或 `incomplete-report`。
- task 没有任何 validation / test / screenshot / command output evidence。

### 6.7 Median duration

保留现有 Reports median duration，并支持按成功、失败、blocked、needs_rework
分组看耗时。

## 7. Failure Pattern 分类

第一版使用规则分类，输出稳定 pattern id、label、count、rate 和 drill-down。

| Pattern | 规则 |
| --- | --- |
| `missing-tests` | checks 为空、checks 全部 unknown / skipped、test evidence 缺失、validation 只来自 AI claim |
| `unclear-requirements` | planner / work item blocked reason 命中 missing acceptance criteria、insufficient context、scope unclear 等关键词 |
| `permission-issue` | GitLab auth、token、permission、credential、401、403、access denied 等错误 |
| `environment-issue` | workspace、mirror、dependency install、runner、Codex app-server、CI infra、network、timeout 等错误 |
| `review-rework` | task 为 `needs_rework`、存在 `needsReworkReason`、或 unresolved review feedback |
| `ci-failure` | CI status 为 failed 或 canceled 且需要人工判断；GitLab skipped 已按现有 tracker coarse status 映射为 canceled，不新增 skipped pipeline status |
| `missing-evidence` | 命中 §6.6 missing evidence 规则 |

同一个 run 或 task 可以命中多个 pattern。每个 pattern 的 drill-down item 必须包含
可读 reason，不能只返回分类 id。

## 8. API / Contract

新增 shared contract：

- `QualitySummaryResponse`
- `QualityMetric`
- `QualityTrendPoint`
- `FailurePatternSummary`
- `QualityDrilldownItem`
- `QualityDimension`

核心 API：

```text
GET /api/quality/summary
```

支持 query：

- `workflow`
- `taskType`
- `from`
- `to`
- `window=7d|30d`
- `pattern`
- `status`

响应结构：

```ts
interface QualitySummaryResponse {
  scope: {
    mode: "single-project" | "team-project";
    projectId?: string;
  };
  filters: {
    workflow?: string;
    taskType?: string;
    status?: string;
    pattern?: string;
    from: string;
    to: string;
    window: "7d" | "30d";
  };
  metrics: QualityMetric[];
  trends: QualityTrendPoint[];
  failurePatterns: FailurePatternSummary[];
  drilldown: QualityDrilldownItem[];
  dimensions: QualityDimension[];
  diagnostics: {
    invalidReportCount: number;
  };
}
```

核心 contract 字段：

```ts
type QualityMetricId =
  | "success-rate"
  | "failure-rate"
  | "rework-rate"
  | "ci-pass-rate"
  | "review-hit-rate"
  | "missing-evidence-rate"
  | "median-duration";

interface QualityMetric {
  id: QualityMetricId;
  label: string;
  value: number;
  unit: "percent" | "count" | "duration-ms";
  numerator?: number;
  denominator?: number;
  unknownCount?: number;
  previousValue?: number;
  delta?: number;
  direction: "up" | "down" | "flat" | "unknown";
}

interface QualityTrendPoint {
  metricId: QualityMetricId;
  bucketStart: string;
  bucketEnd: string;
  value: number;
  numerator?: number;
  denominator?: number;
  unknownCount?: number;
}

interface FailurePatternSummary {
  patternId:
    | "missing-tests"
    | "unclear-requirements"
    | "permission-issue"
    | "environment-issue"
    | "review-rework"
    | "ci-failure"
    | "missing-evidence";
  label: string;
  count: number;
  rate: number;
  topProject?: string;
  topWorkflow?: string;
  latestReason?: string;
  drilldownCount: number;
}

interface QualityDrilldownItem {
  itemId: string;
  patternIds: FailurePatternSummary["patternId"][];
  reason: string;
  projectId: string;
  workflow?: string;
  taskType?: string;
  issue?: { iid: number; title: string; url?: string };
  workItem?: { workItemId: string; title: string };
  task?: { taskId: string; title: string };
  run?: { runId: string; status: string };
  evidenceId?: string;
  updatedAt: string;
  target:
    | { kind: "run"; href: string }
    | { kind: "work-item"; href: string }
    | { kind: "evidence"; href: string };
}

interface QualityDimension {
  kind: "workflow" | "task-type" | "status" | "pattern";
  value: string;
  label: string;
  count: number;
}
```

`status` query 使用 V4.4 自己的 normalized analytics status，不直接暴露多个底层
枚举，避免 run、task 和 report 状态混用：

| `status` query | 来源 | 行为 |
| --- | --- | --- |
| `run-completed` | `RunReportArtifact.run.status === "completed"` | 只保留 completed run 相关 metric / trend / drill-down |
| `run-failed` | `RunReportArtifact.run.status === "failed"` | 只保留 failed run；`lastError.classification === "cancelled"` 仍在此 bucket 内 |
| `run-blocked` | `RunReportArtifact.run.status === "blocked"` | 只保留 blocked run |
| `task-needs-rework` | `effectiveTaskStatus(...) === "needs_rework"` 或存在 `needsReworkReason` | 只保留 review / operator 打回的 task |
| `task-skipped` | `effectiveTaskStatus(...) === "skipped"` | 只保留 operator 明确跳过的 task |
| `report-incomplete` | `WorkItemReport.overallStatus === "incomplete"` | 只保留报告本身不完整的 work item / task |

没有 `status` query 时，summary 使用全部可见数据源；`pattern` query 可与 `status`
叠加，先按 project scope 和时间窗口收敛，再应用 workflow / taskType / status /
pattern filters。

设计约束：

- orchestrator 负责聚合和分类；dashboard 只负责展示、筛选和跳转。
- contract 只返回 summary 和 references，不返回大段 logs 或 evidence 文件内容。
- drill-down item 必须能跳回已有详情页：run detail、work item detail 或 evidence
  tab。
- team mode 下 API 必须 project-scoped，延续现有 `x-issuepilot-project` 语义。
  `x-issuepilot-project` 是唯一 project scope 来源；`project` query 不参与服务端
  筛选。Reports UI 通过现有 Project Switcher 选择 active project，并在请求中发送
  `x-issuepilot-project`。如果 team mode 请求缺少该 header，server 返回 400
  `project_required`；如果请求同时携带 `project` query，server 返回 400
  `project_query_unsupported`，避免跨项目 analytics 的歧义。single-project 模式下
  不需要 header，响应的 `scope.mode` 为 `single-project`。
- 空数据返回稳定结构，不能靠异常状态驱动 UI。

## 9. Reports UI

`/reports` 页面保留现有 report list 和基础 counters，在上方或中段增加
**Quality Analytics** section。

### 9.1 Quality Summary Strip

展示 5-6 个紧凑指标：

- Success
- Failure
- Rework
- CI pass
- Review hit
- Missing evidence

每个指标显示当前值、分母说明、相比上一窗口的变化。指标不能只靠颜色表达好坏。

### 9.2 Trend Panel

默认展示 7 天趋势，支持切换 30 天。指标通过 segmented control 切换，避免一次画
多条线导致阅读困难。点击趋势点会更新 drill-down 列表。

### 9.3 Failure Patterns

展示 top patterns 排序列表。每行包含：

- pattern label
- count
- rate
- trend direction
- top project / workflow
- 最近一个典型 reason

### 9.4 Drill-Down Table

展示具体证据来源：

- project
- workflow
- issue / task
- run status
- pattern
- reason
- updatedAt
- target link

target link 规则：

- run 级：`/runs/<runId>`
- work item 级：`/work-items/<id>`
- evidence 级：`/work-items/<id>?view=evidence`

### 9.5 Filter Bar

支持 workflow、task type、window、status 和 pattern。project 不作为普通 filter：
team mode 继续使用 dashboard 顶栏 Project Switcher 控制 active project，Quality
Analytics API 请求跟随该 active project 发送 `x-issuepilot-project`。筛选必须写入
URL query，便于刷新恢复和分享；Project Switcher 的选择按现有 dashboard 机制持久化。

第一版不做 saved views。

## 10. 错误处理

- report store 不存在：返回空 summary，不返回 500。
- work-item store 不存在：run 指标仍可显示，work-item/task 相关指标返回 unknown
  bucket。
- 单个 report JSON 解析失败：跳过该 report，增加 diagnostics 计数
  `invalidReportCount`，并保留其它 report 的 summary。`invalid-report` 不作为
  Failure Pattern 展示给 reviewer，因为它不是用户任务质量问题，而是本地数据完整性问题。
- 无 CI 数据：不进入 CI pass rate 分母，显示 unknown CI count。
- 无 evidence 数据：进入 missing evidence 规则，不阻断其它指标。

## 11. 测试策略

### 11.1 Contract tests

覆盖 `QualitySummaryResponse`、`QualityMetric`、`QualityTrendPoint`、
`FailurePatternSummary` 和 `QualityDrilldownItem` 的 JSON round-trip 与枚举完整性。

### 11.2 Aggregator tests

使用 fixture 构造：

- completed / failed / blocked run，以及 `failed` + `lastError.classification === "cancelled"`
  的 stopped / cancelled attempt。
- needs_rework task。
- CI success / failed / unknown。
- unresolved review feedback。
- missing evidence / incomplete report。
- `x-issuepilot-project` scope，以及 workflow / task type / status / pattern filters。

断言所有指标分子、分母和 rate 精确匹配。

### 11.3 Pattern tests

覆盖 `missing-tests`、`unclear-requirements`、`permission-issue`、
`environment-issue`、`review-rework`、`ci-failure`、`missing-evidence`。同一个
item 命中多个 pattern 时，每个 pattern 都要有可解释 drill-down reason。

### 11.4 Server tests

覆盖 `GET /api/quality/summary`：

- 默认 7 天 window。
- 30 天 window。
- project-scoped team mode 隔离。
- query filter 改变 summary、trend 和 drill-down。
- 空 store 返回稳定空结构。

### 11.5 Dashboard tests

覆盖：

- Quality Summary、Trend、Failure Patterns 和 Drill-Down 渲染。
- 点击 metric / pattern 更新 URL query 和 drill-down。
- drill-down 链接跳到 run detail、work item detail 或 evidence tab。
- 空数据、unknown bucket、长 project/workflow 名称不破坏布局。

### 11.6 E2E / Acceptance

fake reports + fake work item reports 跑出一个 7 天 quality summary。至少覆盖一个
work item：两个 task，一个 completed、一个 needs_rework，并带 missing evidence。
dashboard Reports 页面能看到 pattern，并能 drill down 到对应 task / evidence。

代码交付前运行：

```bash
scripts/ci-equivalent-check.sh
```

文档或计划变更至少运行：

```bash
git diff --check
```

## 12. 验收标准

V4.4 完成时至少满足：

1. `/api/quality/summary` 能从 run reports 和 work-item reports 聚合核心质量指标。
2. 指标支持 `x-issuepilot-project` scope，以及 workflow、task type、status、pattern、
   7d / 30d window 筛选。
3. Failure patterns 能稳定识别测试缺失、需求不清、权限不足、环境问题、review
   返工、CI failure 和 missing evidence。
4. `/reports` 页面展示 Quality Summary、Trend、Failure Patterns 和 Drill-Down。
5. 点击指标或 pattern 能更新 URL query，并显示对应 run / work item / task /
   evidence 来源。
6. team mode 下 project A / project B 的质量数据互不可见。
7. 空数据和 unknown 数据有稳定、可读的 UI 状态。

## 13. 后续阶段

- V4.5：基于 V4.4 的 failure patterns 和 drill-down，生成 workflow / skills /
  prompt / 项目规则改进建议，并让 operator 接受、拒绝或延后。
- V4.6：把 quality evidence 来源扩展到 reviewer agent、test/evidence agent 或
  其它 runner adapter。
- V3：把已经验证的 quality analytics 接入 centralized storage、RBAC、审计和生产
  observability。
