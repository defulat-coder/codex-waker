import type { FastifyInstance } from 'fastify';
import type { CreateAgentRequest, ImportAgentRequest, UpdateAgentRequest } from '@waker/contracts';
import {
  AgentCreateError,
  codexThreadRegistry,
  createAgent,
  deleteAgent,
  importAgent,
  listAgentResources,
  readAgentSource,
  updateAgent,
} from '@waker/codex-runtime';
import {
  AgentParamsSchema,
  CreateAgentSchema,
  ImportAgentSchema,
  UpdateAgentSchema,
} from '../schemas.js';
import { agentOr404, type AppContext } from '../context.js';

export function registerAgentRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post<{ Body: CreateAgentRequest }>(
    '/agents',
    { schema: { body: CreateAgentSchema } },
    async (request, reply) => {
      try {
        const agent = createAgent(ctx.cwd, request.body);
        return reply.code(201).send(agent);
      } catch (error) {
        if (error instanceof AgentCreateError) {
          return reply.code(error.code === 'CONFLICT' ? 409 : 400).send({ error: error.message });
        }
        throw error;
      }
    },
  );

  app.post<{ Body: ImportAgentRequest }>(
    '/agents/import',
    { schema: { body: ImportAgentSchema } },
    async (request, reply) => {
      try {
        return reply.code(201).send(importAgent(ctx.cwd, request.body));
      } catch (error) {
        if (error instanceof AgentCreateError) {
          return reply.code(error.code === 'CONFLICT' ? 409 : 400).send({ error: error.message });
        }
        throw error;
      }
    },
  );

  app.patch<{ Params: { agentId: string }; Body: UpdateAgentRequest }>(
    '/agents/:agentId',
    { schema: { params: AgentParamsSchema, body: UpdateAgentSchema } },
    async (request, reply) => {
      try {
        return updateAgent(ctx.cwd, request.params.agentId, request.body);
      } catch (error) {
        if (error instanceof AgentCreateError) {
          return reply.code(error.code === 'NOT_FOUND' ? 404 : 400).send({ error: error.message });
        }
        throw error;
      }
    },
  );

  app.get<{ Params: { agentId: string } }>(
    '/agents/:agentId',
    { schema: { params: AgentParamsSchema } },
    async (request, reply) => {
      const agent = agentOr404(ctx, request.params.agentId, reply);
      if (!agent) return;
      return agent;
    },
  );

  app.get<{ Params: { agentId: string } }>(
    '/agents/:agentId/source',
    { schema: { params: AgentParamsSchema } },
    async (request, reply) => {
      if (!agentOr404(ctx, request.params.agentId, reply)) return;
      return reply
        .header('content-disposition', `attachment; filename="${request.params.agentId}.md"`)
        .type('text/markdown; charset=utf-8')
        .send(readAgentSource(ctx.cwd, request.params.agentId));
    },
  );

  app.delete<{ Params: { agentId: string } }>(
    '/agents/:agentId',
    { schema: { params: AgentParamsSchema } },
    async (request, reply) => {
      if (!agentOr404(ctx, request.params.agentId, reply)) return;
      const sessions = await ctx.sessions.listSessions(request.params.agentId);
      for (const session of sessions) {
        codexThreadRegistry.cancelQueued(request.params.agentId, session.id);
        await codexThreadRegistry.close(request.params.agentId, session.id);
        await ctx.sessions.deleteSession(session.id, request.params.agentId);
      }
      deleteAgent(ctx.cwd, request.params.agentId);
      return reply.code(204).send();
    },
  );

  app.get<{ Params: { agentId: string } }>(
    '/agents/:agentId/resources',
    { schema: { params: AgentParamsSchema } },
    async (request, reply) => {
      if (!agentOr404(ctx, request.params.agentId, reply)) return;
      const sessionsForAgent = await ctx.sessions.listSessions(request.params.agentId);
      return {
        ...listAgentResources(ctx.cwd),
        stats: {
          sessionCount: sessionsForAgent.length,
          questionCount: sessionsForAgent.reduce((sum, session) => sum + session.questionCount, 0),
        },
      };
    },
  );
}
