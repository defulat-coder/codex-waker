# QoderWake 0.4.2 后端审计与迁移基线

## 文档目的

本文记录 QoderWake `0.4.2-cn-6eeb338baf65` 后端的可观察领域模型、HTTP/SSE 契约、会话运行时、专有依赖，以及迁移到本项目 TypeScript 架构时的取舍。

旧版参考根目录：

```text
/Users/xbjt/Documents/myself/waker-source/qoderwake-source-archive/
  versions/0.4.2-cn-6eeb338baf65
```

下文证据路径均相对于该目录。恢复目录来自 Bun/Mach-O 可执行文件，内容是转译后的可读源码而非原始 TypeScript；类型、原始模块边界、测试和 Git 历史并不完整。因此本文只把实际路由、SQL schema、状态转换和运行路径视为证据，不根据文件名推断未观察到的行为。来源说明见 `README.md:1-24` 和 `_recovery/manifest.json`。

审计未读取或分析 `runtime/qoderwake.bundle.js`。所有结论来自恢复后的 `src/`、`packages/` 和恢复清单。

## 核心结论

旧 daemon 是一个本地 Express 服务，内部组合 SQLite、Agent/Waker、Project、Session、Trigger、Task、Workflow、Conversation、Channel、知识与插件等大量模块。`Daemon` 的依赖集合可见 `src/daemon/main.ts:55-180`，集中式路由注册可见 `src/daemon/modules/WebServer.ts:11082-11600`。

0.4.2 已同时存在两套 session runtime：

- 默认 `sdk_local`。
- 仅在 `QODERWAKE_NEW_SESSION_RUNTIME_ROUTE=legacy_remote` 时使用 `legacy_remote`。

证据见 `src/daemon/session-runtime/route.ts:5-10`。这说明“本地持久化的业务 Session + 可恢复的 SDK Session runtime + 事件投影”是旧版已经验证过的产品边界；迁移时应保留这个边界，但用 `@openai/codex-sdk` 替换 Qoder SDK、Qoder CLI transport 和 MachineBridge。

恢复源码中没有 `Circle`、`class Circle` 或同名领域抽象。旧版本地数据库明确使用 `bun:sqlite`，见 `src/daemon/storage/SQLiteBackend.ts:5-45`。因此本项目把需求中的“本地 Circle 类”落实为本地 SQLite 数据层，不创建无证据的 `Circle` 兼容层。

## 旧版架构与数据流

```text
Web / CLI / IM
      |
      v
Express WebServer
      |
      +--> Agent / Project / Trigger / Channel / Conversation services
      |
      +--> SessionRuntimeKernel
             |
             +--> command ledger / idempotency
             +--> runtime coordinator
             +--> Qoder SDK process/worker transport
             +--> canonical event mapper
             +--> transactional SQLite event sink
                         |
                         +--> history REST
                         +--> replay-then-live SSE
      |
      +--> MachineBridge / Qoder Console / QMind / provider services
```

旧版 SQLite 使用 WAL、busy timeout 和 foreign keys，并按当前用户 uid 作用域访问数据，证据见 `src/daemon/storage/SQLiteBackend.ts:15-45,58-100`。新项目应保留 SQLite 作为唯一持久化真相，但不保留云端账户 uid 作为本地 CRUD 的必要前提。

## 旧版实体

### Agent / Waker

结构化列包括：

- `agent_id`
- `employee_id`
- `staff_id`
- `name`
- `workspace`
- `payload`
- `created_at`、`updated_at`

证据：`src/daemon/storage/SQLiteBackend.ts:1375-1404`。

实际 payload/创建请求还包含 `description`、`avatar`、`sessionTimeout`、`defaultModel`、`soulMdPath`、`mcpServers`、`employeeType`、`roleConfig` 和 `skills`。创建过程会生成 workspace、上下文文件、skills、MCP/plugin 配置，并在旧版中同步远端 employee。证据：`src/daemon/modules/WebServer.ts:35221-35420`。

迁移实体：

```text
wakers
  id, name, description, avatar_ref, workspace_path,
  default_model, instructions, status,
  created_at, updated_at
```

`employee_id`、`staff_id` 属于 Qoder 云身份，不进入本地核心模型。若将来接入远端 provider，应放进单独的 `external_identities` 表。

### Project

旧表包含 `project_id`、`worker_id`、`visibility`、`created_by_worker_id`、`name`、`status`、`ephemeral`、payload 和时间戳，另有 `project_usages`。证据：`src/daemon/storage/SQLiteBackend.ts:1439-1475`。

Project payload 包含：

- `description`
- `context_sources`
- `initializer`
- materialization 状态
- memory 状态
- public/private 使用状态

`filesystem` 和 `git_repository` context source 需要 materialization，证据见 `src/daemon/modules/ProjectStore.ts:1-20,107-180`。

迁移实体：

```text
projects
  id, waker_id, name, description, root_path,
  status, created_at, updated_at

project_sources
  id, project_id, kind, label, config_json,
  version, indexed_at, status, error
```

P0 只支持本地文件夹。Git URL 与远端 materialization 放入 P1。

### Session

旧表包含 `session_id`、`agent_id`、`status`、`session_source`、`cwd`、`trigger_id`、`run_id`、`channel_id`、`conversation_id`、payload 和时间戳，证据见 `src/daemon/storage/SQLiteBackend.ts:1351-1373`。

Session payload 还承载：

- title 和 binding
- runtime route/state/epoch/run id
- current model 和 runtime config
- origin、scenario、worker status
- SDK transcript state
- error、termination 与 restart 状态

`SessionStore` 在内存中维护活跃索引，但写入 SQLite 后才构成持久状态；证据见 `src/daemon/modules/SessionStore.ts:30-70,142-240`。

迁移实体：

```text
sessions
  id, waker_id, project_id, title, cwd,
  codex_thread_id,
  status, runtime_state, runtime_epoch, active_run_id,
  error_code, error_message,
  created_at, updated_at, last_active_at
```

业务 Session id 与 Codex thread id 必须分离。前者稳定地服务 UI、项目绑定和本地审计；后者仅用于 SDK 恢复。

### Session event

旧兼容事件表 `session_events` 保存：

- session 内单调 sequence
- source、event type 和 payload
- payload uuid 去重
- soft delete

证据：`src/daemon/storage/SQLiteBackend.ts:1577-1628`。

新 local runtime 使用 `session_runtime_events`，额外保存 run、epoch、durability、priority，并限制 source 为 `sdk`；投影上传另有 `session_projection_outbox`。证据：`src/daemon/storage/SQLiteBackend.ts:1635-1688`。

迁移实体：

```text
session_runs
  id, session_id, turn_number, status,
  started_at, finished_at, error_code, error_message

session_events
  id, session_id, run_id,
  epoch, sequence, cursor,
  type, durability, source,
  payload_json, occurred_at, created_at
```

实时事件和历史记录必须使用同一个 canonical event 结构，不创建“只在 SSE 中存在”的不可恢复消息。

### Trigger、Run 与 Task

`triggers` 保存 prompt、model、environment、enabled、trigger/source kind、schedule、location、workflow kind、execution target、assignees、workspace、pull config、last run 和统计。`trigger_runs` 表示一次触发执行。`tasks` 是 run 下的工作项，并关联 session、workspace、prompt、model、result 和错误。证据：`src/daemon/storage/SQLiteBackend.ts:1855-2040`。

迁移实体：

```text
automations
  id, waker_id, name, prompt, enabled,
  kind, schedule_json, project_id,
  created_at, updated_at

automation_runs
  id, automation_id, session_id,
  status, started_at, finished_at,
  error_code, error_message
```

旧版 `tasks` 同时表示 daemon maintenance job 和用户自动化工作项。新项目应明确区分：用户功能叫 automation/run；进程内部 maintenance job 不暴露成同一领域。

### Conversation

Conversation 是多人/多 Waker 协作层，不等同于普通 Session。旧 schema 包含：

- conversations
- participants 与 runtime bindings
- messages 与 timeline events
- read states
- deliveries/backlog
- runs 与 run frames
- resource bindings
- idempotency records

证据：`src/daemon/conversations/sqlite-store.ts:343-530`。

P0 不引入多人 Conversation kernel。单 Waker 对话直接落在 Session/Run/Event 上。团队 conversation、participant queue 和 surface group 属于 P2；否则会在核心对话完成前复制大量远端协作复杂度。

### Channel

旧 channel 主要保存在配置 payload 的 `channelConfigs` 中，运行时维护 plugin、config、status、last error、生命周期和 outbound queue。证据：`src/daemon/channel/ChannelManager.ts:16-90,100-320`。

迁移实体：

```text
channels
  id, waker_id, kind, name,
  enabled, status, config_json,
  last_error, created_at, updated_at
```

P0 提供 `local_console` channel，使 Channel 管理页、状态、启停和错误态可以离线验证。第三方 provider 不应保存伪连接状态。

### Template

旧 employee template 使用 `employee_type` 和 `conf_map[{conf_name,...}]`。内置/远端模板和本地 custom template 会合并，本地只允许创建、删除 custom template。证据：`src/daemon/modules/WebServer.ts:30186-30280`。

迁移实体：

```text
waker_templates
  id, name, description, avatar_ref,
  instructions, defaults_json,
  builtin, created_at, updated_at
```

模板应用仅负责填充 Waker 创建表单或创建请求，不与 Waker 实例共享可变配置。

### Knowledge

旧版本至少已经对 at-waker message、topic、task、memory 建立 FTS5 表，证据见 `src/daemon/at-waker/AtWakerStore.ts:3085-3088`。旧版 QMind 与 Qoder embedding 仍依赖专有服务，不适合作为本地知识库实现。

迁移实体：

```text
knowledge_documents
  id, title, source_kind, source_uri,
  content_hash, version, status,
  created_at, updated_at, deleted_at

knowledge_chunks
  id, document_id, ordinal,
  content, content_hash, token_count,
  metadata_json

knowledge_embeddings
  chunk_id, adapter, model, dimensions,
  vector_blob, created_at

knowledge_bindings
  id, document_id, target_kind, target_id,
  created_at

knowledge_audit
  id, document_id, operation, version,
  details_json, occurred_at
```

FTS5 表应以 `knowledge_chunks` 为内容源或通过事务同步，向量使用可替换 embedding/index adapter。文档删除必须在一个事务中删除或失效 chunk、FTS、vector 和 binding。

## 旧版 API 矩阵

### System

- `GET /api/openapi.json`
- `GET /api/docs`
- `GET /api/health`
- `GET /api/status`
- `/api/v1/system/*` 下的 health、status、update、restart、shutdown

证据：`src/daemon/modules/WebServer.ts:11082-11100`。

### Agent / Waker

- `GET/POST /api/agents`
- `GET/PUT/DELETE /api/agents/:id`
- avatar、delete impact、profile summary、package import/export/share link
- context 文件 CRUD、history、lock、enabled files
- skills CRUD、toggle、install、upload、versions、diff、rollback、evolution、conflicts
- MCP/connectors CRUD、toggle、auth 和 tool config
- permissions、pending approvals
- custom configs
- workflows

主证据：

- `src/daemon/modules/WebServer.ts:11110-11138,11294-11420`
- `src/daemon/modules/WakerCustomConfigRouter.ts:7-90`
- `src/daemon/modules/WorkflowRouter.ts:10-484`

### Session

- `GET /api/sessions`
- `GET/DELETE /api/sessions/:id`
- `GET /api/agents/:agentId/console-sessions`
- console session query、rename、delete、read-all
- `POST /api/agents/:agentId/sessions`
- session reservation、prewarm、cancel
- `PATCH /api/agents/:agentId/sessions/:sessionId`
- `POST /api/sessions/:sessionId/events`
- history、turn page、debug timeline、trajectory、read/unread
- session artifacts 与 file changes
- `GET /api/sessions/:sessionId/events/stream`
- `GET /api/events/stream`
- `GET /api/console/events/stream`

证据：`src/daemon/modules/WebServer.ts:11138-11149,11425-11450`。

### Project

旧版同时保留 worker/agent alias：

- `GET/POST /api/v1/{workers|agents}/:agentId/projects`
- `GET/PATCH/DELETE .../projects/:projectId`
- GitHub repo、retry、start onboarding
- public projects CRUD 与 users

证据：`src/daemon/modules/WebServer.ts:11452-11478`。

### Trigger / Task

旧版提供：

- Trigger CRUD、enable patch、invoke、run-now
- stats、calendar、runs、run count、tasks、run inspect
- test pull、GitHub test/event activity
- model list
- webhook source catalog/probe/GitHub receiver

agent scoped 路由和部分 legacy global alias 并存。证据：`src/daemon/modules/TriggerRouter.ts:604-1500`。

daemon maintenance task 另有 `GET /api/tasks` 和 `POST /api/tasks/:name/run`。默认任务为每分钟 session timeout、每日清理 7 天旧 session、每三分钟 health check，证据见 `src/daemon/modules/TaskScheduler.ts:5-75` 和 `src/daemon/modules/WebServer.ts:11241-11242`。

### Template

- `GET /api/employee-templates`
- `POST /api/employee-conf-templates`
- `DELETE /api/employee-conf-templates/:employeeType`

证据：`src/daemon/modules/WebServer.ts:11451-11453,30186-30280`。

### Channel

- channel settings、list、detail、config、delete、start、stop、restart
- pairing generate/list/pending/approve/ignore/manual add/delete/target/config/conflict
- DingTalk、Feishu、Weixin、WeCom QR auth
- DingTalk shared identity 与 ignored conversations

证据：`src/daemon/modules/WebServer.ts:12846-12881`。

远端 employee channel 还提供 list/create/update/delete/enabled/start/stop/restart/auth/pairing，证据见 `src/daemon/capabilities/remote/routes/remote-im-channel-routes.ts:4-44`。

### Conversation / Team

- conversation create/get/snapshot/rename/close
- timeline/messages/read/workdir/bindings/participants
- attachment upload/complete/proxy upload/download
- runs/backlog/cancel/frames
- surface groups、members、threads、preferences、system skills

证据：`src/daemon/conversations/ConversationsHttpApi.ts:56-614`。

## Session 与 SSE 事件流

### 创建首轮

UI 调用 `POST /api/agents/:agentId/sessions`。请求要求 title，可带初始 controller events、`user_message_id`、reservation、origin、project/session binding。旧实现依次校验身份、Agent、Project、Model 和 runtime route，并对 `user_message_id` 做幂等处理。证据：`src/daemon/modules/WebServer.ts:23501-23880`。

默认 local 路径会：

1. 生成业务 Session id。
2. 解析 Project 或临时 cwd。
3. 持久化 Session，初始 runtime state 为 `pending`、epoch 为 1。
4. 从 controller events 提取 user message。
5. 准备 SDK runtime 并把 command 交给 ingress。
6. 没有 user message 时进入 `waiting_input`。
7. 返回 session id、title、status、employee id 和 created time。

证据：`src/daemon/modules/WebServer.ts:23940-24125`。

### 连续对话、恢复和中断

后续输入经 `POST /api/sessions/:sessionId/events` 进入，旧协议支持 user message、set model、interrupt 和 approval response。停止但可恢复的 Session 会 event-first wake 或 restart；被接受的事件先形成持久 command/事件，再更新 activity。

旧 `SessionRuntimeKernel` 由 state repository、command ledger、coordinator、runtime factory、transactional event sink 和 transcript store 构成，证据见 `src/daemon/session-runtime/SessionRuntimeKernel.ts:5-180`。

daemon 重启时，`starting`、`running`、`requires_action` 和 `interrupting` 会恢复为 `interrupted`，并继续维护 epoch/sequence，证据见：

- `src/daemon/session-runtime/runtime-state.ts:3-40`
- `src/daemon/session-runtime/SessionRuntimeKernel.ts:145-220`

### Canonical event

旧版 local runtime 对外 DTO：

```ts
type SessionEvent = {
  event_id: string;
  session_id: string;
  sequence_num: number;
  source: string;
  event_type: string;
  payload: Record<string, unknown> & { run_id: string };
  created_at: string;
  ephemeral?: true;
};
```

cursor 由 epoch 和 epoch 内 sequence 组合。证据：`src/daemon/session-runtime/CanonicalEventProjection.ts:3-50`。

主要 durable 类型：

- `user`
- `assistant`
- `result`
- `control_request.*`
- `control_response.*`
- `system.*`
- `runtime.state.changed`

主要 ephemeral 类型：

- `stream_event`
- `partial_assistant`
- `system.status`
- `prompt_suggestion`

映射会对 payload 做白名单投影并移除 token、authorization、password、secret、credential 等敏感字段。证据：`src/daemon/session-runtime/CanonicalEventMapper.ts:12-180`。

`result.success` 将 runtime 转为 `waiting_input`，失败 result 转为 `failed`，证据见 `src/daemon/session-runtime/runtime-state.ts:30-37`。真正终止还会产生 `session.terminated`，携带 reason、recoverable 和 error，证据见 `src/daemon/modules/WebServer.ts:27290-27325`。

### SSE replay-then-live

`GET /api/sessions/:sessionId/events/stream?from_sequence_num=...` 的 local runtime 行为：

1. 设置 `text/event-stream`、no-cache、keep-alive、禁代理缓冲。
2. 注册连接并每 30 秒写 heartbeat。
3. 从 SQLite 分页 replay cursor 之后的 durable 事件。
4. replay 期间到达的 live event 暂存在 pending。
5. 按 sequence 排序、按 event id 去重后 drain pending。
6. 切换为 live 推送。

证据：`src/daemon/modules/WebServer.ts:28318-28389`。

历史 REST 也从相同 runtime event 表按 cursor/limit 读取，证据见 `src/daemon/modules/WebServer.ts:25647-25720`。

## Codex TypeScript runtime 映射

### 包边界

只有 server-side `packages/codex-runtime` 可以 import `@openai/codex-sdk`。Web、contracts、数据库包不能接触 SDK、Codex CLI 路径或 provider 凭据。

推荐边界：

```text
apps/web
  -> HTTP/SSE only

apps/api
  -> validates contracts
  -> calls domain services
  -> owns SSE connections

packages/codex-runtime
  -> new Codex(...)
  -> startThread(...)
  -> resumeThread(codexThreadId, ...)
  -> thread.runStreamed(...)
  -> maps SDK events to canonical events

packages/db
  -> sessions / runs / events / knowledge

packages/contracts
  -> DTOs and error codes only
```

具体 SDK 方法签名必须以锁定版本的官方类型为准；业务层只依赖本项目的 `CodexRuntime` facade，不能把 SDK event union 泄露到 HTTP contract。

### 新会话

```text
POST /api/sessions
  -> insert business session
  -> start Codex thread
  -> persist codex_thread_id
  -> create run
  -> consume streamed turn
  -> append canonical events transactionally
  -> publish committed events to SSE subscribers
```

如果 Thread 创建失败，Session 保留并标记 `failed`，记录可展示的 error code/message；不删除用户提交和审计记录。

### 连续对话

```text
POST /api/sessions/:id/messages
  -> validate session is not deleted
  -> reject or queue when another run is active
  -> resume Codex thread by persisted codex_thread_id
  -> create new run
  -> runStreamed(message)
  -> append and publish events
```

P0 采用每个 Session 最多一个 active run。无需为了未来吞吐引入分布式队列。

### 刷新恢复

浏览器刷新不恢复进程内 stream，而是：

1. REST 获取 Session 和已持久化历史。
2. 以最后 cursor 连接 SSE。
3. API replay 数据库中 cursor 之后的事件。
4. 若 active run 仍在本进程，继续 live 推送。
5. 若 daemon 重启导致 active run 丢失，将 run 标为 `interrupted`；用户可在同一个 `codex_thread_id` 上继续新 turn。

只有当 SDK 明确支持跨进程恢复活动 turn 时才增加活动 turn 恢复。Thread 恢复与进行中 turn 恢复是两个不同能力，文档和 UI 不得混淆。

### SDK event 到 canonical event

至少映射：

- turn started -> `run.started`
- agent message delta -> ephemeral `assistant.delta`
- agent message completed -> durable `assistant.message`
- reasoning/status -> ephemeral `runtime.status`
- tool call started/completed -> durable `tool.started` / `tool.completed`
- approval/input request -> durable `input.required`
- turn completed -> durable `run.completed`
- turn failed -> durable `run.failed`
- cancellation -> durable `run.cancelled`

最终事件名称以本项目 contracts 为准；前端不直接解释 SDK 原始 event。

## SQLite 数据边界

### 数据库负责

- Waker、Project、Session、Run、Message/Event 的持久状态。
- monotonic cursor 与 event id 唯一性。
- Codex thread id 与业务 Session 的绑定。
- message/run 幂等键。
- 知识文档、chunk、FTS、vector、binding、version 和 audit。
- channel/template 的本地配置。
- 删除一致性和事务。

### 进程内内存只负责

- 当前 active runtime/run handle。
- SSE connection 集合。
- 短生命周期订阅与 cancellation controller。
- 非权威缓存。

任何 UI 可见状态如果只存在 Map 中，重启后不可解释，即违反数据边界。

### 事务边界

- SDK event 必须先提交数据库，再推送 SSE。
- 文档导入必须在文档/chunk/FTS 基础数据提交后才标记 ready。
- vector 生成可以增量执行，但 adapter/model/version 必须记录；未完成时状态为 indexing，而不是返回伪完整结果。
- 知识删除必须同步处理 bindings、chunks、FTS 和 vectors。
- Waker 删除必须先检查或明确处理 Project、Session、Channel 和知识 binding。

## 专有依赖与本地替代

| 旧依赖                                                            | 源码证据                                                                                            | 本地替代                                                                         |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Qoder SDK、Qoder CLI、Process/Worker transport、native transcript | `src/daemon/session-runtime/QoderSdkRuntimeFactory.ts:5-130`                                        | server-only `@openai/codex-sdk`，持久化 Codex thread id，canonical event adapter |
| MachineBridge、Gateway、remote employee/session/artifact          | `src/daemon/modules/RemoteCapabilityGateway.ts:5-17`；`src/daemon/modules/WebServer.ts:23501-23880` | 单机 API + SQLite；远端 machine/environment 功能明确排除                         |
| Qoder Console、cloud conversation surface                         | `src/daemon/conversations/ConversationsHttpApi.ts:453-614`                                          | P0 单 Waker Session；P2 再评估本地 team conversation                             |
| Qoder auth、plan、usage、activity                                 | `src/core/endpoints.ts:14-44`；`src/daemon/modules/WebServer.ts:11395-11420`                        | Codex 本地认证边界；不伪造 plan/usage                                            |
| QMind、Qoder embedding/codebase                                   | `packages/qoder-embedding/src/endpoints.ts:45-180`                                                  | 本地 embedding adapter + SQLite vector + FTS5 hybrid retrieval                   |
| Skill market/cloud templates                                      | `src/core/endpoints.ts:35-44`；`src/daemon/modules/WebServer.ts:30186-30280`                        | 仓库内置模板和本地 CRUD                                                          |
| DingTalk、Feishu、Weixin、WeCom、QQ、DWS                          | `src/daemon/channel/plugins/*`；`src/daemon/modules/WebServer.ts:12846-12881`                       | P0 local_console channel；其他 provider 显示 unavailable/未配置                  |
| Microsoft 365 / Graph                                             | `packages/microsoft365-connector/src/index.ts`                                                      | P2 可选 connector，不作为核心依赖                                                |
| Browser relay、A1 work item、plugin marketplace                   | `src/daemon/modules/WebServer.ts:11271-11279`；`src/daemon/modules/PluginRouter.ts:50-337`          | P2 extension；核心功能不得依赖                                                   |

## 交付范围

### P0：必须完成并本地验证

- Waker 列表、创建、查看、编辑、删除。
- 本地模板列表和基于模板创建 Waker。
- 本地 Project CRUD 与 workspace 绑定。
- Session 列表、创建、详情、重命名或归档/删除。
- Codex Thread 首轮、连续对话、刷新后恢复。
- 流式 assistant 输出、run 状态、错误、中断/取消。
- SQLite session/run/event 持久化。
- SSE cursor replay、live、heartbeat、去重。
- 知识文档 CRUD、chunk、FTS、vector、hybrid search、citation、rebuild、delete consistency。
- Waker/Project 与知识文档绑定。
- local_console Channel CRUD、启停和状态。
- 设置页所需本地配置。
- 离线 demo runtime，用于没有 Codex 凭据时验证同一事件链路。

### P1：核心之后实现

- 本地定时 automation CRUD、run now、run history。
- Git repository Project source 和增量索引。
- 附件上传、消息附件与结果文件展示。
- Waker import/export package。
- memory/version/audit timeline UI。
- permission/input-required 的通用交互。
- 额外本地 channel adapter 或 webhook channel。

### P2：明确延后或排除

- MachineBridge、跨设备 Waker 和 runtime environment。
- Qoder Console 同步、share link 和云端 account activity。
- 多 Waker team/surface group/conversation delivery kernel。
- DingTalk、Feishu、Weixin、WeCom、QQ 的真实认证和收发。
- QMind、Qoder skill market、A1、DWS 和 Qoder embedding。
- Microsoft 365、browser extension relay、远端 artifact presign。
- 完整 workflow DSL、worker dispatch 和 plugin marketplace。

P2 项目可以有可见的 unavailable 状态或偏差说明，但不得用假数据冒充已连接能力。

## 关键不变量

1. **SDK 仅服务端可见。** Web bundle、共享 DTO 和浏览器存储不得包含 SDK、CLI 路径或凭据。
2. **业务 Session 与 Codex Thread 分离。** 本地 Session id 是产品主键；Codex thread id 是可替换 runtime binding。
3. **数据库是唯一持久真相。** 进程 Map 不能决定刷新或重启后的 UI 状态。
4. **先提交事件，再推送 SSE。** 客户端看到的 durable event 必须能通过历史 API 重放。
5. **cursor 单调且唯一。** 同一 Session 内不能重复或倒退；重启后继续递增。
6. **消息与 run 必须幂等。** 重试相同 idempotency key 不产生第二个 turn。
7. **每个 Session 至多一个 active run。** P0 对并发输入返回明确冲突或排队结果。
8. **断开 SSE 不取消 turn。** 网络连接生命周期和已接受的 Codex turn 生命周期分离。
9. **Thread 可恢复不等于 turn 可恢复。** daemon 重启后活动 run 若无法恢复，必须标记 interrupted，并允许在原 Thread 上开始下一 turn。
10. **错误是持久状态。** 启动失败、SDK 失败、取消和中断必须有稳定 code/message，刷新后仍可查看。
11. **敏感字段不进入事件 payload。** token、authorization、password、secret、credential 必须在持久化和日志前过滤。
12. **路径受 workspace 边界保护。** Project、附件和知识导入不得通过 `..`、符号链接或未授权绝对路径越界。
13. **知识引用可追溯。** 每条命中必须能回到 document、chunk、version 和 source。
14. **混合检索可确定性测试。** keyword/vector 分数归一化、融合、去重、排序规则固定；离线测试不依赖远端模型。
15. **知识删除一致。** document、chunk、FTS、vector、binding 和 citation 可见性同步变化。
16. **外部能力不静默缺失。** 专有或缺凭据功能必须显示 unavailable/disabled 并写入偏差清单。
17. **删除前检查绑定。** Waker、Project、Session、Channel 与 Knowledge 的关联必须 cascade、restrict 或显式迁移，不能留下孤儿。
18. **协议经 contracts 版本化。** Web 只消费本项目 canonical DTO，不消费 Codex SDK 或旧 Qoder event 原型。

## 验证要求

自动化验证至少覆盖：

- migration 从空库执行和重复执行。
- Waker、Project、Session CRUD 与删除约束。
- Thread id 持久化、resume 和第二轮消息。
- run success、failure、cancel、interrupted。
- event cursor、幂等、SSE replay-then-live 和 heartbeat。
- 浏览器刷新后的 session/history 恢复。
- 文档增删改、重建、FTS、vector、hybrid、citation 和 delete consistency。
- 无 Codex 凭据时 demo adapter 的完整纵向链路。
- console 无未解释错误，网络无关键失败请求。

最终 Ego Lite 验收应从 UI 证明首屏、导航、Waker、Project、Session、流式回复、刷新恢复、Knowledge CRUD/检索/引用、Channel/Template/Settings、空态、错误态和响应式行为，而不能仅以 HTTP 200 或点击成功作为证据。
