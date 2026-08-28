# Waker

本地优先的多 Waker 工作台。前端复现 QoderWake 0.4.2 的核心信息架构与交互，Agent 运行时使用官方 `@openai/codex-sdk` TypeScript Thread API 重新实现，知识库使用本地 SQLite、FTS5 与向量/混合检索。

## 核心能力

- Waker：以 `.codex/agents/*.md` 定义角色、简介、建议问题和 persona prompt。
- Chat：Codex 线程创建、连续对话、恢复、SSE 流式输出、可回放的计划/工具过程、长内容折叠、代码复制/下载、结构化知识来源、中断与错误恢复。
- 附件与结果：新会话首轮或后续 turn 支持文本/图片选择、拖放、粘贴、批量与失败保留；Session Outputs 支持下载、文本/图片预览、Artifact、文件变更和安全删除。
- 项目与任务：public/private 本地目录与已检出的 Git 工作树、完整 CRUD/删除影响、once/interval/cron 自动任务、真实 Codex Automation Run、任务记录和本地 Channel 元数据；Project 工作目录由服务端规范化并限制在仓库边界内。
- Board：Waker 隔离的 List/Lanes、查询与状态/type/source/project 筛选、有界分页、详情与 Task timeline；手工 Task 使用乐观版本 CAS 管理，Automation/Workflow Run 投影由宿主同步且只读，Human Action 在同一工作面处理。
- WakerFlow：Waker 归属的严格 JSON 定义（`action`、`codex`、`decision`、`wait`、`ask_user`、`call_workflow`、`terminal`）、不可变版本、diff 与 dry-run/apply rollback；持久化执行器为每个 Run 创建一个 Codex Session，并支持恢复、取消、重试、人工输入、最大 8 层子流程和有界历史/Trace。
- Skills：项目工作区共享而非 per-Waker；以稳定 locator 展示 `.agents/skills` 仓库 scope、项目 `CODEX_HOME` 下 `.codex/skills` host runtime scope，以及 `skills-lock.json`、frontmatter、调用策略、依赖与文件元数据。Repo Skill 的上传/安装/删除通过固定的 `skills@1.5.23` CLI 完成，host Skill 也会被运行时发现并以 exact locator 管理；skills.sh 明确视为未审查的第三方发现源。
- 知识库：notebook/document CRUD、Markdown/TXT 批量导入与逐文件反馈、Waker/项目读写或只读绑定、全文/向量/混合检索、行号引用、增量重建与版本冲突保护。
- 本地状态：浏览器不接触 SDK 或 provider key；SQLite 与 Codex rollout 均保存在项目本地。

旧版完整功能范围、优先级和本地降级见 [`docs/audit/legacy-0.4.2-feature-matrix.md`](docs/audit/legacy-0.4.2-feature-matrix.md)。

## 架构

```text
apps/web (React/Vite)
        │ HTTP + SSE
apps/api (Fastify)
        ├── packages/contracts       共享 DTO
        ├── packages/codex-runtime   Codex SDK、线程、rollout、session 绑定、Skills inventory
        ├── packages/knowledge       SQLite/FTS5/向量/引用
        ├── packages/memory          Memory 版本、时间线、diff/rollback
        ├── packages/artifacts       会话附件、Artifact 与文件变更
        └── packages/workspace-data  项目、自动任务、工作流、Board/Human Action、Channel
```

边界：

- `@openai/codex-sdk` 只能由 `packages/codex-runtime` 导入。
- API 负责输入校验、资源归属与传输，不对用户消息做关键词路由。
- provider key 只存在于 API/Codex CLI 进程，Web 只消费 `/api/v1`。
- Codex thread rollout 由 Codex 保存；Waker↔Session 绑定和通用数据保存在 SQLite，不重复复制完整对话。
- Agent 文件、skills、prompt、模型输出与导入资料均视为不可信输入，不能扩大宿主沙箱权限。
- Skills 遵循[官方 Codex Skills 文档](https://developers.openai.com/codex/skills)的仓库作用域和渐进式加载语义：先暴露 name/description，选择使用后才加载完整 `SKILL.md`。本项目不额外发明 per-Waker 绑定层。

## 本地启动

要求：Node.js 20+、pnpm 12，以及已安装并登录的 Codex CLI。

```bash
pnpm install
cp .env.example .env
pnpm seed             # 可选：写入幂等的本地演示项目与知识文档
pnpm dev
```

默认地址：Web <https://waker.localhost>，API <https://api.waker.localhost>。

`pnpm dev` 使用 portless。需要普通端口时运行 `pnpm dev:direct`，此时 Vite 默认使用 `http://127.0.0.1:5210`，API 使用 `http://127.0.0.1:4410`。

### Codex 配置

`.env` 中设置 `CODEX_AGENT_ENABLED=true` 才会运行真实对话。默认使用 Codex CLI 已登录的 OpenAI 账号，也可以设置 `CODEX_API_KEY`。自定义 provider 通过 `.codex/settings.json` 配置，密钥仍只放环境变量。

安全默认值：

```dotenv
CODEX_SANDBOX_MODE=read-only
CODEX_APPROVAL_POLICY=never
```

## 验证

```bash
pnpm build
pnpm typecheck
pnpm lint
pnpm test
```

测试使用 `node:test`；Web 组件测试使用 jsdom 和 Testing Library。CI 在干净安装后执行同一组检查。

最终浏览器验收使用 Ego Lite，覆盖 Waker、Chat 阅读与刷新恢复、Project 生命周期与路径错误、Knowledge 文件导入/绑定/解绑/只读/Needs check、三种检索模式、附件与结果、Automation，以及 WakerFlow 的 JSON 校验、版本/回滚、真实 Codex Run、人工输入和 Trace。Goal 5/6 遵循当前仓库的 PC desktop-only 范围；Goal 6 已补 Board Lanes、真实 Workflow Human Action 与 Skill upload/readback/conflict/remove 证据及两张桌面截图。验收记录写入 `docs/validation/`。

当前验收证据见 [`docs/validation/ego-lite-2026-08-28.md`](docs/validation/ego-lite-2026-08-28.md)。

## 目录

```text
apps/web                 Waker 工作台 UI
apps/api                 Fastify HTTP/SSE API
packages/contracts       Web/API 共享类型
packages/codex-runtime   Codex Thread 运行时
packages/knowledge       本地知识库与混合检索
packages/memory          本地 Memory 版本与回滚
packages/artifacts       会话附件、结果与文件变更
packages/workspace-data  本地项目与任务域
.agents/skills           Codex 可发现的工作区共享 Skills
skills-lock.json         Skills CLI 管理的来源与完整性元数据
.codex/agents            Waker 定义
.codex/skills            项目 CODEX_HOME 的 host runtime Skills
.codex/prompts           Composer prompt 模板
.codex/sessions          Codex rollout（gitignored）
docs/audit               旧版功能矩阵与偏差
docs/architecture        架构与迁移证据
```

更详细的开发约束见 [`AGENTS.md`](AGENTS.md) 和 [`PRODUCT.md`](PRODUCT.md)。
