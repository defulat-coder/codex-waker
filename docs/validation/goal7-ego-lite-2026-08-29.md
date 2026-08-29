# Goal 7 Ego Lite 验证记录（2026-08-29）

任务空间：ego-browser task space `12`（`goal7 legacy frontend parity`）。本地应用 `https://waker.localhost`（vite :5210），API `https://api.waker.localhost/healthz` 返回 `{"status":"ok"}`。旧版实例 `http://127.0.0.1:19830/management` 可达（200）。

## G7-1 App Shell reduced-motion 单独浏览器验证

矩阵行：`App Shell | 浅色/深色主题、触屏/hover、reduced motion、多档响应式`（原 `implemented`，缺口为 reduced-motion 未单独截图验证）。

步骤与证据（CDP `Emulation.setEmulatedMedia`）：

1. 默认（未模拟）：`matchMedia('(prefers-reduced-motion: reduce)').matches === false`；`.legacy-rail-button` 计算样式 `transition: color 0.15s, background 0.15s`。
2. 模拟 `prefers-reduced-motion: reduce` 后：`matches === true`；同一元素计算样式 `transition: none`（命中 `styles.css` 6716 行媒体查询块）；`animation: none`。
3. 截图 `docs/validation/goal7-reduced-motion.png`：reduced 模式下页面完整渲染（图标轨、欢迎区、composer 正常），无布局溢出。
4. `MotionConfig reducedMotion="user"`（`apps/web/src/App.tsx:593`）使 framer-motion 侧跟随同一媒体查询。

事件队列无 Console/Network 错误。

结论：该行升级为 `verified`；同时补齐「窄屏与主题」流程行的 reduced-motion 浏览器快照缺口。

## G7-2 Waker 管理 /management：标签页、筛选、设备、分页、未读

矩阵行：`Waker 管理 /management | Waker/群组列表、搜索、设备与在线状态筛选、分页、未读`（原 `partial`）。

实现（真实本地语义，无假数据）：

- API：`GET /api/v1/workspace` 新增 `host.name`（os.hostname）与 per-agent `unreadCount`（与 inbox 同一判定 `needsAttention && !completedAt && !read` 按 agent_id 聚合）；新增 `POST /api/v1/inbox/read-all` 返回 `{ updated }`（幂等）。
- Web（`LegacyWorkbench.tsx` WakersView 重写）：旧版头部文案；tablist「管理分类」（我的Waker/我的群组）；「仅在线」开关（aria-pressed 真实过滤）；「环境」下拉（真实主机名、当前机器、在线 N 名、本地、全部环境 N 名员工）；搜索占位「搜索员工或者设备...」；卡片含在线状态点、本机+主机名、tagline 角色标签、未读 badge、创建对话任务/创建自动任务主按钮与「更多操作」菜单（配置/记忆/能力/导出/删除）；12/页客户端分页（>12 才显示分页器）；未读>0 时显示「全部标为已读」。
- 我的群组 tab：明确降级说明（云端多 Waker 群聊，本地无群组数据、不提供新建群组），无假数据。

Ego Lite 证据（task space 12，`https://waker.localhost`）：

1. 管理页快照：头部「我的Wakers」+ 旧版副标题；两个 tab；仅在线/环境/搜索工具栏（占位文案一致）；6 张卡片均含「在线」状态、「本机 cydeMacBook-Pro.local」设备行、两个主按钮与 `{name} 的更多操作` 菜单。
2. 环境下拉条目实测：`cydeMacBook-Pro.local / 当前机器 / 在线 6 名 / 本地`、`全部环境 / 6 名员工`。
3. 更多操作菜单实测：配置、记忆、能力、导出（href `/api/v1/agents/brainstormer/source`）、删除。
4. 我的群组 tab 实测：降级说明标题与两段解释文案，无新建群组入口。
5. 截图：`goal7-management-wakers.png`（列表页）、`goal7-management-groups-degraded.png`（群组降级）。
6. 事件队列无 Console error、无 ≥400 网络响应。
7. 分页与未读 badge 本地数据不触发（6 个 Waker、0 未读，分页器/badge 正确隐藏）；分页（13→12+1）与未读 badge/read-all 流程由 jsdom 组件测试与 API 测试覆盖（web 170、api 101 全绿）。

结论：该行升级为 `verified`；群组能力在 UI 内以明确降级说明承接（对应 Conversation Groups 的 excluded 决策）。

## G7-3 Waker 管理异步区域：empty / loading / error / retry 逐个验收

矩阵行：`Waker 管理 | 空列表、无搜索结果、loading、局部加载失败、retry`（原 `implemented`，缺口为未逐个异步区域验收）。

旧版文案（恢复 bundle `NotebookHostProvider-BJJMzJ60.js` i18n 表）：`emptyWorkersTitle: 暂无 Waker`、`emptyWorkersDescription: 创建一个 Waker，让它承接任务、自动化和项目上下文。`、`noWakersMatchFilters: 没有匹配的 Waker。`、`loadingWorkers: 正在加载 Waker...`、`loadFailed: Waker 加载失败。`。

文案对齐（本轮修改）：`LegacyWorkbench.tsx` 空列表/无匹配 EmptyState 改用旧版文案；`App.tsx` 启动 loading 改「正在加载 Waker...」、fatal 改「Waker 加载失败。」+ 技术细节（`.app-fatal-detail`）+ 重试。

Ego Lite + CDP `Fetch` 拦截证据（task space 12）：

1. loading：stall `/api/v1/workspace` 请求 → 页面显示「正在加载 Waker...」；continue 后正常进入应用。截图 `goal7-mgmt-loading.png`。
2. error + retry：`Fetch.failRequest` 失败 workspace → 显示「Waker 加载失败。/ Failed to fetch / 重试」；`Fetch.disable` 后点击重试 → 应用恢复正常。截图 `goal7-mgmt-error.png`。
3. 空列表：fulfill workspace 为 `agents: []`（真实 models/prompts）→ 管理页显示「暂无 Waker / 创建一个 Waker，让它承接任务、自动化和项目上下文。」，无崩溃。截图 `goal7-mgmt-empty.png`。
4. 无匹配搜索：搜索 `zzz-no-such-waker` → 显示「没有匹配的 Waker。/ 调整搜索词，或清空搜索查看全部 Waker。」。截图 `goal7-mgmt-no-match.png`。

附带发现（记入后续行）：workspace `models: []` 时 `Composer.tsx` 渲染 `models.current.model` 抛 TypeError 白屏 —— 属「无模型 modelEmpty」鲁棒性缺口，归入「对话错误分类恢复」行处理。

## G7-4 创建 Waker：模板、头像、运行环境

矩阵行：`创建 Waker /wakers/new | 模板或自定义创建，头像、名称、角色描述、运行环境、Skills`（原 `partial`）。

实现：

- `.codex/agent-templates/`（4 个真实模板：前端开发工程师/测试工程师/中英翻译助手/写作助手，同 agent 文件格式）；`GET /api/v1/agent-templates`；原硬编码 `AGENT_TEMPLATES` 常量删除，`GET /api/v1/templates` 同源。
- 头像：`avatar` frontmatter + `.codex/agents/<id>.avatar.<ext>` sidecar；`PUT /api/v1/agents/:id/avatar`（Base64 JSON，PNG/JPG magic bytes + ≤2MB，400/413/404）；`GET .../avatar` 200 image/png；删除 agent 级联删 sidecar；`AgentSummary.hasAvatar`，`AgentChip` 有头像渲染 `<img>` 否则回退 mark。
- 对话框：选择一个角色 gallery（自定义角色 + 模板卡、motion 反馈）、模板 prefill（名称/简介/id/mark + 只读 persona 预览）、头像区（预览 + 上传头像 + 旧版 hint + 客户端校验「头像文件不能超过 2 MB」）、运行环境「本机 {hostname}（当前设备）· 在线」、提交文案「保存并启用」；先创建后传头像，头像失败保留已建 Waker 并如实上报。

Ego Lite 端到端证据（task space 12）：

1. 对话框快照：gallery（自定义角色+4 模板）、名称占位「请输入 Waker 名称」、头像区与 hint、运行环境行、「保存并启用」。
2. 选中「前端开发工程师」→ 名称/简介 prefill、persona 预览可读；改名「G7验证前端」+ 上传 64×64 PNG → 提交 → 「Waker 已创建」+ Chat/Knowledge/Project 三入口引导。
3. 回读：`.codex/agents/frontend-dev.md` frontmatter 含 `avatar: "frontend-dev.avatar.png"`、`mark: "端"`；sidecar `frontend-dev.avatar.png` 存在；`GET /api/v1/agents/frontend-dev/avatar` → 200 image/png；workspace `hasAvatar: true`。
4. 管理页卡片渲染真实头像 `<img>`（naturalWidth 64）；事件队列无 ≥400 响应与 console error。
5. 截图：`goal7-create-dialog.png`、`goal7-create-card-avatar.png`。
6. 清理：DELETE 后 `frontend-dev.md` 与 sidecar 均移除，工作区恢复 6 个 Waker。

偏差（明确决策，不伪造）：旧版创建期的 Skill 市场/Zip 上传与 MCP 挂载属云端模板市场概念；本地 Skills 为 workspace 级并在 Skills 视图管理，创建对话框不提供无语义入口。运行环境旧版为云/设备选择，本地仅本机在线，以只读展示承接。

测试：web 178、api 105、codex-runtime 107 全绿（gallery/prefill/mark 透传/头像校验/创建→上传顺序/头像失败保留/agent-templates/avatar 端点）。

## G7-5 Waker Home：画像、工作记录统计、活跃度热力图、时间线、关于我

矩阵行：`Waker Home | 画像编辑、能力/工具、活动、项目/触发器/任务统计、成长记录`（原 `partial`）。

实现：

- 新视图 `WakerHomeView`；管理卡片上部为「查看 {name} 的角色详情」按钮打开 Home；「我的 Waker」返回。
- `GET /api/v1/agents/:agentId/home`：`createdAt`（定义文件 birthtime）、`counts`（sessions/questions/automations/projects/workflows/tasks）、`activity`（session-store SQL `date(updated_at)` 按日聚合，仅该 agent）；404 未知 agent。
- frontmatter 可选 `strengths`/`workStyles`（{title,text} 数组），4 个模板带真实内容；存量 agents 不添加，对应区块如实不渲染。
- 画像卡（头像/tagline/在线/ID/入职时间/简介/编辑→ConfigPanel）；工作记录四统计（入职天数 N 天/对话任务/自动任务/已创建的项目）；52 周活跃度热力图（月标签、周一/周三/周五、aria-label「{date}, 每日工作量：{n}」、4 档品牌色强度）；时间线视图/对话任务/自动任务三个真实列表；关于我（简介 + 条件渲染的我最擅长/工作风格 + 建议问题）。

Ego Lite 证据（task space 12，agent=brainstormer）：

1. API 回读：`/agents/brainstormer/home` → sessions 18、questions 22、automations 4、projects 2、workflows 3、tasks 13；activity 8-22:1、8-23:1、8-27:4、8-28:12；createdAt 2026-08-22。
2. 页面快照：画像卡「ID: brainstormer / 入职时间：2026年8月22日」；统计「入职天数 8 天 / 对话任务 18 / 自动任务 4 / 已创建的项目 2」与 API 完全一致。
3. 热力图 364 cells（52×7），非零 cell 的 aria-label 与 activity 逐日一致；月标签 9月→8月。
4. 三个 toggle 实测切换：时间线（创建/更新对话任务 + 自动任务运行事件混合）、对话任务（真实会话列表）、自动任务（手动/计划触发 · 成功/已取消/失败）。
5. 关于我：简介 + 建议问题；brainstormer 无 strengths/workStyles，区块如实不渲染。
6. 截图 `goal7-waker-home.png`；事件队列无 ≥400 与 console error。

偏差：我最擅长/工作风格仅对从模板创建或显式声明的 Waker 渲染（数据驱动，不为存量 Waker 伪造内容）。二级详情导航栏（项目/自动任务/工作流/记忆/技能等）在「Waker 详情导航」行单独落地。

测试：web 189、api 109、codex-runtime 113 全绿（/home 聚合与 404、strengths/workStyles 往返、热力图 aria-labels、toggle 切换、条件渲染、卡片进 Home）。

## G7-6 Waker 详情导航（二级导航栏）

矩阵行：`Waker 详情导航 | Home、Projects、Automations、Tasks、Workflows、Memories、Skills、Knowledge、Connector、IM、Permission`（原 `implemented`）。

实现：`WakerDetailNav`（aria-label「Waker 详情导航」，152px 纵栏）：「我的 Waker」返回 + agent 名 + 首页/项目/自动任务/对话任务/工作流/记忆/技能/知识库/连接器/IM/权限 + splitter + 设置，legacy 顺序与图标；`aria-current="page"` 激活态；渲染于 per-waker 视图（waker-home/projects/tasks/workflows/memory/skills/knowledge/capabilities/im）且上下文 agent 可解析时；各项点击复用卡片动作的 agent 上下文 setter；连接器/权限 deep-link 到 capabilities 对应 tab；设置开 ConfigPanel 且激活态优先。chat 视图不显示该导航（保护已验证布局，记为结构偏差）。

Ego Lite 证据（task space 12，agent=brainstormer）：

1. 导航渲染：12 个按钮顺序与旧版一致，首页 aria-current=page。
2. 逐项点击 9 项（项目/自动任务/工作流/记忆/技能/知识库/连接器/IM/权限）：每项激活态正确且目标视图真实加载（项目列表、AutomationManager、WorkflowManager、MemoryView、SkillsView、知识库、Waker 能力、IM 降级页）。
3. 权限 deep-link 实测落在 Permissions tab（aria-selected=true）；连接器落 Connectors。
4. 对话任务 → chat 视图且导航隐藏；设置 → ConfigPanel 打开且导航激活=设置；我的 Waker → 返回管理列表。
5. 截图 `goal7-waker-detail-nav.png`（导航 + ConfigPanel + 设置激活态）；事件队列无 ≥400 与 console error。

测试：web 196 全绿（导航渲染/顺序/激活/12 项回调、initialTab deep-link、Home 无重复返回按钮）。

## G7-7 对话审批/提问原 Thread 恢复闭环

矩阵行：`对话 /conversations/:sessionId | 流式回复、停止/中断、等待审批、等待用户问题、失败重试`（原 `partial`，流式/停止/中断/失败重试此前已验证，本轮补齐审批/提问承接与恢复闭环）。

架构决策（偏差记录）：

- 审批由 Codex sandbox/approval 模型承接（`approvalPolicy` 默认 `never`，AGENTS.md 明确禁止 HITL approvals bridge，无 `/api/v1/approvals`、无 `/api/v1/events` 审批端点）——旧版「等待审批」状态不映射为本地审批弹窗，这是显式设计决策，非缺口。
- 提问由 Workflow `ask_user` 节点 → Human Actions 承接：run 进入 `waiting_input`，人工操作中心产生 `kind=input` 待办，回答后同一 session/task 恢复运行至终态。

恢复闭环证据（task space 12）：

1. API trace 回读：run `5c65601a-9a4e-4e42-825f-5daae0daf2be`（`GET /api/v1/workflow-runs/.../trace?wakerId=brainstormer`）事件链 `queued → started → waiting_input（18:15:23Z）→ resumed（18:30:56Z）→ succeeded`，15 分钟等待后原 run 恢复完成，非重开新 run。
2. 身份一致性：run `sessionId=session_46817acf`、`taskId=7650d7e1-cfc2-4e26-a81c-7e153adccc40`；人工操作 `ff4ea4c9`（kind=input, status=handled）的 sessionId/taskId 与之完全一致——同一 session/task 恢复。
3. 浏览器看板：任务看板显示「Goal 6 Board 人工操作 流程 已完成 2026年8月29日 02:30」；人工操作 tab 待处理 0 条（无残留待办）。
4. 截图 `goal7-board-human-actions.png`；事件队列无 ≥400 与 console error。

本轮无代码改动，未重跑门禁。

## G7-8 对话内容 Mermaid 与 Shiki 语法高亮

矩阵行：`对话内容 | Markdown、代码、Mermaid、工具调用、计划卡、长消息折叠`（原 `partial`，其余子项此前已验证，本轮补齐 Mermaid 与语法高亮）。

实现（coder agent-7）：新增 `MermaidBlock.tsx`（mermaid@^11.17.2 动态 import、securityLevel strict、流式中渲染源码、完成后 parse 门控默认出图、查看源码/查看图表切换、缩小/重置/放大 0.5–3x 步进 0.25、Ctrl+滚轮、600px maxHeight 滚动区、渲染失败 `Mermaid render unavailable.`+错误消息+源码+「渲染图表」重试）与 `lib/highlight.ts`（shiki@^4.4.3，github-light/github-dark 双主题 CSS 变量、语言按需 loadLanguage、失败回退纯文本）；`MessageStreamingContext` 传递流式状态（流式中 mermaid 块不高亮不 parse）。偏差：旧版 mermaid 主题硬编码 dark，本地经 usePrefersDark 跟随系统明暗（light→default / dark→dark）。

Ego Lite 证据（task space 12，agent=brainstormer，模型 Kimi K2.7 Code——gpt-5.6-sol 走 openai provider 无凭据返回 401「本轮回复失败」，该错误分类证据另归入「对话错误」行）：

1. 真实会话第一轮：mermaid flowchart 渲染出 SVG，typescript 块出现 `.code-block-highlight` 高亮；流式约 18s 完成。
2. 交互：「查看源码」点击后按钮变「查看图表」且源码可见，再点切回；缩放 100%→125%→150%→重置 100%（百分比标签与容器 width 同步）。
3. 暗色：CDP 模拟 prefers-color-scheme dark，高亮配色切到暗色前景（rgb(243,245,244)），图表保持渲染（goal7-mermaid-dark.png）。
4. 兜底：第二轮发送非法 mermaid（`graph TD; A-->`），块显示 `Mermaid render unavailable` + 「渲染图表」重试按钮（goal7-mermaid-fallback.png）。
5. 截图 `goal7-mermaid-shiki.png`（图表+高亮）；事件队列无 ≥400，无 console error。

测试：web 204 全绿（MermaidBlock 4 例：出图/切换/parse 失败兜底/缩放；CodeBlock 高亮 4 例：注入/回退/流式不高亮/流式 mermaid 源码块）；typecheck 14/14、lint 8/8、test 16/16。新增依赖 mermaid ^11.17.2、shiki ^4.4.3；web test 脚本加 `--experimental-test-module-mocks`（mock.module 需要）。

## G7-9 对话错误分类恢复（auth/rate_limit/quota/timeout/network/startup + 无模型空态）

矩阵行：`对话错误 | 启动、网络、鉴权、超时、rate limit、quota、无模型`（原 `partial`）。

实现（coder agent-9，两轮）：

- `packages/codex-runtime/src/error-classification.ts`：`classifyTurnError` 移植旧版分类规则（startup → quota → rate_limit → auth → timeout → network → generic，数字码按独立 token 匹配防误中），quota 类尽力提取 resetAt。
- SSE error 帧携带 `kind`/`resetAt`（contracts `ChatErrorKind` + SessionMessage `errorKind?`/`errorResetAt?`）；回放经 `rollout.ts` 用同一分类器推导。
- 失败持久化补记：`session_turn_failures` SQLite 表（ON DELETE CASCADE），turn 失败（非 aborted）时 chat.ts 补记；回放 merge 时按 errorMessage 全等去重（rollout 已落盘的错误不出双卡），按时间序插入——解决验证中发现的「Codex rollout 对 provider 401 无 error 记录、刷新丢卡」缺口。
- RecoveryCard 按 kind 渲染旧版分类文案：quota「额度已用尽」（带重置时间）/ auth「对话异常中断 · 认证已失效，请重新登录后继续。」/ rate_limit / timeout / network / generic / startup「启动失败」+ 现象/原因/建议三段；全部保留「重试」。
- Composer 白屏修复：`models?.current?.model` + `Array.isArray(models?.available)` 防御；`available: []` 时模型菜单显示旧版空态「暂无更多可用模型」。

Ego Lite 证据（task space 12，agent=brainstormer）：

1. **auth（真实触发）**：gpt-5.6-sol 走 openai provider 无凭据 → 真实 401，红卡「对话异常中断 / 认证已失效，请重新登录后继续」+ 重试（goal7-error-auth.png）；**刷新后从会话列表重开，分类卡仍在**（goal7-error-auth-replay.png，补记持久化生效）。
2. **quota/rate_limit/network/startup（注入渲染）**：page 内 patch fetch 拦截 `/api/v1/chat` 返回分类 SSE error 帧 —— quota「额度已用尽 + 将于 2026-09-01 重置 + 重试」、rate_limit「请求过于频繁或已达到调用上限，请稍后重试」、network「无法连接到模型服务，请检查网络后重试」、startup「启动失败 + 建议 + 重试」逐类渲染正确（goal7-error-classified-cards.png）。服务端分类规则由 24 个表驱动单测 + api 回放测试覆盖。
3. **无模型空态**：临时移除 `.codex/settings.json` 的 models/defaultModel（API 实测返回 `available: []`）→ 页面不白屏、模型菜单显示「暂无更多可用模型」（goal7-model-empty.png）；验证后 settings 已还原（3 模型恢复）。
4. 既有行为记录：仅最新失败轮次显示红卡，更早失败降级为纯文本（本地既有设计，非本轮缺口）。
5. 事件队列无 ≥400（401 为被测错误本身），无 console error。

偏差记录：

- quota 的「升级订阅/查看用量」动作无本地计费语义，统一为「重试」+ 文案建议稍后再试。
- network diagnostic 面板（Gateway 认证/机器注册等 6 项链路检查）是云端远程会话概念，本地无对应物，记 degraded。
- auth 正文沿用旧版「请重新登录后继续」，本地实际含义是检查模型服务凭据（本地无登录体系）。

测试：typecheck 14/14、lint 8/8、test 16/16 全绿（runtime 141 含分类器 24 例 + merge/去重；api 112 含 error 帧 kind 与回放补记；web 214 含 RecoveryCard 各 kind、Composer 防御/空态）。

## G7-10 Knowledge 三行：shared/featured 决策 + URL 导入落地

覆盖矩阵行 60（Knowledge `/knowledge`）、61（Knowledge 详情）、65（Waker Knowledge featured）。

**行 60 / 65 决策（无代码改动）**：旧版 shared（组织成员按邮箱共享，`QmindRouter.ts:79` 代理云端、Bearer+orgId tenant）与 featured（官方推荐只读库，`:88` + `:2855` 强制 read_only）均为 QMind 云 org 级数据，本地无账号/团队/官方内容源可复刻，两行分别记 excluded 并写明理由；created 分类、绑定/解绑、Needs check、read-only、空/加载/错误/无结果等本地语义此前已由行 64/95 E2E 验证，两行升 verified（含偏差记录）。

**行 61 实现（coder agent-11）**：`POST /api/v1/knowledge/documents/import-url`——服务端抓取（15s 超时、5MB 流式上限、手动跟随重定向 ≤5 跳且每跳重过校验、http(s) 协议白名单 + 私网段拒绝 SSRF 防护、零新依赖正则 HTML→Markdown），落库走现有 `sourceType:'web'` + `uri` 管道并自动索引；前端 KnowledgeManagementView 加「网页链接」composer（textarea 空格/换行分隔、实时 `{count}/20 个有效链接`、超限提示+禁用、逐条 partial-success 反馈、全成功「网页链接已导入」）。

Ego Lite 证据（task space 12，agent=brainstormer，知识库「Waker 本地指南」可写连接）：

1. 粘贴 `https://example.com/` + `not-a-url` + 404 链接共 3 条：计数正确显示「2/20 个有效链接」（非法条目被过滤）。
2. 提交后逐条反馈「已导入 1 个，失败 1 个」+「https://example.com/does-not-exist-404：抓取失败（HTTP 404）」；文档列表新增「Example Domain · 版本 1 · web」；审计记录 8→9。
3. hybrid 检索「illustrative examples」命中 Example Domain，引用 `https://example.com/#L1-L5`、相关度 0.518（goal7-knowledge-url-import.png）。
4. 导入后绑定卡如实显示 NEEDS CHECK（内容变更后的既有语义，与行 64 一致）。
5. 事件队列无 ≥400，无 console error。

偏差记录：旧版 URL 抓取在 QMind 云端执行（JS 渲染质量、签名 URL 富预览、WebOffice iframe），本地降级为服务端直接抓取 + 正则提取正文 + 现有 markdown 内容预览；无 JS 渲染（SPA 壳页面会报「页面没有可提取的正文」）。

测试：typecheck/lint/test 全绿 16/16（api 120 含 import-url 10 例——混合合法非法、抓取失败逐条、content-type 拒绝、上限、重定向到 169.254.169.254 拦截、partial-success 形状；web 217 含链接解析/计数/超限 3 例）。

## G7-11 Memories 项目/群组范围浏览器验收

矩阵行：`Memories /wakers/:id/memory | All/History；个人、项目、群组范围；分类卡 CRUD`（原 `implemented`，Waker scope 此前已验证）。

实现（coder agent-12）：MemoryView scope 硬编码（`MemoryView.tsx:53`）改为状态驱动——「个人/项目/群组」分段 tab（复用 .waker-tabs 模式），项目下拉复用 `fetchLocalResources` 并按 `project.wakerId` 客户端过滤（该端点会返回其他 Waker 的 public 项目，不能直接用）；scope 贯穿列表/时间线/CRUD/导入/导出/快照；无项目时显示空态且「新建/导入」禁用、不发 project 请求；群组 tab 禁用 + title 注明原因。

Ego Lite 证据（task space 12，agent=brainstormer）：

1. 范围 tab 渲染：个人（默认 active）/项目/群组，群组 disabled + title「云端多 Waker 群组在本地模式不可用」。
2. 项目 tab：下拉列出且仅列出 brainstormer 的两个项目（Ego 公开项目、Waker 本地项目），个人记忆（Ego 导入记忆/协作偏好）从列表消失。
3. 闭环：项目 scope 经 UI 新建记忆（标题 ego-proj-memory）→ 出现在 project:9a563bce-… 列表、详情头 scope tag 正确 → 切回「个人」该记忆不可见、个人记忆恢复（双向隔离）→ 测试记忆经 API 删除（204，列表清零）。
4. 截图 `goal7-memory-scopes.png`；事件队列无 ≥400 与 console error。

偏差：群组范围无本地群组实体（无 groups API，与「我的群组」管理页同源决策），tab 禁用注明原因，记 degraded。MemoryView 的删除操作无 UI 按钮（既有设计，删除走 API），非本轮缺口。

测试：web 222 全绿（scope 切换拉取/隔离/恢复、POST 携带项目 scope、无项目空态零请求、下拉过滤外来 public 项目、群组禁用 5 例）；typecheck/lint/test 16/16。

## G7-12 Global Settings：主题三档 + AI 回复语言；显示语言 degraded 决策

矩阵行：`Global Settings | Preferences：主题、显示语言、Agent 输出语言`（原 `partial`）。

实现（coder agent-14）：

- 主题亮暗：`ui.theme`（auto/light/dark）+ root `data-theme`；styles.css 暗色覆盖复制到 `[data-theme='dark']`、媒体查询内加 `[data-theme='light']` 强制浅色块（specificity 胜出，系统暗色下可强制浅色）；main.tsx 首屏前应用避免闪烁；MermaidBlock usePrefersDark 改为 data-theme 优先（MutationObserver 监听）+ shiki CSS 变量随覆盖切换。
- AI 回复语言：`ui.agent-output-language`（zh-CN/en-US/不指定），`createCodexAgentSession` 新 thread 首 turn 把旧版原文指令段追加进 developer-instructions（zh-CN 用旧版中文原文，en-US 对应英文），resume/第二 turn 起不注入。
- 偏好 key 走现有 `ui.*` schema，API 零改动。

Ego Lite 证据（task space 12）：

1. 设置页「界面偏好」渲染主题亮暗（自动/浅色/深色）与 AI 回复语言（不指定/中文/English）。
2. 点「深色」：data-theme="dark" 立即生效，--bg-primary=#171a19、--text-primary=#f3f5f4（goal7-theme-dark.png）；刷新后 data-theme 仍为 dark（localStorage+SQLite 写穿持久化）；点「自动」属性移除。
3. AI 回复语言选「中文」→ 新会话发消息 → 最新 rollout（rollout-2026-08-29T10-55-08）首条 developer-instructions 内含「默认输出语言：…简体中文 (zh-CN)。除非用户在当前会话中明确要求…」完整旧版文案；验证后设置已还原为「不指定」。
4. 事件队列无 ≥400 与 console error。

决策（degraded，理由）：显示语言不实现——本地 54 个源文件 ~1506 条硬编码中文、无 i18n 层；旧版 zh/en 各 ~7800 key 全 UI 覆盖，全量复刻需抽全部文案建双语表并引入 i18n 框架、此后每条新文案双语维护，对本地单人中文优先 workbench 是持续税；只翻 chrome 的混杂语言 UI 比纯中文更差。旧版 Agent 输出语言机制（prompt 注入新会话）已 1:1 复刻，保留了「控制回复语言」的真实价值。

测试：typecheck/lint/test 全绿 16/16（web 231 含主题应用/设置渲染/data-theme 优先；runtime 146 含注入值域/双语文案/未设置不注入/resume 不注入 5 例）。

## G7-13 错误与中断端到端流程验收

矩阵行 94（E2E 区）`错误与中断 | 对话中 stop；模拟 auth/network/quota；触发 approval/question`（原 `partial`）。本轮无代码改动，补齐最后一环 live 证据并汇总。

Ego Lite 证据（task space 12，agent=brainstormer，模型 Kimi K2.7 Code）：

1. 发送长文请求，流式开始 2s 内点「停止」→ 出现「回复已中断，可以重新提问」+「继续」按钮（goal7-e2e-stop-interrupted.png）。
2. 点「继续」→ 注入「请继续」→ 流式恢复 → 完整文章回复完成（无失败/不再中断）。
3. auth/quota：G7-9 已验收（真实 401 分类卡 + 刷新保持；quota 注入卡带重置时间）。
4. approval/question：G7-7 已验收（审批=Codex sandbox 架构决策；提问=ask_user→Human Actions 原 session/task 恢复 succeeded）。
5. 事件队列无 ≥400 与 console error。

## G7-14 Memory 版本流程：对话自动产出 memory

矩阵行 97 `Memory 版本 | 对话产生 memory → timeline → 编辑 → 版本冲突 → rollback`（原 `implemented`，仅差对话自动产出）。

实现（coder agent-16，两轮）：复刻旧版 memory dream 主机制——chat runTurn 成功后关键字门控 → `MemoryDreamer` fire-and-forget（per-agent 串行 promise 链）→ `runCodexOneShot` 独立一次性提取 turn（不写会话绑定、不注入人设、沿用 host sandbox/approval）→ 严格输出契约（`NO_MEMORY` 或首行 `# 标题` 的 Markdown，untrusted envelope + XML 转义 + 4000 字符截断）→ 写 waker scope memory（source=conversation；title 匹配已有文档走 update 新版本，VERSION_CONFLICT 重读重试一次）；`WAKER_MEMORY_DREAM=off` 禁用。验证中修复：提取 initially 落默认模型（openai provider 无凭据 401 被吞），改为继承本轮对话最终模型（chat 请求 model 覆盖后值透传到 runCodexOneShot）。

Ego Lite 证据（task space 12，agent=brainstormer，模型 Kimi K2.7 Code）：

1. 发送「请记住我喜欢用 pnpm，以后所有项目都默认用它。只回答"好的"即可。」→ 主回复正常完成（done 帧不被提取阻塞）。
2. 约 15s 后 `GET /memories?scopeType=waker&scopeId=brainstormer` 出现「包管理器偏好」v1（source=conversation），内容准确提取两条偏好事实；timeline 有 `create / conversation` 事件。
3. 记忆视图（个人 tab）可见该记忆与 conversation 标记（goal7-memory-dream.png）。
4. 事件队列无 ≥400 与 console error；提取失败路径（默认模型 401）实测只 log 不影响会话（日志 `memory dream 失败（已忽略，不影响会话）`）。

偏差：旧版另有每日 cron 维护作业（group-memory/personal-memory daily jobs）与 timeline origin 枚举（self-created 等），本地简化为 turn 级即时提取 + source 字段，daily cron 不实现（本地无调度语义需求，Automation 已覆盖定时能力）。

测试：typecheck/lint/test 全绿 16/16（api 138 含 dream 18 例：门控/解析/转义/异步写/同名 update/NO_MEMORY/env 禁用/串行/模型透传）。

## G7-15 Waker 设置三上下文文件（IDENTITY/PERSONA/BIBLE）

矩阵行：`Waker 设置 | 编辑 IDENTITY.md、PERSONA.md、BIBLE.md 与 profile`（P1，原 `partial`）。

方案决策：真拆三文件存储违反 AGENTS.md 单文件契约且买不到运行时保真（旧版 SessionStart 重注/版本锁在 Codex Thread 首 turn 单次注入模型下不存在），采用「单文件存储 + 展示层三分区」——frontmatter ↔ profile 天然映射，body 按文档化小节约定（`## 身份`/`## 人设`/`## 设定集` 各恰好一个 H2）映射三文件。

实现（coder agent-18）：`lib/agentSections.ts` 解析器/拼接器（未编辑 chunk 逐字节回写，往返无损）；`AgentBodySections.tsx` 三卡（01 身份：只读 profile + 修改基本信息入原整表表单 / 02 人设 / 03 设定集，Markdown 预览 + 空态「暂未设置」+ 旧版 placeholder + 分段编辑保存只 PATCH body）；不符合约定回退整段模式 + 说明条。

Ego Lite 证据（task space 12）：

1. 回退模式（存量 brainstormer）：卡 01 profile +「修改基本信息」+ 说明条「该 Waker 的人设文档未按 身份/人设/设定集 分段…」+ 整段 Markdown 预览（coder 实测截图核对）。
2. 三卡模式：临时把 brainstormer.md body 改为三段 → 面板渲染 01 身份/02 人设/03 设定集三卡 + 修改基本信息，人设/设定集内容正确分区（goal7-waker-three-cards.png）。
3. 分段编辑闭环：「修改人设」→ textarea 仅含人设段 → 追加验证行保存 → 文件只动人设段（身份段原样），面板显示新内容；验证后 brainstormer.md 已从备份还原（grep 确认 0 残留）。
4. 事件队列无 ≥400 与 console error。

测试：typecheck/lint/test 全绿 16/16（web 246 含解析器 11 例——切分/缺段/重复/乱序/往返无损/只改目标段；ConfigPanel 4 例——三卡渲染/空态/分段保存只 PATCH body/回退模式）。

## G7-16 Workflow AI 生成定义 + 画布/脚本双视图

矩阵行 75（Workflow 列表，AI customize）与 76（Workflow 编辑，diagram/script 双视图），均 P1 原 `implemented`。

实现（coder agent-20）：

- 行 75：`POST /api/v1/workflows/generate-definition`（description 1..2000 + 可选 model；prompt 内嵌七节点 DSL 精简 schema + 只输出 JSON 契约 + untrusted envelope 转义；剥围栏容错解析 → 服务端 validateWorkflowDefinition；422 校验失败 / 502 提取失败分类）；编辑器「AI 生成定义」区（旧版 placeholder「描述这条 WakerFlow 的具体流程…」、生成中/已生成/生成失败、预填不自动提交、editorBaseline 覆盖手改前 confirm）。
- 行 76：定义区改「画布/脚本」双 tab（tab 语义 aria 齐全）；WorkflowCanvas 卡片式只读图（七 kind 着色徽标 + 起点 + prompt/key/时长摘要 + decision 分支边与默认边，解析失败显示「脚本暂无法解析为图形」）；详情页路径图替换为同一画布。

Ego Lite 证据（task space 12）：

1. 编辑器：画布/脚本双 tab 渲染切换正常；画布 tab 2 节点卡片（ask_user 起点 + terminal，kind 徽标/出边/「流程结束」）（goal7-workflow-editor-canvas.png）；详情页只读画布独立渲染（goal7-workflow-canvas.png）。
2. AI 生成 UI 全链：填描述 → 「生成中」→ 约 35s「已生成」→ 脚本 tab 预填合法三节点定义（ask_topic/ask_user → write_summary/codex → terminal，经服务端校验），未点保存、取消编辑器无污染（goal7-workflow-ai-generate.png）。（浏览器经 fetch patch 注入 kimi-for-coding 模型；默认模型 gpt-5.6-sol 无 OpenAI 凭据时的「生成失败…401」失败态已由 coder 实测。）
3. 事件队列无 ≥400 与 console error。

偏差：旧版 AI customize 的多轮 ghost 会话 + MCP 工具链 + JS DSL 未复刻，改单轮严格 JSON 生成；画布无属性面板/节点批注（旧版也无拖拽建点/连线，只读决策维持）；旧版脚本自动保存未复刻（本地显式保存 + expectedVersion 乐观锁）。

测试：typecheck/lint/test 全绿 16/16（api 146 含 generate 11 例——成功/围栏容错/model 透传/非法 model/描述校验/422/502/prompt 转义；web 252 含生成区交互/confirm/双 tab/七 kind 画布/解析失败兜底 6 例）。

## G7-17 收尾全量复核

- 矩阵状态终态：59 个状态行 = 48 verified / 7 degraded / 4 excluded，0 个 partial/implemented（脚本统计）；degraded/excluded 行均在矩阵内写明原因与替代路径。
- 结论段已更新（行 111 替换为 Goal 7 终态说明）。
- 最终门禁（2026-08-29 复跑）：typecheck 14/14、lint 8/8、test 16/16 全绿；`git diff --check` 干净。

Goal 7 落地清单（本轮 16 个小节）：G7-1 reduced-motion；G7-2 窄屏与主题；G7-3 /management 群组/筛选/分页/未读；G7-4 异步区域四态；G7-5 Waker Home；G7-6 详情导航；G7-7 审批/提问恢复闭环；G7-8 Mermaid+Shiki；G7-9 错误分类；G7-10 Knowledge 三行；G7-11 Memory 范围；G7-12 主题/回复语言；G7-13 错误中断 E2E；G7-14 memory dream；G7-15 三上下文设置；G7-16 Workflow AI+双视图。
