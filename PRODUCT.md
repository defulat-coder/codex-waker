# Product

<!-- impeccable:product-schema 1 -->

> 本文件依据用户提供的完整 Goal、两个指定参考项目和已恢复源码推断；尚未由用户逐项确认的内容均以“推断”标记。

## Platform

web

## Stack

已由用户指定并由参考架构约束：TypeScript、pnpm/Turborepo、React + Vite、Fastify、SQLite、OpenAI Codex TypeScript SDK。界面与 API 均在本机运行。

## Users

- 主要用户（推断）：在个人电脑上组织多个 AI 助手、项目、会话和知识材料的中文开发者或知识工作者。
- 核心工作：创建和配置 Waker，围绕项目持续对话，把本地资料纳入可追溯检索，并在一个工作台中恢复、检查和管理执行结果。

## Product Purpose

Waker 是一个本地优先的多 Agent 工作台。它复现 QoderWake 0.4.2 中可观察、适合本地落地的产品能力，同时用官方 Codex TypeScript SDK 重建会话运行时，并用本地 SQLite 与混合检索替代专有知识服务。

成功意味着用户可从干净安装启动产品，完成 Waker、项目、会话、流式对话和知识检索的完整流程，刷新后仍能恢复状态，并能在结果中追溯知识来源。

## Positioning

产品的差异机制是“可审查的本地 Agent 运行时 + 项目级知识记忆”：Codex 线程、Waker 定义、项目资料、检索索引和通用业务状态都在本地边界内组织，浏览器不接触模型凭据。

## Operating Context

- 本地 Node.js/pnpm 开发环境与 Codex CLI/SDK。
- 通过浏览器使用 Waker 工作台，通过 HTTP/SSE 与本地 Fastify API 通信。
- 资料来源包括用户创建或导入的文本文件、Markdown 和会话产物。
- 最终验收在 Ego Lite 独立 task space 中进行，覆盖桌面、移动视口和关键持久化流程。

## Capabilities and Constraints

- Waker/Agent 定义、项目、会话、模板、设置、附件/结果和知识/记忆管理。
- Codex Thread 创建、连续运行、恢复、流式事件、工具状态、错误与中断。
- SQLite 持久化；关键词与向量召回可分别运行，也可混合排序并返回引用。
- Web 不导入 Codex SDK，不获取 provider key，也不能扩大服务端沙箱权限。
- 旧版来源是转译恢复源码和生产资源，复现以可观察行为与证据矩阵为准，不追求不可证明的逐文件一致。
- Qoder 专有云端、组织认证、远程机器和企业连接器不作为本地核心依赖；需要时提供明确降级或偏差记录。
- “Circle 类”当前按 SQLite 本地数据层理解（推断），若源码证据指向具体 Circle 抽象则修正。

## Brand Commitments

- 产品名称：Waker。
- 产品语言：中文优先，技术字段和代码保持行业通用英文。
- 视觉与交互权威：QoderWake 0.4.2 的恢复前端资源；新实现应继承其可识别的工作台结构、信息密度、状态语义和已有品牌资产，而不是延续 `codex-samples` 的 Fleet 外观。

## Evidence on Hand

- 工程架构参考：`/Users/xbjt/Documents/myself/codex-samples`。
- 产品与行为参考：`/Users/xbjt/Documents/myself/waker-source/qoderwake-source-archive/versions/0.4.2-cn-6eeb338baf65`。
- 旧版包含恢复的 daemon/CLI 模块、生产 Web bundle、图标、字体与页面素材；没有原始 Git 历史、完整类型信息或测试。
- 当前没有可用于产品宣传的客户、指标、定价或商业证明，界面不得虚构此类内容。

## Product Principles

1. 本地可运行优先：没有专有云端也能完成核心工作流。
2. 来源可追溯：知识检索和 Agent 输出必须能回到文档、分块或会话证据。
3. 运行时边界清晰：浏览器、API、Codex SDK 与本地数据层职责分离。
4. 行为复现胜过代码模仿：以旧版可观察功能为验收依据，以当前 TypeScript 生态重新实现。
5. 状态必须可恢复：刷新、重启、流中断和线程续接都有明确结果。

## Accessibility & Inclusion

推断采用 Web 基础无障碍要求：键盘可操作、可见焦点、语义标签、足够对比度、支持减少动态效果，并在窄屏上保持关键任务可完成。
