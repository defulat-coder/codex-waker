import type { FastifyInstance } from 'fastify';
import { basename, relative } from 'node:path';
import type {
  AgentTemplatesResponse,
  AppendSystemResponse,
  SkillListResponse,
  UpdateAppendSystemRequest,
  UpdatePromptRequest,
} from '@waker/contracts';
import {
  AGENT_TEMPLATES,
  AgentCreateError,
  agentSummary,
  getCodexModelConfig,
  getCodexReasoningEffort,
  getCodexSandboxConfig,
  listAgentResources,
  listCodexModels,
  listPrompts,
  listSkills,
  loadAgents,
  readAppendSystem,
  readPrompt,
  writeAppendSystem,
  writePrompt,
} from '@waker/codex-runtime';
import { PromptNameSchema, UpdateAppendSystemSchema, UpdatePromptSchema } from '../schemas.js';
import type { AppContext } from '../context.js';

export function registerMetaRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/workspace', async () => {
    // 一次无参 listSessions 覆盖所有 Agent，按 agentId 分组计数，避免每个 Agent 全量扫一遍目录。
    const sessionCounts = new Map<string, number>();
    for (const session of await ctx.sessions.listSessions()) {
      sessionCounts.set(session.agentId, (sessionCounts.get(session.agentId) ?? 0) + 1);
    }
    return {
      agents: loadAgents(ctx.cwd).map((agent) => ({
        ...agentSummary(agent),
        sessionCount: sessionCounts.get(agent.id) ?? 0,
      })),
      prompts: listPrompts(ctx.cwd),
      models: { current: getCodexModelConfig({}, ctx.cwd), available: listCodexModels(ctx.cwd) },
    };
  });

  app.get('/skills', async (): Promise<SkillListResponse> => {
    const items = listSkills(ctx.cwd);
    return { items, total: items.length };
  });

  app.get('/templates', async (): Promise<AgentTemplatesResponse> => ({
    items: [...AGENT_TEMPLATES],
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
