# IssuePilot 设计规格说明

日期：2026-05-11
状态：待用户评审
仓库背景：当前仓库是 OpenAI Symphony 的 fork，用作 IssuePilot 的协议和参考实现来源。

## 1. 目标

IssuePilot 是一个面向公司内部研发流程的 AI 工程调度器，设计思想参考 Symphony。

它的核心目标是：把 GitLab Issue 变成隔离、可观测、可重试的 Codex 实现运行。工程师主要管理 Issue 状态和 Review Merge Request，而不是人工盯多个 agent 会话。

第一版必须跑通一个完整闭环：

```text
GitLab Issue 带 ai-ready label
  -> IssuePilot 自动认领
  -> 创建独立 git worktree
  -> 在 worktree 内启动 Codex app-server
  -> Codex 完成代码修改并提交
  -> 分支推送到 GitLab
  -> 创建或更新 Merge Request
  -> 回写 Issue 评论
  -> Issue 进入 human-review
  -> 人工 review 并手动 merge MR
  -> IssuePilot 自动关闭 GitLab Issue
```

## 2. 与 Symphony 的关系

当前 fork 不作为生产代码直接移植。

IssuePilot 参考它的这些部分：

- 根目录 `SPEC.md` 中的语言无关服务边界
- 基于 workflow 文件的项目级 agent 契约
- 每个 Issue 一个隔离 workspace
- orchestrator 独占调度状态
- Codex app-server 的 JSON-RPC 生命周期
- dashboard 和事件流的可观测性思路

不直接继承：

- Elixir/OTP 技术栈
- Linear tracker 假设
- 原型级 dashboard 实现
- 直接把 ticket 写操作全部交给 agent 的边界

IssuePilot 的产品实现采用 TypeScript，P0 直接以 GitLab 和 Codex app-server 作为一等集成。

## 3. P0 非目标

P0 必须保持范围克制，先证明核心闭环。

不做：

- 多租户权限系统
- 远程 worker 池
- Kubernetes 沙箱
- 可视化拖拽工作流
- 自动合并主干
- Claude Code runner
- 任意 GitLab REST/GraphQL 工具
- dashboard 上的复杂操作按钮
- 长期分析数据库

这些方向可以保留扩展点，但不能进入第一版实现范围。

## 4. 技术选型

### 4.1 语言和仓库形态

使用：

- TypeScript
- Node.js 22 LTS
- pnpm workspace
- Turborepo，可用于本地开发编排
- Vitest
- ESLint
- Prettier

### 4.2 应用划分

```text
apps/
  orchestrator/
    本地 daemon 和 CLI。
    负责轮询、认领、调度、Codex app-server 会话、GitLab 写操作、
    event store、日志和本地 API。

  dashboard/
    Next.js App Router 控制台。
    只读取 orchestrator API 和 SSE 事件流，不承载后台调度任务。
```

不要把 orchestrator 放进 Next.js。orchestrator 是长运行 worker，需要管理 child_process、stdio JSON-RPC、git worktree、计时器、重试和文件系统状态。Next.js 适合做控制台 UI，不适合作为调度器运行时。

### 4.3 包划分

```text
packages/
  core/
    领域模型、调度状态、orchestration contracts、事件类型。

  workflow/
    WORKFLOW.md 解析、校验、默认值、环境变量解析和 prompt 渲染。

  tracker-gitlab/
    GitLab Issue、label、note、Merge Request、pipeline adapter。

  credentials/
    GitLab OAuth 2.0 Device Authorization Grant 客户端、本地 credentials 文件存储（`~/.issuepilot/credentials`，`0600`）、access token 自动 refresh、daemon/CLI 共享的 credential resolver。

  workspace/
    bare mirror、git worktree 生命周期、分支准备、路径安全、hooks。

  runner-codex-app-server/
    Codex app-server JSON-RPC stdio client。

  observability/
    event store、JSONL logs、run snapshot、pino logger。

  shared-contracts/
    orchestrator 和 dashboard 共享类型。
```

### 4.4 推荐库

- CLI：`commander` 或 `cac`
- orchestrator HTTP API：Fastify
- dashboard：Next.js App Router
- UI：Tailwind/shadcn
- 日志：`pino`
- 配置校验：`zod`
- workflow 解析：`gray-matter` + YAML parser
- prompt 模板：`liquidjs`
- 进程执行：`execa`
- GitLab API：`@gitbeaker/rest`
- 本地事件存储：JSON + JSONL

Git 操作使用真实 Git CLI，通过 `execa` 调用。不要在 P0 使用 JS git 库，因为 mirror、worktree、fetch、push、branch 的行为应该尽量贴近真实开发环境，也更容易排障。

P0 不引入数据库。本地状态存放在 `~/.issuepilot/state`。

## 5. 产品形态

P0 是一个本地 daemon：

```bash
pnpm issuepilot run --workflow WORKFLOW.md --port 4738
```

这个命令启动：

- orchestrator loop
- Codex app-server runner 管理
- 本地 JSON/JSONL 事件存储
- 本地 API server

P0 源码 checkout 模式下，Next.js dashboard 单独通过 `pnpm dev:dashboard`
启动，默认读取 `http://127.0.0.1:4738` 的 orchestrator API。

P0 dashboard 只读，不提供操作按钮。

## 6. Workflow 契约

每个目标仓库拥有自己的 agent 契约文件：

```text
WORKFLOW.md
```

`WORKFLOW.md` 是长期默认入口，保持与根目录开源 `SPEC.md` 一致。
`.agents/workflow.md` 仅作为显式 `--workflow` 路径或 P0 迁移期兼容路径；
当未显式指定 workflow 时，daemon 优先读取仓库根 `WORKFLOW.md`。

文件结构：

- YAML front matter：机器可读运行配置
- Markdown body：传给 agent 的任务 prompt

示例：

```md
---
tracker:
  kind: gitlab
  base_url: "https://gitlab.example.com"
  project_id: "group/project"
  token_env: "GITLAB_TOKEN"
  active_labels:
    - ai-ready
    - ai-rework
  running_label: ai-running
  handoff_label: human-review
  failed_label: ai-failed
  blocked_label: ai-blocked

workspace:
  root: "~/.issuepilot/workspaces"
  strategy: worktree
  repo_cache_root: "~/.issuepilot/repos"

git:
  repo_url: "git@gitlab.example.com:group/project.git"
  base_branch: main
  branch_prefix: ai

agent:
  runner: codex-app-server
  max_concurrent_agents: 1
  max_turns: 10
  max_attempts: 2
  retry_backoff_ms: 30000

codex:
  command: "codex app-server"
  approval_policy: never
  thread_sandbox: workspace-write
  turn_timeout_ms: 3600000
  turn_sandbox_policy:
    type: workspaceWrite

poll_interval_ms: 10000

hooks:
  after_create: |
    pnpm install
  before_run: |
    git fetch origin
  after_run: |
    pnpm test
---

你是当前仓库的 AI 工程师。

Issue: {{ issue.identifier }}
Title: {{ issue.title }}
URL: {{ issue.url }}

Description:
{{ issue.description }}

要求：
1. 先阅读相关代码，再开始编辑。
2. 所有工作必须限制在提供的 workspace 内。
3. 完成 Issue 要求的实现。
4. 运行必要验证。
5. 提交代码。
6. 创建或更新 GitLab Merge Request。
7. 更新 Issue，说明实现内容、验证结果、风险点和 MR 链接。
8. 成功后把 Issue 移交到 human-review。
9. 如果缺少信息、权限或密钥，标记 ai-blocked 并说明阻塞原因。
```

必须支持的模板变量：

```text
{{ issue.id }}
{{ issue.iid }}
{{ issue.identifier }}
{{ issue.title }}
{{ issue.description }}
{{ issue.labels }}
{{ issue.url }}
{{ issue.author }}
{{ issue.assignees }}
{{ attempt }}
{{ workspace.path }}
{{ git.branch }}
```

加载规则：

- 启动时解析失败，进程直接退出
- 运行中 reload 失败，继续使用 last-known-good workflow
- reload 错误展示在 dashboard 和日志中
- `workspace.root` 和 `workspace.repo_cache_root` 在加载阶段展开 `~` / `$HOME`
- `tracker.token_env` **可选**。若提供则必须是合法环境变量名（`[A-Za-z_][A-Za-z0-9_]*`），运行时该环境变量缺失会按 `auth` 类错误报告但**不**让 workflow 加载失败；缺失或未提供时 daemon 会回退到 `~/.issuepilot/credentials`（OAuth credentials 文件，由 `issuepilot auth login` 颁发）；如果两条来源都没有，daemon 拒绝启动并提示运行 `issuepilot auth login`
- 环境变量与 credentials 文件中的 secret 只在运行时解析，不写入事件日志、dashboard、prompt
- prompt 渲染只允许上面列出的白名单变量；运行时 context 中的额外字段渲染为空并记录 warn
- workflow 文件不能把 Codex sandbox 提升到 `danger-full-access`（`thread_sandbox` 层）或 `dangerFullAccess`（`turn_sandbox_policy.type` 层）；两个字段使用不同格式是因为它们对应 Codex app-server 的不同 RPC 参数，前者作用于 thread 级别使用 kebab-case，后者作用于 turn 级别使用 camelCase
- `poll_interval_ms`：orchestrator 主循环拉取 GitLab 候选 issue 的间隔，单位毫秒，默认 `10000`（10 秒）

## 7. GitLab 状态模型

P0 使用 GitLab label 表达工作流状态。

Label：

```text
ai-ready       候选任务，可被 IssuePilot 拾取
ai-running     已认领，正在执行
human-review   MR 已创建，等待人工 review
ai-rework      人工主动打回（从 human-review 阶段重新打开），
               IssuePilot 可以再次认领并执行；
               语义上是独立的"重做"触发器，不是 ai-ready 的别名
ai-merging     预留给后续自动合并流程（P1/P2，P0 不使用）
ai-failed      执行失败，需要人工介入
ai-blocked     缺少外部信息、权限或密钥，无法继续
```

P0 支持的状态流转：

```text
ai-ready -> ai-running -> human-review -> GitLab issue closed
ai-ready -> ai-running -> ai-failed
ai-ready -> ai-running -> ai-blocked
ai-rework -> ai-running -> human-review -> GitLab issue closed
ai-rework -> ai-running -> ai-failed
ai-rework -> ai-running -> ai-blocked
human-review + MR closed without merge -> ai-rework
```

`human-review -> GitLab issue closed` 只在对应 MR 已被人工 merge 后由 orchestrator 自动收尾。`ai-merging` 只作为 P1/P2 保留状态。P0 不自动合并。

与当前 Symphony 参考实现的映射：

```text
Symphony Linear state     IssuePilot GitLab label
Todo                      ai-ready
In Progress               ai-running
Human Review              human-review
Rework                    ai-rework
Merging                   ai-merging
Done/Closed/Cancelled     GitLab issue closed 或团队终态 label
```

认领流程：

1. 查询带 `ai-ready` 或 `ai-rework` 的 open issue。
2. 跳过带 `ai-running`、`human-review`、`ai-failed`、`ai-blocked` 的 issue。
3. 认领前重新读取 issue。
4. 将 active label 替换为 `ai-running`。
5. 再次读取 issue，确认认领成功。
6. 只有确认成功的进程继续执行。

这是本地 P0 足够实用的乐观并发策略。

## 8. Orchestrator

orchestrator 独占调度状态。它不直接包含 GitLab API 细节、worktree 实现细节或 app-server 协议细节。

主循环：

```text
1. reload workflow。
2. reconcile running issues and human-review issue closure。
3. 拉取 GitLab candidate issues。
4. 按 priority、updated_at、iid 排序。
5. 检查并发槽位。
6. claim issue。
7. 准备 workspace 和 branch。
8. 执行 hooks。
9. 启动 Codex app-server runner。
10. 观察事件流。
11. 执行 post-run reconciliation。
12. 切换 label 并写 final events。
13. 需要时安排 retry。
```

P0 默认并发：

```yaml
agent:
  max_concurrent_agents: 1
```

内部运行态至少包含：

```text
running
claimed
retrying
completed
failed
blocked
last_config_reload
last_poll
```

orchestrator 状态保存在内存中。重启恢复依赖 GitLab label 和保留的 workspace，不依赖恢复所有计时器。

## 9. Workspace 与 Git 策略

P0 默认使用 bare mirror + git worktree。

目录结构：

```text
~/.issuepilot/
  repos/
    <project-slug>.git/              # bare mirror
  workspaces/
    <project-slug>/
      <issue-iid>/                   # issue worktree
  state/
    orchestrator.json
    runs/
    events/
    logs/
```

workspace 是调度层概念，表示分配给单个 Issue 的隔离工作目录。P0 用 git worktree 实现这个目录，以节省磁盘和加快创建速度。

Mirror 流程：

```text
ensureMirror()
  如果 mirror 不存在：
    git clone --mirror <repo_url> <repo-cache-path>
    将 remote.origin.fetch 迁移为 +refs/heads/*:refs/remotes/origin/*
    git --git-dir=<repo-cache-path> fetch --prune origin
  如果 mirror 已存在：
    将 remote.origin.fetch 迁移为 +refs/heads/*:refs/remotes/origin/*
    git --git-dir=<repo-cache-path> fetch --prune origin
```

Worktree 流程：

```text
ensureWorktree(issue)
  branch = ai/<issue-iid>-<title-slug>
  校验 refs/remotes/origin/<base_branch> 在 mirror 中存在；仅未迁移旧缓存可 fallback 到 refs/heads/<base_branch>；否则 blocked 并报告可用分支
  git --git-dir=<mirror> worktree add <workspace> -B <branch> origin/<base_branch>
```

base branch 优先从 `refs/remotes/origin/<base_branch>` 解析。只有尚未迁移到
remote-tracking fetch refspec 的旧缓存，才允许临时 fallback 到
`refs/heads/<base_branch>`；迁移后的 mirror 不再把本地 `refs/heads/*` 作为 base
branch 来源，避免使用已被远端删除或重命名的 stale branch。

如果 workspace 已存在：

- 校验它在配置的 workspace root 下
- 校验它属于期望的 project 和 branch
- fetch 最新 origin 状态
- 状态安全时复用
- Git 状态不可安全恢复时标记失败并保留现场

安全要求：

- Codex cwd 必须是当前 issue worktree，不能是源仓库，也不能是 `~/.issuepilot`
- 路径必须 canonicalize，防止 symlink escape
- hooks 只在 workspace 内执行
- branch 名和路径必须 sanitize
- 失败 workspace 保留供排障

分支命名：

```text
ai/<issue-iid>-<title-slug>
```

## 10. Codex App-Server Runner

P0 使用 Codex app-server，不使用 Codex CLI 作为主 runner。

runner 职责：

> 字段格式说明：`thread/start` 的 sandbox 参数直接传 `<thread_sandbox>` 字符串（kebab-case 值，如 `"workspace-write"`）；`turn/start` 的 sandboxPolicy 参数传 `turn_sandbox_policy` 对象（camelCase 值，如 `{ type: "workspaceWrite" }`）。两者对应 Codex app-server 不同层级的 RPC 字段，不可互换。
> runner 发送 `turn/start` 前会把简写策略补成 Codex app-server 需要的完整对象：`workspaceWrite` 默认 writable root 为当前 issue worktree，network access 关闭；`readOnly` 默认 network access 关闭。

```text
1. 在 issue workspace 内启动 `codex app-server`。
2. 发送 initialize，包含 `{ clientInfo: { name, version }, capabilities }`。
3. 发送 initialized。
4. 发送 thread/start，包含 cwd、sandbox（使用 thread_sandbox kebab-case 值）、approval policy、dynamic tools。
5. 发送 turn/start，包含渲染后的 input text、cwd、sandboxPolicy（使用 turn_sandbox_policy camelCase 对象）。
6. 从 stdout/stderr stream 读取 newline-delimited JSON-RPC 消息。
7. 处理 completed、failed、cancelled、timeout、port exit。
8. 处理 approval requests。
9. 执行 dynamic tool calls。
10. 向 orchestrator 和 dashboard 发出标准化事件。
11. Issue 仍 active 时，在 max_turns 内继续下一 turn。
```

必须标准化的 app-server 事件：

```text
session_started
turn_started
notification
tool_call_started
tool_call_completed
tool_call_failed
unsupported_tool_call
approval_auto_approved
approval_required
turn_input_required
turn_completed
turn_failed
turn_cancelled
turn_timeout
port_exit
malformed_message
```

默认 approval 策略：

```yaml
codex:
  approval_policy: never
  thread_sandbox: workspace-write
  turn_sandbox_policy:
    type: workspaceWrite
```

如果 app-server 请求用户输入，P0 自动回复：

```text
This is a non-interactive IssuePilot run. Operator input is unavailable. If blocked, record the blocker and mark the issue ai-blocked.
```

runner 不能静默等待人工输入。

## 11. GitLab Dynamic Tools

P0 向 Codex app-server 暴露窄范围 GitLab tool allowlist。

工具：

```text
gitlab_get_issue
gitlab_update_issue_labels
gitlab_create_issue_note
gitlab_update_issue_note
gitlab_create_merge_request
gitlab_update_merge_request
gitlab_get_merge_request
gitlab_list_merge_request_notes
gitlab_get_pipeline_status
```

P0 不暴露任意 GitLab REST 或 GraphQL。

工具规则：

- 所有写操作记录为事件
- token 不暴露给模型、不写日志、不进 dashboard
- tool error 返回结构化失败 payload
- 不支持的工具 fast-fail，不能卡住 runner
- tool schema 使用明确 JSON schema，在 `thread/start` 传给 app-server

边界：IssuePilot 不是纯 toolchain 写入模型。agent 可以通过 allowlist tools 完成
正常 handoff；orchestrator 仍拥有认领、post-run reconciliation、失败 / 阻塞 /
closing note、label transition，以及 MR / note / label 兜底写入等确定性平台动作。

GitLab tools 用于让 agent 正常完成 issue handoff。orchestrator 仍保留 deterministic post-run reconciliation。

## 12. Post-Run Reconciliation

Codex app-server 的 `turn/completed` 不等于任务成功。

runner 结束后，orchestrator 必须验证：

```text
1. worktree 有 commit，或者明确是无需代码变更的结果。
2. 本地 branch 存在。
3. branch 已推送到 GitLab。
4. source branch 对应 Merge Request 存在。
5. Issue 有结构化 handoff note。
6. Issue labels 已从 ai-running 切换到 human-review。
```

如果 agent 完成代码但漏掉平台动作，orchestrator 尝试兜底：

```text
agent 已 commit 但未 push        -> orchestrator push（force-with-lease，防止覆盖远端他人推送）
push 冲突（non-fast-forward）    -> 记录 reconcile_push_conflict 事件 + 分类为 failed，不强制覆盖
branch 已 push 但没有 MR         -> orchestrator create MR
MR 存在但 title/body 过期        -> orchestrator update MR
没有最终 Issue note             -> orchestrator 写结构化 handoff note（参见 Issue note 策略，下文）
labels 未切换                    -> orchestrator 切换 labels
```

fallback MR 标题：

```text
[AI] <issue title>
```

fallback MR body 至少包含：

```text
Issue link
Implementation summary
Validation summary
Risks
Generated by IssuePilot
```

reconciliation 失败时，除非属于真正外部阻塞，否则 run 进入 `ai-failed`。

## 13. 失败与阻塞分类

Blocked：

```text
GitLab token 缺失
GitLab 403 permission denied
repo clone 或 push 权限缺失
workflow git.base_branch 在 mirror 中不存在
Codex auth 不可用
必要 secret 缺失
Issue 信息不足，且 agent 明确报告 blocker
```

Failed：

```text
Codex turn failed
Codex turn timeout
app-server process 异常退出
阻止执行的 hook failure
max_turns 后 tests 仍失败
MR 创建重试后仍失败
workspace git 状态不可安全恢复
```

Retryable：

```text
GitLab 5xx
GitLab rate limit
network timeout
临时 git fetch/push 失败
app-server startup failure
```

P0 retry 默认值：

```yaml
agent:
  max_attempts: 2
  retry_backoff_ms: 30000
```

重试耗尽后，写一条简洁 Issue note，并设置 `ai-failed`。

## 14. Dashboard

P0 dashboard 使用 Next.js，读取 orchestrator API。

默认地址：

```text
http://127.0.0.1:4738
```

P0 dashboard 只读。

页面：

```text
Service header
  service status
  workflow path
  GitLab project
  poll interval
  concurrency
  last config reload

Summary
  running
  retrying
  human-review
  failed
  blocked

Runs table
  issue iid
  title
  labels
  runner status
  turn count
  last event
  elapsed time
  branch
  MR link
  workspace path

Run detail
  timeline
  thread_id
  turn_id
  tool calls
  approval events
  token usage，如果可用
  failure reason
  recent logs
```

P0 不提供 dashboard 操作：

```text
不启动任务
不停止任务
不重试任务
不改 label
不删除 workspace
```

这些操作可以在 run loop 稳定后再加入。

## 15. Orchestrator API

orchestrator 暴露本地 API，供 dashboard 和调试使用。

```text
GET /api/state
GET /api/runs
GET /api/runs/:runId
GET /api/events?runId=<runId>
GET /api/events/stream
```

`/api/events/stream` 使用 SSE 推送实时事件。

API 默认绑定 `127.0.0.1`。

## 16. 可观测性存储

使用本地文件：

```text
~/.issuepilot/state/
  orchestrator.json
  runs/
    <project-slug>-<issue-iid>.json
  events/
    <project-slug>-<issue-iid>.jsonl
  logs/
    issuepilot.log
```

事件结构：

```ts
/**
 * EventType 是所有合法事件类型的字面量联合，
 * 定义在 @issuepilot/shared-contracts/src/events.ts。
 * 不使用 string，可在编译期检查拼写并让 dashboard 安全枚举事件类型。
 */
type IssuePilotEvent = {
  id: string;
  runId: string;
  issue: {
    id: string;
    iid: number;
    title: string;
    url: string;
    projectId: string;
  };
  type: EventType;   // 不能是宽泛的 string，必须使用 shared-contracts 定义的 EventType
  message: string;
  threadId?: string;
  turnId?: string;
  data?: unknown;
  createdAt: string;
};
```

日志要求：

- 每个事件有 `runId`
- 每个 issue 事件有 GitLab project 和 issue iid
- 每个带 session context 的 app-server 事件有 `threadId` 和 `turnId`
- secrets 必须 redacted
- GitLab 写操作必须记录为结构化事件

## 17. 安全边界

P0 面向可信本地或内网环境。

必须具备：

- Codex 只在 issue worktree 内运行
- workspace path canonicalize，并校验在 configured root 下
- app-server turn sandbox 限定在 workspace
- GitLab token 从下列来源解析（按优先级）：①`tracker.token_env` 指向的环境变量；② `~/.issuepilot/credentials` 中的 OAuth access token（`issuepilot auth login` 颁发）。文件权限强制 `0600`，目录权限 `0700`；权限不符时 daemon 拒绝读取并提示用户修复
- token、refresh token、authorization device code、verification URL 都不进入 prompt、event data、dashboard、logs；redact 单元测试覆盖三种 GitLab token 模式（`glpat-`、`gloas-`、自定义 OAuth）
- dashboard 默认绑定 localhost
- GitLab dynamic tools 使用窄 allowlist
- hooks 只在 workspace 内执行
- 自动 approval 只能在 workspace sandbox 内生效

P0 不提供对恶意代码的强沙箱。如果公司要求更强隔离，后续再加入 Docker 或 Kubernetes worker。

## 18. 测试策略

### 18.1 单元测试

Workflow：

- front matter 解析
- 默认值
- env resolution
- invalid YAML
- prompt rendering
- 缺少必填配置

GitLab adapter：

- candidate issue listing
- label claim
- label transition
- Issue note create/update
- MR create/update
- pipeline status
- 403/404/5xx 分类

Workspace：

- mirror initialization
- mirror fetch
- worktree creation
- existing worktree reuse
- branch sanitize
- symlink/path escape prevention
- hook success/failure

Codex app-server runner：

- initialize/initialized
- thread/start
- turn/start
- turn/completed
- turn/failed
- turn/cancelled
- approval request auto handling
- user input auto response
- supported tool call
- unsupported tool call
- malformed line
- timeout
- port exit

Orchestrator：

- candidate selection
- duplicate claim prevention
- retry backoff
- blocked classification
- failed classification
- success reconciliation
- stale label cleanup

Dashboard/API：

- `/api/state`
- `/api/runs`
- `/api/runs/:runId`
- SSE event delivery

### 18.2 集成测试

使用 fake GitLab 和 fake Codex app-server。

场景：

```text
1. fake GitLab 暴露一个 open + ai-ready issue。
2. IssuePilot 认领 issue。
3. workspace 创建 worktree。
4. fake Codex 发出 tool calls 和 turn/completed。
5. IssuePilot 通过 fake GitLab 完成 push/MR/comment/label。
6. Issue 最终进入 human-review。
7. fake MR 状态切为 merged 后，IssuePilot 自动关闭 issue。
8. event store 包含完整 timeline。
```

### 18.3 真实 Smoke Test

使用一个一次性 GitLab 测试项目。

验收：

```text
1. 创建一个小 issue，例如 README 文案修改。
2. 添加 ai-ready。
3. 本地启动 IssuePilot。
4. 验证 worktree 创建。
5. 验证 Codex app-server run。
6. 验证 branch push。
7. 验证 MR 创建。
8. 验证 Issue note。
9. 验证 label human-review。
10. 手动 merge MR。
11. 验证 Issue 自动关闭。
12. 验证 dashboard timeline。
```

## 19. P0 实现里程碑

M1：TypeScript skeleton

- pnpm workspace
- orchestrator app
- dashboard app
- shared packages
- test tooling

M2：Workflow loader

- 解析 `WORKFLOW.md`
- 校验 config
- 渲染 prompt
- hot reload + last-known-good fallback

M3：GitLab adapter

- issue list
- label transitions
- notes
- MR create/update
- pipeline read

M4：Workspace manager

- bare mirror
- worktree creation
- branch preparation
- path safety
- hooks

M5：Codex app-server runner

- JSON-RPC lifecycle
- approval handling
- dynamic GitLab tools
- event emission
- turn continuation

M6：Orchestrator

- poll
- claim
- dispatch
- retry
- reconciliation
- status snapshots

M7：Dashboard

- Next.js UI
- orchestrator API integration
- SSE timeline
- run detail

M8：端到端验证

- fake GitLab + fake Codex test
- real GitLab smoke test
- local usage docs

## 20. 后续版本路线图

本路线图区分 P0、V1、V2，避免把“当前可试运行能力”和“稳定发布能力”混在一起。
README 只保留摘要；本节是 roadmap 的产品源头。

路线原则：**先把本地版 / 团队机器版的研发流程能力打磨到足够完备，再做生产可用版本**。
登录、权限、预算、生产部署、集中存储、审计和观测等生产环境因素统一后置到 V3；
V4 优先在现有 V2.x runtime 上补齐流程智能和体验闭环。

### P0：本地单机闭环（已闭合）

目标：证明 GitLab Issue 到 MR、人工 merge 后自动关闭 Issue 的本地闭环成立。

- 本地 daemon：orchestrator + Fastify HTTP API + SSE。
- GitLab Issue label 驱动：`ai-ready`、`ai-running`、`human-review`、
  `ai-rework`、`ai-failed`、`ai-blocked`。
- Codex app-server runner：thread / turn 生命周期、非交互 input fallback、
  notification 缓冲和标准化事件。
- git workspace：bare mirror + worktree，失败现场和 event logs 保留。
- 自动创建或更新 MR，写结构化 handoff note，并支持 marker 驱动的重启恢复。
- 失败 / 阻塞路径写结构化 failure / blocked note。
- 人工 merge MR 后，IssuePilot 写 closing note、移除 `human-review` 并关闭
  GitLab Issue。
- 只读 Next.js dashboard：overview、run detail、timeline、tool calls、logs。
- fake GitLab + fake Codex E2E，以及真实 GitLab smoke runbook / smoke wrapper。
- P0 event contract 收敛到 `@issuepilot/shared-contracts`，dashboard 不依赖
  runner raw payload。

### V1：稳定本地发布（本地试点可用）

目标：不改变单机执行模型，把 P0 闭环变成可安装、可重复、适合内部试点团队使用
的稳定版本。当前 V1 以本地 tarball 作为发布物，先证明安装命令体验；后续可在
不改变 CLI contract 的前提下发布到内部 registry。

- ✅ 通过 npm-compatible package tooling 提供可安装 CLI 分发，安装后暴露
  `issuepilot` 可执行命令。
- ✅ 安装后的本地启动路径：`issuepilot run --workflow ...` 启动 daemon/API，并提供
  已安装的 dashboard 启动命令。
- ✅ release gate 固定化：format、lint、typecheck、build、unit tests、fake E2E、
  installed CLI smoke、smoke runner 和 `git diff --check` 纳入 `pnpm release:check`。
- ✅ auth refresh、token rotation、日志脱敏、failed / blocked run 排障手册。
- ✅ 文档收口：README、getting-started、smoke runbook、CHANGELOG 与本 spec 同步。
- ✅ source-checkout 继续作为贡献者开发和紧急回滚路径保留。
- ✅ 安装态 daemon / dashboard 启动路径已验证，真实 GitLab smoke 已由操作者确认通过。
- 🚧 版本化 tag：包含 release notes、回滚说明和本地闭环兼容性预期。
- 🚧 workflow schema、event contract、CLI 命令、dashboard API 进入稳定窗口；真实 smoke 的
  Issue / MR / dashboard evidence 链接待归档。

### V2：团队可运营版本

V2 的详细设计以
`docs/superpowers/specs/2026-05-15-issuepilot-v2-team-operable-design.md`
为准；该文件顶部维护 Phase 顺序、当前进度、补充 spec 和 plan 的对应矩阵。本节只保留产品路线摘要。

当前 V2 进度：Phase 1 Team Runtime Foundation、Phase 2 Dashboard Operations、
Phase 3 CI Feedback、Phase 4 Review Feedback Sweep、Phase 5 Workspace
Retention 已全部合入 `main`。V2.5 / V2.6 已在此基础上完成 Command Center
和 dashboard shell 的产品化打磨。

目标：从“个人单机”升级为“团队共享”，可以在内网或团队机器上承载日常工作。

- 使用中心化 `issuepilot-config/`：`issuepilot.team.yaml` 管理 server /
  scheduler / projects roster，`projects/*.yaml` 管理项目事实，
  `workflows/*.md` 管理可复用 workflow profile。
- 单 daemon 支持多项目 workflow 配置；并发从 1 扩展到 2-5，加入槽位调度和
  lease 策略。
- dashboard 增加基础操作：`retry`、`stop`、`archive run`。
- CI 状态读取，CI 失败自动回流到 `ai-rework`。
- PR/MR review feedback sweep，把人工 review 评论喂给下一轮 agent。
- review 工作流打磨：dashboard 和报告中直接展示 handoff / failure / closing note
  的结构化字段。
- workspace 清理和保留策略：按状态、时间和大小分级处理，失败现场默认保留。
- V2 仍保留人工 merge 默认路径；可选自动 merge 下沉到 V3 生产权限 / 审计 /
  approval 策略里做。

### V2.5：Command Center

目标：把“概览页 + 运行详情页”合并成 Linear 风格的 Command Center，让运维人员
在一个屏幕里完成 triage、review 和质量观察；GitLab notes 与 dashboard 共用同一份事实。

- `RunReportArtifact` 持久化在 `~/.issuepilot/.../reports/<runId>.json`，
  与 JSONL 事件存储并排，作为 dashboard、GitLab note、Markdown 报告和
  merge-readiness dry run 的统一事实来源。
- Command Center 首页支持 List / Board 视图，并围绕 IssuePilot run 而不是通用
  ticket 管理建模。
- Run Detail 升级为 Review Packet，直接展示 handoff、validation、risks、
  follow-ups、checks 和 merge-readiness 判定结果。
- Reports 页面聚合 ready-to-merge、blocked、failed、耗时等本地质量指标。
- Merge readiness 仅做 dry run，不调用 GitLab merge API。

### V2.6：Dashboard shell + 布局重构

目标：在 V2.5 内容堆完之后，把 Command Center 的信息密度调到工程运营工具应有的水平。

- 顶部水平导航替换左侧 sidebar，释放 board 视图横向空间。
- List / Board 使用混合 inspector：list 保留 split-pane，board 使用 GitLab 风右侧
  overlay。
- 三个主页面统一 `max-w-[1440px]`，避免页面切换时主容器宽度抖动。
- ServiceHeader 折叠低频 metadata，Reports counter 增加 7 日趋势 sparkline。

后续执行顺序：**先做 V4 智能研发工作台，再做 V3 生产化执行平台**。这里的
V3 / V4 是能力域编号，不表示必须按数字顺序交付；当前判断是先验证研发流程智能
是否真正提升交付质量，再把已经验证的能力平台化。

### V4：智能研发工作台

V4 的详细设计以
`docs/superpowers/specs/2026-05-17-issuepilot-v4-intelligent-workbench-design.md`
为准；该文件同时记录了“先做 V4，再做 V3”的 roadmap 决策。本节只保留产品路线摘要。

目标：先在现有 V2.x 本地 / 团队 runtime 上，超越“单 Issue 单 run”模型，
成为能理解、拆解、编排和改进研发流程的智能工作台。V4 不负责部署、权限、
预算这些平台底座，而是专注研发流程智能；等能力验证清楚后，再由 V3 把这些
能力生产化。

- 大 Issue 拆解与编排：自动把大 Issue 拆成可执行子任务，识别顺序、并行度、
  共享上下文和回滚边界。
- 跨 Issue 依赖分析：发现 blocker、重复工作、上下游依赖和可合并任务，在
  dashboard 中形成研发工作图谱。
- 多 agent 协作：coding agent、reviewer agent、test/evidence agent 等角色分工，
  支持子任务级协作和汇总。
- 智能 review 工作流：自动总结 MR 风险、归类 review 评论、生成返工计划，并把
  review 反馈转成下一轮 agent 的结构化输入。
- 验收材料自动生成：产出截图、录屏、Playwright walkthrough video、测试证据、
  风险清单和可直接贴到 MR / Issue 的验收报告。
- 质量与过程分析：分析成功率、返工率、CI 通过率、review 命中率、耗时瓶颈和
  高风险 workflow。
- workflow / skills 持续改进：根据失败模式推荐 workflow、skills、prompt 和项目规则
  调整，形成可审计的改进闭环。
- 多执行器生态：支持 Claude Code、内部 coding agent 或其他 runner adapter，并用
  统一报告和审计模型管理其输出。

### V3：生产化执行平台

目标：把 V2.x 的本地/团队机器能力，以及 V4 已验证的研发流程智能，升级成可正式
部署、治理、审计和扩容的内部 AI 工程执行平台。V3 不追求重新发明更聪明的工作流，
而是让已经验证的能力在生产环境可控、可观测、可恢复。

- 部署形态：Docker / Compose / Kubernetes，明确 API server、dashboard、
  worker、storage 的进程边界和升级方式。
- 多 worker 执行：local / SSH / container worker，带 heartbeat、容量上报、
  任务派发、失败恢复和队列回收。
- 生产 sandbox：Docker / Kubernetes sandbox 替代单机 sandbox，为不同项目提供
  隔离的 filesystem、network 和 secret 注入策略。
- 身份与权限：接入登录态，建立项目级、团队级、管理员级权限；所有 dashboard
  操作和自动动作都写入带操作者身份的 audit log。
- 预算与配额：按项目 / 团队限制 token、运行时长、并发、成本和重试次数，超限时
  进入可解释的 blocked / approval 流程。
- 持久化存储：Postgres 作为生产 run history、reports、leases、audit 和配置状态
  存储；SQLite / JSONL 仅保留为本地开发或单机模式。
- Webhook + poll 混合调度：GitLab webhook 用于实时触发，poll 作为兜底。
- GitLab 审计与 secret 治理：集中 credential store、token rotation、最小权限访问、
  全链路 redaction 和敏感字段泄漏测试。
- 生产合并策略：在 V2.5 merge-readiness dry run 基础上，增加带权限、approval、
  CI 和 audit 约束的可选自动 merge。
- 观测与运维：OpenTelemetry、结构化日志、metrics、trace、Grafana / Loki 或内部
  观测平台集成；提供 backup / restore、migration、升级 / 回滚 runbook。

## 21. MVP Definition of Done

P0 完成标准：

```text
1. 带 ai-ready 的 GitLab Issue 能被自动拾取。
2. IssuePilot 将 Issue 切到 ai-running。
3. 每个 Issue 在 ~/.issuepilot/workspaces 下创建独立 git worktree。
4. Codex app-server 在该 worktree 内启动。
5. 渲染后的 workflow prompt 包含 issue 和 workspace context。
6. Codex 可以调用 allowlisted GitLab dynamic tools。
7. 代码变更被提交。
8. 分支推送到 GitLab。
9. Merge Request 被创建或更新。
10. Issue 收到 handoff note。
11. 成功时 labels 进入 human-review。
12. MR 被人工 merge 后，IssuePilot 自动关闭 GitLab issue。
13. 失败或阻塞时 labels 进入 ai-failed 或 ai-blocked。
14. Dashboard 展示 run timeline、app-server session、MR link 和 logs。
15. failed runs 保留 workspace 和 event logs 供排障。
```

## 22. 已确认决策

以下决策已确认，并作为 implementation plan 的输入：

1. Dashboard UI kit：Tailwind/shadcn。
2. orchestrator HTTP server：Fastify。
3. GitLab 认证方式：支持三种凭据来源，**daemon 启动时按下面顺序解析**，第一个可用即采用，后续来源不再读取。
   - **来源 A — 静态 token（`tracker.token_env`）**：从环境变量读取 PAT / Group / Project Access Token（`glpat-...`）或手工保管的 OAuth token（`gloas-...`）。GitLab API 不区分两者，`@gitbeaker/rest` 透传即可。`tracker.token_env` **可选**，缺失时落到来源 B。
   - **来源 B — 本地 credentials 文件（`issuepilot auth login` 颁发）**：内置 OAuth 2.0 Device Authorization Grant（GitLab 15.x+），无需浏览器重定向。Token 持久化到 `~/.issuepilot/credentials`（文件权限 `0600`），daemon 与 CLI 共用。Access token 在剩余有效期 < 5 分钟时自动通过 refresh token 刷新；refresh 失败按 `auth` 类错误升级，提示用户重新 `issuepilot auth login`。
   - **来源 C — `glab` CLI 桥接（不需要 IssuePilot 代码改动）**：开发者可继续用 `export GITLAB_TOKEN=$(glab auth token --hostname <host>)` 把 glab keyring 里的 OAuth token 注入环境变量，等价于来源 A。
   - 凭据 redact：所有来源得到的 token 字符串只在 `@issuepilot/credentials` 与 `@issuepilot/tracker-gitlab` 内部传递；事件、日志、dashboard、prompt 全部走 `observability/redact`。
   - OAuth client_id：默认硬编码 IssuePilot 公开 client_id，允许通过 `IPILOT_OAUTH_CLIENT_ID` 环境变量覆盖以便公司私有部署可指向自建 OAuth Application。client_id 是公开值不是 secret。
   - credentials 文件格式（JSON）：
     ```json
     {
       "version": 1,
       "hostname": "gitlab.example.com",
       "clientId": "issuepilot-cli",
       "accessToken": "<oauth-access-token>",
       "refreshToken": "<oauth-refresh-token>",
       "tokenType": "Bearer",
       "scope": "api read_repository write_repository",
       "expiresAt": "2026-05-21T10:00:00.000Z",
       "obtainedAt": "2026-05-14T10:00:00.000Z"
     }
     ```
   - CLI 子命令（在 §23 列出）：`issuepilot auth login | status | logout`。
4. MR target branch 策略：优先使用 workflow `git.base_branch`，缺省时 fallback 到 GitLab project default branch。
5. Issue note 策略：P0 维护一条 orchestrator-owned handoff note，使用
   `<!-- issuepilot:run:<runId> -->` marker 做去重、恢复和 human-review
   reconciliation。reconcile 阶段在创建或更新 MR 后写入该 note；缺失的
   summary / validation / risks 通过字段 fallback 表达，不再写独立成功
   fallback note。

## 23. 实现备注

建议命令：

```bash
issuepilot run --workflow WORKFLOW.md --port 4738
issuepilot validate --workflow WORKFLOW.md
issuepilot doctor
issuepilot auth login --hostname gitlab.example.com   # OAuth Device Flow，token 存入 ~/.issuepilot/credentials
issuepilot auth status [--hostname <host>]            # 显示当前登录状态、scope、token 到期时间
issuepilot auth logout [--hostname <host>]            # 清除本地 credentials（不带 hostname 时清除全部）
```

`auth login` 行为：

1. 调用 `POST {baseUrl}/oauth/authorize_device`，参数包含 `client_id`、`scope`（默认 `api read_repository write_repository`）。
2. 控制台输出 `verification_uri_complete` 与 `user_code`，提示用户在浏览器完成授权（不写入日志、不发送给 dashboard）。
3. 按返回的 `interval` 轮询 `POST {baseUrl}/oauth/token`（`grant_type=urn:ietf:params:oauth:grant-type:device_code`），处理 `authorization_pending`、`slow_down`、`expired_token`、`access_denied` 几种标准状态。
4. 拿到 `access_token` + `refresh_token` 后写入 `~/.issuepilot/credentials`（文件权限设置为 `0600`；目录如缺失则以 `0700` 创建），并提示用户「Logged in to <hostname> as <token-prefix>...」。

`auth status` 行为：读取 credentials 文件，输出 hostname、client_id、scope、access token 到期时间，以及 「token expires in X minutes」「expired，请重新登录」等友好状态；token 字符串本身永远不打印。

建议本地开发命令：

```bash
pnpm dev:orchestrator
pnpm dev:dashboard
pnpm test
pnpm lint
```

实现计划应该从 contracts 和 fake E2E tests 开始，再接真实 GitLab 和真实 Codex app-server。
