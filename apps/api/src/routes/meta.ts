import type { FastifyInstance } from 'fastify';
import { hostname } from 'node:os';
import { basename, relative } from 'node:path';
import type {
  AgentTemplatesResponse,
  AppendSystemResponse,
  SkillListResponse,
  UpdateAppendSystemRequest,
  UpdatePromptRequest,
} from '@waker/contracts';
import {
  AgentCreateError,
  agentSummary,
  getCodexModelConfig,
  getCodexReasoningEffort,
  getCodexSandboxConfig,
  listAgentResources,
  listAgentTemplates,
  listCodexModels,
  listPrompts,
  listSkills,
  loadAgents,
  readAgentTemplateAvatar,
  readAppendSystem,
  readPrompt,
  writeAppendSystem,
  writePrompt,
} from '@waker/codex-runtime';
import {
  AgentParamsSchema,
  PromptNameSchema,
  UpdateAppendSystemSchema,
  UpdatePromptSchema,
} from '../schemas.js';
import type { AppContext } from '../context.js';

export function registerMetaRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/workspace', async () => {
    // 一次无参 listSessions 覆盖所有 Agent，按 agentId 分组计数，避免每个 Agent 全量扫一遍目录。
    // unreadCount 与收件箱同源：needsAttention && !completedAt && !read。
    const sessionCounts = new Map<string, number>();
    const unreadCounts = new Map<string, number>();
    for (const session of await ctx.sessions.listSessions()) {
      sessionCounts.set(session.agentId, (sessionCounts.get(session.agentId) ?? 0) + 1);
      if (session.needsAttention && !session.completedAt && !session.read) {
        unreadCounts.set(session.agentId, (unreadCounts.get(session.agentId) ?? 0) + 1);
      }
    }
    return {
      agents: loadAgents(ctx.cwd).map((agent) => ({
        ...agentSummary(agent),
        sessionCount: sessionCounts.get(agent.id) ?? 0,
        unreadCount: unreadCounts.get(agent.id) ?? 0,
      })),
      prompts: listPrompts(ctx.cwd),
      host: { name: hostname() },
      models: { current: getCodexModelConfig({}, ctx.cwd), available: listCodexModels(ctx.cwd) },
    };
  });

  app.get('/skills', async (): Promise<SkillListResponse> => {
    const items = listSkills(ctx.cwd);
    return { items, total: items.length };
  });

  // 角色模板仓库：.codex/agent-templates/<id>.md，文件即模板（与 agents 同一格式）。
  app.get('/agent-templates', async (): Promise<AgentTemplatesResponse> => ({
    items: listAgentTemplates(ctx.cwd),
  }));

  app.get<{ Params: { agentId: string } }>(
    '/agent-templates/:agentId/avatar',
    { schema: { params: AgentParamsSchema } },
    async (request, reply) => {
      const avatar = readAgentTemplateAvatar(ctx.cwd, request.params.agentId);
      if (!avatar) return reply.code(404).send({ error: '模板头像不存在' });
      return reply.header('cache-control', 'no-cache').type(avatar.mimeType).send(avatar.data);
    },
  );

  // 与 /agent-templates 同源；Templates 页沿用这个较早的路径。
  app.get('/templates', async (): Promise<AgentTemplatesResponse> => ({
    items: listAgentTemplates(ctx.cwd),
  }));

  // Non-sensitive configuration only; provider keys never leave this process.
  app.get('/settings', async () => {
    const resources = listAgentResources(ctx.cwd);
    const sandbox = getCodexSandboxConfig(ctx.cwd);
    return {
      model: { ...getCodexModelConfig({}, ctx.cwd), available: listCodexModels(ctx.cwd) },
      thinkingLevel: getCodexReasoningEffort(undefined, ctx.cwd),
      resources: {
        agents: loadAgents(ctx.cwd).length,
        prompts: resources.prompts.length,
        skills: resources.skills.length,
        appendSystem: resources.appendSystem,
      },
      workspace: {
        name: basename(ctx.cwd),
        sessionDir: relative(ctx.cwd, ctx.sessions.sessionDir),
      },
      security: {
        codexEnabled: ctx.config.CODEX_AGENT_ENABLED,
        sandboxMode: sandbox.sandboxMode,
        approvalPolicy: sandbox.approvalPolicy,
        managedByHost: true,
      },
    };
  });

  app.get<{ Params: { name: string } }>(
    '/prompts/:name',
    {
      schema: { params: PromptNameSchema },
    },
    async (request, reply) => {
      const document = readPrompt(ctx.cwd, request.params.name);
      if (!document) return reply.code(404).send({ error: '提示词不存在' });
      return document;
    },
  );

  app.put<{ Params: { name: string }; Body: UpdatePromptRequest }>(
    '/prompts/:name',
    {
      schema: { params: PromptNameSchema, body: UpdatePromptSchema },
    },
    async (request, reply) => {
      try {
        return writePrompt(ctx.cwd, request.params.name, request.body);
      } catch (error) {
        if (error instanceof AgentCreateError) {
          return reply.code(error.code === 'NOT_FOUND' ? 404 : 400).send({ error: error.message });
        }
        throw error;
      }
    },
  );

  app.get('/append-system', async (): Promise<AppendSystemResponse> => ({
    content: readAppendSystem(ctx.cwd),
  }));

  // 空内容（trim 后）删除 .codex/APPEND_SYSTEM.md，返回规范化后的 content（删除时为 null）。
  app.put<{ Body: UpdateAppendSystemRequest }>(
    '/append-system',
    {
      schema: { body: UpdateAppendSystemSchema },
    },
    async (request): Promise<AppendSystemResponse> => ({
      content: writeAppendSystem(ctx.cwd, request.body.content),
    }),
  );
}
