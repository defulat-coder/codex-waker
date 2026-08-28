import type { FastifyInstance } from 'fastify';
import type {
  AgentDeleteImpact,
  CreateAgentRequest,
  ImportAgentRequest,
  UpdateAgentRequest,
} from '@waker/contracts';
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
import { agentOr404, beginAgentDeletion, endAgentDeletion, type AppContext } from '../context.js';

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

  app.get<{ Params: { agentId: string } }>(
    '/agents/:agentId/delete-impact',
    { schema: { params: AgentParamsSchema } },
    async (request, reply): Promise<AgentDeleteImpact | void> => {
      const agentId = request.params.agentId;
      if (!agentOr404(ctx, agentId, reply)) return;
      const sessions = await ctx.sessions.listSessions(agentId);
      const resources = listAgentResources(ctx.cwd);
      return {
        agentId,
        sessions: sessions.length,
        projects: ctx.workspaceData
          .listProjects(agentId)
          .filter((project) => project.wakerId === agentId).length,
        automations: ctx.workspaceData.listAutomations(agentId).length,
        workflows: ctx.workspaceData.listWorkflows(agentId).length,
        tasks: ctx.workspaceData.queryTasks(agentId).total,
        humanActions: ctx.workspaceData.queryHumanActions(agentId).total,
        connectors: ctx.workspaceData.listConnectors(agentId).length,
        sharedSkills: resources.skills.length,
        behavior: {
          definition: 'delete',
          sessions: 'delete',
          projects: 'delete-record-only',
          board: 'soft-delete-history',
          connectors: 'delete',
          skills: 'shared-preserve',
        },
      };
    },
  );

  app.delete<{ Params: { agentId: string } }>(
    '/agents/:agentId',
    { schema: { params: AgentParamsSchema } },
    async (request, reply) => {
      if (!agentOr404(ctx, request.params.agentId, reply)) return;
      const agentId = request.params.agentId;
      if (!beginAgentDeletion(agentId))
        return reply.code(409).send({ error: `Agent 正在删除：${agentId}` });
      try {
        const activeAutomationRuns = ctx.workspaceData.listRecoverableAutomationRuns(agentId);
        if (activeAutomationRuns.length)
          return reply.code(409).send({ error: '请先取消当前 Waker 的自动任务运行' });
        const activeWorkflowRuns = ctx.workspaceData.listRecoverableWorkflowRuns(agentId);
        if (activeWorkflowRuns.length)
          return reply.code(409).send({ error: '请先取消当前 Waker 的 Workflow 运行' });
        ctx.workspaceData.deleteAutomationsForWaker(agentId);
        ctx.workspaceData.deleteWorkflowsForWaker(agentId);
        const deleteSessions = async () => {
          while (true) {
            const sessions = await ctx.sessions.listSessions(agentId);
            if (!sessions.length) return;
            for (const session of sessions) {
              codexThreadRegistry.cancelQueued(agentId, session.id);
              await codexThreadRegistry.close(agentId, session.id);
              await ctx.sessions.deleteSession(session.id, agentId);
              ctx.workspaceData.deleteSessionContext(agentId, session.id);
            }
          }
        };
        await deleteSessions();
        // Session Store and workspace context can drift after interrupted older builds. The
        // Waker owner is authoritative, so remove every orphan context as a final sweep.
        ctx.workspaceData.deleteSessionContextsForWaker(agentId);
        // Recheck after the asynchronous cleanup so a request that began before the deletion
        // guard cannot leave a live definition behind.
        ctx.workspaceData.deleteAutomationsForWaker(agentId);
        ctx.workspaceData.deleteWorkflowsForWaker(agentId);
        ctx.workspaceData.softDeleteBoardDataForWaker(agentId);
        for (const connector of ctx.workspaceData.listConnectors(agentId))
          ctx.workspaceData.deleteConnector(agentId, connector.id);
        ctx.workspaceData.deletePermissionPolicy(agentId);
        for (const project of ctx.workspaceData
          .listProjects(agentId)
          .filter((value) => value.wakerId === agentId)) {
          ctx.workspaceData.deleteProject(agentId, project.id);
        }
        // Catch requests that passed their first guard immediately before deletion began.
        await deleteSessions();
        deleteAgent(ctx.cwd, agentId);
        return reply.code(204).send();
      } finally {
        endAgentDeletion(agentId);
      }
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
