# Backend Gap Audit — QoderWake 0.4.2 Replication

Date: 2026-08-29
对照面：`docs/audit/legacy-0.4.2-feature-matrix.md` 已覆盖特性对应的后端链路 + 旧版恢复源码 `waker-source/qoderwake-source-archive/versions/0.4.2-cn-6eeb338baf65`（`src/daemon`，只读）。
本地基线：apps/api 15 个路由模块（meta/skills/agents/sessions/preferences/usage/chat/files/knowledge/memory/workspace/workflows/board/session-outputs/capabilities + /healthz），挂载无遗漏；`packages/codex-runtime`（SQLite 绑定）、`packages/workspace-data`、`packages/memory`、`packages/knowledge`、`packages/artifacts`。

判定图例：

- **gap** — 旧版有本地可落地语义，本地后端缺失，需要实现。
- **parity** — 本地后端能力等价或架构性替代，无需动作。
- **degraded** — 本地有低配/部分能力，或受边界约束无法全量落地；写明原因与替代路径。
- **excluded** — 旧版云端/桌面专属能力，无本地语义，不逐条对比。

每行落地后补充「落地证据」列（实现 commit 级说明 + 验证方式），判定改为 parity/implemented。

## Gap 工作队列（按优先级排序）

| # | 特性 | 旧版后端证据 | 本地现状 | 判定 | 落地证据 |
| - | ---- | ------------ | -------- | ---- | -------- |
| 1 | Automation api/event 触发器入站 | `TriggerRouter.ts:1231` POST `/api/triggers/:id/invoke`（api-trigger-key 鉴权）；`TriggerRouter.ts:1500` GitHub webhook + WebhookSourceRegistry | schema 接受 `schedule/api/event` 三种 kind（workspace-data `store.ts` sources 字段），但只有 schedule 有真实触发（30s 轮询 `claimDueAutomation` 要求 `kind==='schedule'`）；api/event 只能手动 run | implemented | migration 011 + invoke/webhook/rotate 三端点 + 前端触发面板；curl+SQLite 实测见 `docs/validation/goal8-backend-gap.md` Row #1 |
| 2 | Memory 每日维护作业 + 手动 maintenance 端点 | `MemoryDailyMaintenance.ts`（trigger=cron）；POST `memory/maintenance/run` | 只有 chat turn 后的 fire-and-forget dream（keyword 闸门 + 一次性抽取）；无定期整理、无手动触发端点 | implemented | `maintenance.ts` + run 端点 + cron 作业（env 可关）+ 前端按钮；curl 实测见 `docs/validation/goal8-backend-gap.md` Row #2 |
| 3 | Agent 整包导出/导入（ZIP） | `WebServer.ts:11128` export-package / `:11133` import-package（含 context+skills+projects+triggers+memory+connectors） | 仅有单 markdown source 导出（agents 路由），无整包、无导入 | implemented | 手工 ZIP 容器 + export-package/import-package（dry-run/overwrite/穿越拒绝/工具字段剥离）；curl 实测见 `docs/validation/goal8-backend-gap.md` Row #3 |
| 4 | Sidebar sections 会话分组持久化 | `WebServer.ts:11162` GET/PUT `/api/console/sidebar-sections`；`SidebarSectionsStore.ts:10-55`（两级嵌套 + order + collapsed） | 无端点；前端分组状态无后端持久化 | implemented | `GET/PUT /api/v1/agents/:id/sidebar-sections` + workbench.sqlite 持久化；前端无分组 UI 可接（时间桶为即时计算），契约就绪；curl 实测见 `docs/validation/goal8-backend-gap.md` Row #4 |
| 5 | AgentProfileSummarizer 派生 | `WebServer.ts:11137` summarize-profile（模型派生 coreCapabilities/workStyles） | strengths/workStyles 纯 frontmatter 声明，无派生链路 | implemented | summarize-profile 端点（one-shot 模型派生 + apply 回写 frontmatter）+ 前端按钮；真实模型 curl 实测见 `docs/validation/goal8-backend-gap.md` Row #5 |
| 6 | session-runtime 诊断 / debug timeline / traces | `WebServer.ts:11140` / `:11445` / `:11149` 三件套 | 无诊断端点；只有 chat SSE 与 usage 聚合 | implemented | rollout 解析三端点（runtime-diagnostics/debug-timeline/traces）；真实会话 curl 实测见 `docs/validation/goal8-backend-gap.md` Row #6 |
| 7 | 触发器 stats / calendar | `TriggerRouter.ts:857-866` | automation 只有 runs 列表，无聚合 stats / 日历视图数据 | implemented | automation-stats / automation-calendar 两端点（SQL 聚合 + cron 展开）；curl 实测见 `docs/validation/goal8-backend-gap.md` Row #7 |
| 8 | Connectors 真实 MCP 连接与工具发现 | 旧版 connectors 连接 MCP server、探测工具并注入 Agent | 纯配置 CRUD；enable 仅置 `status='ready'`，无连接/探测/工具发现，配置未进入 Codex 线程 | implemented | CLI 配置面（config.toml mcp_servers）+ 协议探测工具列表 + probe 端点；新线程生效已实证；curl 实测见 `docs/validation/goal8-backend-gap.md` Row #8 |
| 9 | Skill 版本列表 / diff / 回滚 | `WebServer.ts:11332-11335` | skills 由 `npx skills` CLI 管理（`skills-lock.json` 只有 `computedHash`，无版本历史概念） | implemented | 快照式替代（不复刻自家 skill store、不与 CLI 争管）：`.agents/skills/` 只读取快照归档于 `.codex/skill-versions/vNNNNNN/`（manifest.json + files/，gitignored）；`POST /api/v1/skills/snapshots` 手动打版，skills 读请求惰性自动记版；`GET versions`/`versions/:id`/`diff?from=&to=`（to 支持 `current`）；rollback 默认 dry-run，`apply=true` 写入前自动打反悔快照。CLI 仍管安装/卸载，重装覆盖回滚结果属预期。curl 实测见 `docs/validation/goal8-backend-gap.md` Row #9 |
| 10 | Script pull（git 轮询触发 automation） | `TriggerRouter.ts:706` | 重新评估：轮询任意配置的 git 仓库（本地路径或远端 URL）的指定分支、发现新 commit 触发 automation，在本地是完全真实的能力（monorepo 自身或用户脚本/内容仓库），无语义冲突 | implemented | 新 kind `git-poll`（repo/branch/pollIntervalSeconds≥15 默认 60/lastSeenCommit 游标，create/update 校验本地路径存在或 URL 形如 git 地址）；migration 012 放宽 automations.kind 与 automation_runs.trigger CHECK（新增 trigger='git'）；`GitPollJob`（30s 检查节奏挂 app 生命周期，`WAKER_GIT_POLL=off` 可关）本地路径走 `git -C log -1`（不 fetch，保持只读；跟踪远端用 URL 模式 `git ls-remote`）；首次轮询只落基线，head 变化经 `store.claimGitPollRun` 单事务排队 trigger='git' 运行，载荷含 source/repo/branch/beforeCommit/afterCommit；失败记日志下轮重试不熔断；前端 AutomationManager 加 Git 轮询选项与详情；测试用真实临时 git 仓库（init/commit/file:// ls-remote），路由 curl 见 `docs/validation/goal8-backend-gap.md` Row #10 |
| 11 | Skill 上传安全扫描 | `WebServer.ts:42845` SkillSafetyScanner | 无上传扫描（skills 走 CLI 安装，无上传单点） | implemented | 重新评估：本地入站面是文件系统变化（CLI 安装/手动放入），Row #9 版本快照即检测钩子，无需新造上传端点。`skill-safety.ts` 确定性扫描器（10 条规则：secret-exfiltration/obfuscated-payload=critical，prompt-injection/hidden-instruction/concealment/privilege-escalation/destructive-command/remote-code-execution=warning，sensitive-path-reference=info；只报告不拦截）；记版时对 added/modified 文本文件扫描并存入 manifest，`GET versions[/:id]` 透出 scan 摘要；`POST /api/v1/skills/scan` 全量手动扫描。curl 实测见 `docs/validation/goal8-backend-gap.md` Row #11 |
| 12 | 会话级 skill 挂载 | `WebServer.ts:11340-11347` | 无会话级挂载；项目级 skills（`.agents/skills`）覆盖主要语义 | implemented | 重新核查找到 CLI 注入面：0.149.0 配置项 `skills.config` 支持按 SKILL.md path 级 enable/disable（config-schema.json SkillConfig；`codex debug prompt-input -c` 实证禁用生效），经 SDK `CodexOptions.config` 按会话 runtime 注入。白名单语义：sessions 表 `skills` 列 + `session-skills.ts` 覆盖生成 + create/PATCH 端点（目录校验 400，skills=null 恢复默认，变更淘汰缓存 runtime 热生效）；真实模型 curl 实证挂载会话看不到未挂载技能、PATCH 后可见，见 `docs/validation/goal8-backend-gap.md` Row #12 |

## Parity（无需动作）

| 特性 | 说明 |
| ---- | ---- |
| 会话 read-all / unread | 本地 sessions 路由已覆盖 |
| 项目 workingDirectory 绑定 | workspace-data 项目记录已覆盖 |
| cron 调度（schedule 触发器） | `claimDueAutomation` 30s 轮询真实触发，已验证 |
| /healthz | 已挂载 |
| 单文件 artifact 下载 | packages/artifacts 已覆盖 |
| prompts 端点 | 本地超前旧版（frontmatter 剥离 + 路径穿越拒绝） |
| slash command | 旧版本即无，非缺口 |
| 文件监听 | 双方皆无 |
| 会话导出 / 产物 ZIP | 双方皆无（本地新增机会，非复刻缺口） |
| Permissions 策略表 | 架构决策：sandbox/approval 由 Codex host 承接（`enforcedBy: codex-host`），PUT 时 host 段回写真实值；策略表为展示镜像，记 parity |
| human-actions source='codex' | 架构决策：审批由 Codex sandbox/approval 承接，无 HITL bridge；生产路径只产生 source='workflow' 属预期，矩阵已记 |

## Degraded（写明原因，不强行补齐）

| 特性 | 旧版证据 | 本地现状 | 原因 / 替代路径 |
| ---- | -------- | -------- | --------------- |
| Memory 导入包 | import 支持 dry-run/mode + includeVersions 文件包 | 只有 export 无 import | 低配 parity；导入需求低频，export 已满足迁移主路径。若队列行 3（Agent 整包导入）落地则覆盖大部分语义 |
| 会话历史时间范围/排序过滤 | 支持范围与排序参数 | 过滤项较少 | 影响小，前端列表场景未受阻 |
| network diagnostic | 旧版网络诊断 | 已在此前矩阵记 degraded | 本地单进程语义弱 |
| Knowledge 向量检索 | 旧版语义嵌入 | `LocalHashEmbedding` 确定性哈希伪向量（代码注释自述非语义质量） | 本地无嵌入模型；FTS5 + hybrid 已验证可用。接入真实嵌入需外部模型，记 degraded |
| IM 渠道 / channels 投递 | 旧版 IM 渠道接入 | channels 仅记录 CRUD 无投递；IM 零端点 | 云端渠道语义，见 excluded |

## Excluded（云端/桌面专属，不逐条对比)

| 能力 | 原因 |
| ---- | ---- |
| QMind / 云团队 / 计费配额 | 云端专属，本地无语义（前端已按 AGENTS.md 跳过对应 UI） |
| 远程设备 | 云端专属 |
| IM 渠道（含 channels 投递） | 云端渠道语义，前端已做降级页 |
| 云分享 / OSS presign / 反馈上云 | 云端存储与上报，本地无语义 |
| trajectory 轨迹 | 被本地 memory dream 架构替代 |
| 预升级备份 | 旧版升级流程专属 |
| 原生目录选择器 | 桌面 shell 语义，Web 无对应面 |
| context 文件版本/锁 | 已知运行时差异（Codex 线程模型不同） |
