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
} from '@waker/codex-runtime';
import { ArtifactStore } from '@waker/artifacts';
import { KnowledgeStore } from '@waker/knowledge';
import { MemoryStore } from '@waker/memory';
import { WorkspaceStore } from '@waker/workspace-data';
import { loadConfig, type AppConfig } from './config.js';
import { type AppContext } from './context.js';
import { registerAgentRoutes } from './routes/agents.js';
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
import { registerCapabilityRoutes } from './routes/capabilities.js';
import { runDueAutomations } from './scheduler.js';

type AppDependencies = {
  sessionStore?: AgentSessionStore;
  knowledgeStore?: KnowledgeStore;
  memoryStore?: MemoryStore;
  workspaceStore?: WorkspaceStore;
  artifactStore?: ArtifactStore;
  cwd?: string;
  schedulerIntervalMs?: number | false;
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
  const ctx: AppContext = { config, cwd, sessions, knowledge, memory, workspaceData, artifacts };

  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      redact: ['req.headers.authorization', '*.password', '*.apiKey'],
    },
    genReqId: () => `req_${crypto.randomUUID().slice(0, 8)}`,
  });

  // Web 走 vite proxy 同源访问，不需要携带凭证的跨域。
  app.register(cors, { origin: config.WEB_ORIGIN });
  app.register(helmet, { contentSecurityPolicy: false });
  const schedulerIntervalMs =
    dependencies.schedulerIntervalMs === undefined ? 30_000 : dependencies.schedulerIntervalMs;
  let scheduler: ReturnType<typeof setInterval> | undefined;
  if (schedulerIntervalMs !== false) {
    app.addHook('onReady', async () => {
      const tick = () => {
        const result = runDueAutomations(
          workspaceData,
          loadAgents(cwd).map((agent) => agent.id),
        );
        for (const error of result.errors) app.log.warn(error, 'scheduled automation failed');
      };
      tick();
      scheduler = setInterval(tick, schedulerIntervalMs);
      scheduler.unref();
    });
    app.addHook('onClose', async () => {
      if (scheduler) clearInterval(scheduler);
    });
  }
  if (ownsKnowledge) app.addHook('onClose', async () => knowledge.close());
  if (ownsWorkspace) app.addHook('onClose', async () => workspaceData.close());
  if (ownsMemory) app.addHook('onClose', async () => memory.close());
  if (ownsArtifacts) app.addHook('onClose', async () => artifacts.close());

  app.get('/healthz', async () => ({
    status: 'ok',
    service: 'waker-api',
    timestamp: new Date().toISOString(),
  }));

  app.register(
    async (v1) => {
      registerMetaRoutes(v1, ctx);
      registerSkillRoutes(v1, ctx);
      registerAgentRoutes(v1, ctx);
      registerSessionRoutes(v1, ctx);
      registerPreferenceRoutes(v1, ctx);
      registerUsageRoutes(v1, ctx);
      registerChatRoutes(v1, ctx);
      registerFileRoutes(v1, ctx);
      registerKnowledgeRoutes(v1, ctx);
      registerMemoryRoutes(v1, ctx);
      registerWorkspaceRoutes(v1, ctx);
      registerSessionOutputRoutes(v1, ctx);
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
