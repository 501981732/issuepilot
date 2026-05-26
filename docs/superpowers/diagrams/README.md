# IssuePilot Diagrams

本目录存放 IssuePilot 的官方架构与流程图。**Mermaid 源文件 (`*.mmd`) 是事实
来源**；同名 `*.svg` 是为方便文档引用而预渲染的产物，必须随源文件一起更新，
否则 `git diff --check` 仍会通过但 README / 使用手册引用的 SVG 会落后于 spec。

## 文件

| 文件 | 类型 | 描述 |
| --- | --- | --- |
| `v4-architecture-handdrawn.svg` | 手绘 SVG | 面向新读者的 V4.10 架构教育信息图，中文为主，用手绘卡片解释 V2 runtime + V4 intelligence + runner + dashboard |
| `v4-flow-handdrawn.svg` | 手绘 SVG | 面向新读者的 V4.10 端到端流程教育信息图，中文为主，展示 Issue → WorkItem → 多 Agent → Review Packet → 返工闭环 |
| `v4-architecture.mmd` | mermaid 源 | IssuePilot V4.10 当前架构图 — 在 V2.x local runtime 之上展示 Workflow Intelligence Layer、multi-agent pipeline、runner adapter、dashboard 和本地状态 |
| `v4-architecture.svg` | 渲染产物 | 上面文件的 SVG 渲染版本，README / docs / 使用手册默认引用这张当前架构图 |
| `v4-flow.mmd` | mermaid 源 | V4.10 当前端到端流程图 — 覆盖 WorkItem planning、TaskGraph、multi-agent run、Review Packet、Quality Analytics、ReviewReworkPlan 和 V4.10 team follow-up 边界 |
| `v4-flow.svg` | 渲染产物 | 上面文件的 SVG 渲染版本，README / docs / 使用手册默认引用这张当前流程图 |
| `v2-architecture.mmd` | mermaid 源 | IssuePilot V2 团队可运营版本的运行时架构图 — 配置入口、orchestrator daemon、adapter、observability、本地存储与 dashboard 的层次关系 |
| `v2-architecture.svg` | 渲染产物 | 上面文件的 SVG 渲染版本；作为历史 V2 runtime foundation 图保留 |
| `v2-flow.mmd` | mermaid 源 | V2 下 GitLab issue 从 `ai-ready` 到 `closed` / `ai-failed` / `ai-blocked` 的端到端生命周期，覆盖 Phase 1-5 五段周期任务 |
| `v2-flow.svg` | 渲染产物 | 上面文件的 SVG 渲染版本；作为历史 V2 lifecycle 图保留 |

## 渲染命令

仓库不引入 `@mermaid-js/mermaid-cli` 作为根 dev 依赖（避免 puppeteer/Chromium
拖慢日常 `pnpm install`）。直接用 `npx`：

```bash
cd docs/superpowers/diagrams
npx -y -p @mermaid-js/mermaid-cli mmdc \
  -i v4-architecture.mmd -o v4-architecture.svg -b transparent --quiet
npx -y -p @mermaid-js/mermaid-cli mmdc \
  -i v4-flow.mmd -o v4-flow.svg -b transparent --quiet
npx -y -p @mermaid-js/mermaid-cli mmdc \
  -i v2-architecture.mmd -o v2-architecture.svg -b transparent --quiet
npx -y -p @mermaid-js/mermaid-cli mmdc \
  -i v2-flow.mmd -o v2-flow.svg -b transparent --quiet
```

GitHub / GitLab 网页原生支持 `.mmd`-style mermaid 代码块，所以本地 IDE
渲染不通过时也可以把 `.mmd` 内容粘贴到 markdown 代码块里预览（README 与
使用手册引用的是 SVG 文件，避免双倍维护）。

手绘信息图是人工维护的 SVG，定位是教育解释层，不作为状态机 / API / contract 的
事实来源。修改产品结构时应先更新 `v4-*.mmd`，再同步手绘图中的高层说明。

## 维护约束

1. **改图必须改源 + 同步重渲染**：只改 SVG 会让两者漂移。提 PR 前确认
   `git status` 中 `.mmd` 与 `.svg` 同时出现。
2. **真实就绪后再改图**：架构图与流程图反映已经合入 `main` 的实现。spec
   层面的"计划"或"待实施"内容请放在对应 Phase spec 中，不进入这两张图。
3. **节点 label 含括号 / 引号 / `#` 时必须用 `"..."` 包裹**：mermaid 解析
   器会把裸 `(...)` 当成节点 shape 起点，渲染会报 `Expecting 'SQE' ...
   got 'PS'` 这种错。
4. **修改后**：本地 `git diff --check` 通过即可；CI 不阻塞图未渲染（SVG
   不参与 build / lint / test），但落后的 SVG 会让 README/手册显示旧版本。
