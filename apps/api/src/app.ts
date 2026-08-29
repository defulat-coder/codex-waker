import Fastify, { type FastifyInstance } from 'fastify';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import {
  AgentSessionStore,
  agentSessionStoreFor,
  getCodexProjectRoot,
  loadAgents,
  runAgentTurn,
  runCodexOneShot,
} from '@waker/codex-runtime';
import { ArtifactStore } from '@waker/artifacts';
import { KnowledgeStore } from '@waker/knowledge';
import { MemoryStore } from '@waker/memory';
import { WorkspaceStore } from '@waker/workspace-data';
import { loadConfig, type AppConfig } from './config.js';
import { type AppContext } from './context.js';
import { MemoryDreamer } from './memory-dream.js';
import { registerAgentRoutes } from './routes/agents.js';
import { registerAgentPackageRoutes } from './routes/agents-package.js';
import { registerChatRoutes } from './routes/chat.js';
import { registerFileRoutes } from './routes/files.js';
import { registerMetaRoutes } from './routes/meta.js';
import { registerPreferenceRoutes } from './routes/preferences.js';
import { registerSessionRoutes } from './routes/sessions.js';
import { registerSkillRoutes } from './routes/skills.js';
import { registerUsageRoutes } from './routes/usage.js';
import { registerKnowledgeRoutes } from './routes/knowledge.js';
import { registerMemoryRoutes } from './routes/memory.js';
import { registerWorkspaceRoutes } from './routes/workspace.js';
import { registerSessionOutputRoutes } from './routes/session-outputs.js';
import { registerSessionDiagnosticsRoutes } from './routes/session-diagnostics.js';
import { registerCapabilityRoutes } from './routes/capabilities.js';
import { runDueAutomations } from './scheduler.js';
import { MemoryMaintenanceJob, type MemoryMaintenanceJobOptions } from './memory-maintenance.js';
import { GitPollJob, type GitPollJobOptions } from './git-poller.js';
import { AutomationExecutor, type AutomationExecutorOptions } from './automation-executor.js';
import { WorkflowExecutor, type WorkflowExecutorOptions } from './workflow-executor.js';
import { registerWorkflowRoutes } from './routes/workflows.js';
import { registerBoardRoutes } from './routes/board.js';

type AppDependencies = {
  sessionStore?: AgentSessionStore;
  knowledgeStore?: KnowledgeStore;
  memoryStore?: MemoryStore;
  workspaceStore?: WorkspaceStore;
  artifactStore?: ArtifactStore;
  cwd?: string;
  schedulerIntervalMs?: number | false;
  automationExecutor?: AutomationExecutor;
  automationRuntime?: Pick<AutomationExecutorOptions, 'runTurn' | 'abortTurn'>;
  workflowExecutor?: WorkflowExecutor;
  workflowRuntime?: Pick<
    WorkflowExecutorOptions,
    'runTurn' | 'abortTurn' | 'now' | 'setTimer' | 'clearTimer'
  >;
  /** Chat 路由的轮次执行替身（测试用，默认真实 runAgentTurn）。 */
  chatRuntime?: Pick<AppContext, 'runTurn'>;
  /** memory dream 替身（测试用，默认真实 MemoryDreamer）。 */
  memoryDream?: AppContext['memoryDream'];
  /** 每日 memory 维护作业的节奏覆盖（测试用，默认 1h 检查 / 24h 跑一次）。 */
  memoryMaintenanceRuntime?: Pick<MemoryMaintenanceJobOptions, 'checkIntervalMs' | 'runEveryMs'>;
  /** git-poll 轮询作业的节奏/exec 覆盖（测试用，默认 30s 检查）。 */
  gitPollRuntime?: Pick<GitPollJobOptions, 'checkIntervalMs' | 'exec'>;
  /** AI 生成流程定义的一次性调用替身（测试用，默认 runCodexOneShot）。 */
  generateWorkflowDefinition?: AppContext['generateWorkflowDefinition'];
  /** Agent 画像派生的一次性调用替身（测试用，默认 runCodexOneShot）。 */
  summarizeAgentProfile?: AppContext['summarizeAgentProfile'];
};

export function buildApp(
  config: AppConfig = loadConfig(),
  dependencies: AppDependencies = {},
): FastifyInstance {
  const cwd = dependencies.cwd ?? getCodexProjectRoot();
  // Generic workbench data (session bindings, inbox state, preferences) lives in
  // .codex/workbench.sqlite via the codex-runtime better-sqlite3 store; Codex-owned
  // state stays in the CLI's own rollout files.
  // 走按 cwd 共享的 store：每个进程（每个项目根）只持有一条 sqlite 连接。
  const sessions = dependencies.sessionStore ?? agentSessionStoreFor({ cwd });
  const codexDir = join(cwd, '.codex');
  mkdirSync(codexDir, { recursive: true });
  const ownsKnowledge = !dependencies.knowledgeStore;
  const knowledge =
    dependencies.knowledgeStore ?? new KnowledgeStore(join(codexDir, 'knowledge.sqlite'));
  const ownsWorkspace = !dependencies.workspaceStore;
  const workspaceData =
    dependencies.workspaceStore ?? new WorkspaceStore(join(codexDir, 'workspace.sqlite'));
  const ownsMemory = !dependencies.memoryStore;
  const memory = dependencies.memoryStore ?? new MemoryStore(join(codexDir, 'memory.sqlite'));
  const ownsArtifacts = !dependencies.artifactStore;
  const artifacts =
    dependencies.artifactStore ?? new ArtifactStore({ storageRoot: join(codexDir, 'artifacts') });
  const automationExecutor =
    dependencies.automationExecutor ??
    new AutomationExecutor({
      cwd,
      store: workspaceData,
      sessions,
      ...dependencies.automationRuntime,
    });
  const workflowExecutor =
    dependencies.workflowExecutor ??
    new WorkflowExecutor({
      cwd,
      store: workspaceData,
      sessions,
      ...dependencies.workflowRuntime,
    });
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      redact: ['req.headers.authorization', '*.password', '*.apiKey'],
    },
    genReqId: () => `req_${crypto.randomUUID().slice(0, 8)}`,
  });

  const ctx: AppContext = {
    config,
    cwd,
    sessions,
    knowledge,
    memory,
    workspaceData,
    artifacts,
    automationExecutor,
    workflowExecutor,
    runTurn: dependencies.chatRuntime?.runTurn ?? runAgentTurn,
    memoryDream:
      dependencies.memoryDream ??
      new MemoryDreamer({
        memory,
        enabled: config.WAKER_MEMORY_DREAM?.trim().toLowerCase() !== 'off',
        extract: (prompt, model) => runCodexOneShot(prompt, { cwd, ...(model ? { model } : {}) }),
        logger: { warn: (message) => app.log.warn(message) },
      }),
    generateWorkflowDefinition:
      dependencies.generateWorkflowDefinition ??
      ((prompt, model) => runCodexOneShot(prompt, { cwd, ...(model ? { model } : {}) })),
    summarizeAgentProfile:
      dependencies.summarizeAgentProfile ??
      ((prompt, options) =>
        runCodexOneShot(prompt, {
          cwd,
          ...(options?.model ? { model: options.model } : {}),
          ...(options?.thinking ? { reasoningEffort: options.thinking } : {}),
        })),
  };

  // Web 走 vite proxy 同源访问，不需要携带凭证的跨域。
  app.register(cors, { origin: config.WEB_ORIGIN });
  app.register(helmet, { contentSecurityPolicy: false });
  const schedulerIntervalMs =
    dependencies.schedulerIntervalMs === undefined ? 30_000 : dependencies.schedulerIntervalMs;
  let scheduler: ReturnType<typeof setInterval> | undefined;
  if (schedulerIntervalMs !== false && config.CODEX_AGENT_ENABLED) {
    app.addHook('onReady', async () => {
      automationExecutor.recover(loadAgents(cwd).map((agent) => agent.id));
      const tick = () => {
        // Agent definitions are files and can change while the local server is running.
        const result = runDueAutomations(
          workspaceData,
          loadAgents(cwd).map((agent) => agent.id),
        );
        for (const run of result.runs) {
          if (run.status === 'queued') automationExecutor.enqueue(run.wakerId, run.id);
        }
        for (const error of result.errors) app.log.warn(error, 'scheduled automation failed');
      };
      tick();
      scheduler = setInterval(tick, schedulerIntervalMs);
      scheduler.unref();
    });
  } else if (config.CODEX_AGENT_ENABLED) {
    app.addHook('onReady', async () => {
      automationExecutor.recover(loadAgents(cwd).map((agent) => agent.id));
    });
  }
  app.addHook('onReady', async () => {
    workflowExecutor.recover(loadAgents(cwd).map((agent) => agent.id));
  });
  // 每日 memory 维护（trigger='cron'），WAKER_MEMORY_MAINTENANCE=off 时不启动。
  let memoryMaintenance: MemoryMaintenanceJob | undefined;
  if (config.WAKER_MEMORY_MAINTENANCE?.trim().toLowerCase() !== 'off') {
    app.addHook('onReady', async () => {
      memoryMaintenance = new MemoryMaintenanceJob({
        memory,
        scopeIds: () => loadAgents(cwd).map((agent) => agent.id),
        logger: { info: (message) => app.log.info(message), warn: (message) => app.log.warn(message) },
        ...dependencies.memoryMaintenanceRuntime,
      });
      memoryMaintenance.start();
    });
  }
  // git-poll 轮询（kind='git-poll' 触发源），WAKER_GIT_POLL=off 或 Codex 未启用时不启动。
  let gitPoll: GitPollJob | undefined;
  if (config.CODEX_AGENT_ENABLED && config.WAKER_GIT_POLL?.trim().toLowerCase() !== 'off') {
    app.addHook('onReady', async () => {
      gitPoll = new GitPollJob({
        store: workspaceData,
        wakerIds: () => loadAgents(cwd).map((agent) => agent.id),
        enqueue: (wakerId, runId) => automationExecutor.enqueue(wakerId, runId),
        logger: {
          info: (message) => app.log.info(message),
          warn: (message) => app.log.warn(message),
        },
        ...dependencies.gitPollRuntime,
      });
      gitPoll.start();
    });
  }
  app.addHook('onClose', async () => {
    memoryMaintenance?.stop();
    gitPoll?.stop();
    if (scheduler) clearInterval(scheduler);
    await automationExecutor.close();
    await workflowExecutor.close();
    if (ownsKnowledge) knowledge.close();
    if (ownsWorkspace) workspaceData.close();
    if (ownsMemory) memory.close();
    if (ownsArtifacts) artifacts.close();
  });

  app.get('/healthz', async () => ({
    status: 'ok',
    service: 'waker-api',
    timestamp: new Date().toISOString(),
  }));

  app.register(
    async (v1) => {
      // Agent 整包导入的 body 是原始 ZIP；buffer parser 不做任何 JSON 解析。
      v1.addContentTypeParser(
        ['application/zip', 'application/octet-stream', 'application/x-zip-compressed'],
        { parseAs: 'buffer' },
        (_request, body, done) => done(null, body),
      );
      registerMetaRoutes(v1, ctx);
      registerSkillRoutes(v1, ctx);
      registerAgentRoutes(v1, ctx);
      registerAgentPackageRoutes(v1, ctx);
      registerSessionRoutes(v1, ctx);
      registerPreferenceRoutes(v1, ctx);
      registerUsageRoutes(v1, ctx);
      registerChatRoutes(v1, ctx);
      registerFileRoutes(v1, ctx);
      registerKnowledgeRoutes(v1, ctx);
      registerMemoryRoutes(v1, ctx);
      registerWorkspaceRoutes(v1, ctx);
      registerWorkflowRoutes(v1, ctx);
      registerBoardRoutes(v1, ctx);
      registerSessionOutputRoutes(v1, ctx);
      registerSessionDiagnosticsRoutes(v1, ctx);
      registerCapabilityRoutes(v1, ctx);
    },
    { prefix: '/api/v1' },
  );

  app.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: '资源不存在' }));

  app.setErrorHandler((error, request, reply) => {
    const handledError = error as { validation?: unknown; statusCode?: number; message?: string };
    if (handledError.validation)
      return reply
        .code(400)
        .send({ error: `请求参数不合法：${handledError.message ?? 'validation failed'}` });
    request.log.error({ err: error });
    const statusCode =
      handledError.statusCode && handledError.statusCode >= 400 ? handledError.statusCode : 500;
    return reply.code(statusCode).send({ error: '服务暂时无法处理请求' });
  });

  return app;
}
