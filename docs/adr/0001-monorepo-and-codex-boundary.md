# ADR 0001：Monorepo 与本地运行边界

## 状态

Accepted — 2026-08-28

## 背景

Waker 复现 QoderWake 0.4.2 的本地核心体验，但旧版恢复源码包含 Qoder CLI/SDK、云端 QMind、远程机器、企业 IM 与兼容事件层。新项目不复制这些专有依赖，而以当前 TypeScript 生态重新建立可运行、可测试的边界。

工程边界由本 ADR 固定；产品范围与行为只以 `docs/audit/legacy-0.4.2-feature-matrix.md`、`docs/architecture/legacy-backend-migration.md` 和可运行的 QoderWake 0.4.2 daemon 为证据。其他产品工程不得作为 UI、路由或交互模板。

## 决策

采用 pnpm workspace + Turborepo：

- `apps/web`：React/Vite 操作型工作台。仅通过 HTTP/SSE 访问本地 API。
- `apps/api`：Fastify 校验与传输边界，组合领域 store，不持有前端状态。
- `packages/contracts`：无运行依赖的共享 DTO。
- `packages/codex-runtime`：唯一允许导入 `@openai/codex-sdk` 的包；负责 Waker 定义、Thread 创建/恢复、事件归一化、session 绑定和 rollout 回放。
- `packages/knowledge`：SQLite notebook/document/version/chunk/binding/audit，FTS5 与本地向量/混合检索。
- `packages/memory`：Waker/项目/群组范围的 Markdown memory、版本、快照、timeline、diff/rollback。
- `packages/artifacts`：会话附件、Artifact 与 file-change 元数据；受管目录内原子写入和哈希去重。
- `packages/workspace-data`：SQLite projects/automations/workflows/channels/tasks。

Web 不持有 provider 凭据。API 也不把任意 Codex config、目录权限或沙箱选择暴露给浏览器。宿主统一设置 sandbox/approval，默认 `read-only` + `never`。

## 数据所有权

- `.codex/sessions/`：Codex CLI rollout；对话正文的唯一持久化来源。
- `.codex/workbench.sqlite`：Session↔Waker/thread 绑定、偏好和收件箱状态。
- `.codex/knowledge.sqlite`：知识文档、版本、chunks、FTS、向量、绑定和审计。
- `.codex/workspace.sqlite`：项目、自动任务、工作流、Channel 元数据和任务记录。
- `.codex/memory.sqlite`：Memory 文档、版本、快照和时间线。
- `.codex/artifacts/`：附件/Artifact 受管文件与独立 SQLite 元数据。
- `.codex/agents/*.md`：Waker 定义；正文仅作为新 Thread 首 turn 的 persona 上下文。

三个数据库分离是有意选择：各包拥有自己的版本化 migration，不共享 `schema_migrations` 命名空间，也避免可选知识能力影响 Chat 启动。跨库操作不承诺 ACID；必须跨域时由 API 采用可重试、幂等的顺序操作。

## Codex Thread 不变量

1. 一个持久化 Session 永久绑定一个 Waker。
2. 同一个 Thread 的 turns 串行，不同 Session 可以并发。
3. 首次 `thread.started` 立即保存 thread ID；恢复使用 `resumeThread`。
4. SSE 断开或用户取消通过本轮 `AbortSignal` 中止，不伪装成 provider error。
5. SDK 流式 `turn.failed` 和顶层 `error` 必须显式转成稳定错误。
6. Web 永远不直接导入 SDK 或读取 key。

## 知识检索不变量

1. SQLite 是真源，FTS 与向量是可重建派生索引。
2. 只检索绑定到当前 Waker/项目的 notebook。
3. 更新采用 expectedVersion；旧版本不得出现在当前检索。
4. 删除需级联清理 chunk、FTS 与 embedding。
5. 搜索结果包含 document version 和可回到原文的行号引用。
6. 向量不可用时可降级到关键词，但需要显式标记，不得返回伪向量结果。
7. 注入 Codex 的知识内容是不可信参考，不能成为权限或工具指令。

## 结果

优点：边界可审查、服务端凭据隔离、领域包可独立测试、离线演示可确定复现。代价：旧版云端协作、真实第三方 IM、远程设备和 QMind featured/shared 不再透明可用，必须在功能矩阵中明确标记本地替代或降级。
