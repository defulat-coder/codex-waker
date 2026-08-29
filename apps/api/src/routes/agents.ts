import type { FastifyInstance } from 'fastify';
import type {
  AgentDeleteImpact,
  AgentHomeResponse,
  CreateAgentRequest,
  ImportAgentRequest,
  SummarizeAgentProfileRequest,
  SummarizeAgentProfileResponse,
  UpdateAgentRequest,
  UploadAgentAvatarRequest,
} from '@waker/contracts';
import {
  AgentCreateError,
  agentCreatedAt,
  codexThreadRegistry,
  createAgent,
  deleteAgent,
  deletePreference,
  importAgent,
  listAgentResources,
  listCodexModels,
  readAgentAvatar,
  readAgentSource,
  updateAgent,
  writeAgentAvatar,
  writeAgentProfileSections,
} from '@waker/codex-runtime';
import {
  AgentParamsSchema,
  CreateAgentSchema,
  ImportAgentSchema,
  SummarizeAgentProfileSchema,
  UpdateAgentSchema,
  UploadAgentAvatarSchema,
} from '../schemas.js';
import {
  buildAgentProfileSummarizePrompt,
  parseAgentProfileOutput,
} from '../agent-profile-summarize.js';
import { agentOr404, beginAgentDeletion, endAgentDeletion, type AppContext } from '../context.js';

/** Same Base64 contract as session attachments; invalid input is a 400, not a 500. */
function decodeAvatarBase64(value: string): Buffer | undefined {
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return undefined;
  return Buffer.from(value, 'base64');
}

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

  // 头像：JSON + Base64（与会话附件同一模式）；magic bytes 与 2MB 上限由 writeAgentAvatar 强制。
  app.put<{ Params: { agentId: string }; Body: UploadAgentAvatarRequest }>(
    '/agents/:agentId/avatar',
    {
      bodyLimit: 4 * 1024 * 1024,
      schema: { params: AgentParamsSchema, body: UploadAgentAvatarSchema },
    },
    async (request, reply) => {
      if (!agentOr404(ctx, request.params.agentId, reply)) return;
      const data = decodeAvatarBase64(request.body.dataBase64);
      if (!data) return reply.code(400).send({ error: 'dataBase64 不是合法 Base64' });
      try {
        return writeAgentAvatar(ctx.cwd, request.params.agentId, {
          mimeType: request.body.mimeType,
          data,
        });
      } catch (error) {
        if (error instanceof AgentCreateError) {
          const status =
            error.code === 'NOT_FOUND' ? 404 : error.code === 'TOO_LARGE' ? 413 : 400;
          return reply.code(status).send({ error: error.message });
        }
        throw error;
      }
    },
  );

  app.get<{ Params: { agentId: string } }>(
    '/agents/:agentId/avatar',
    { schema: { params: AgentParamsSchema } },
    async (request, reply) => {
      if (!agentOr404(ctx, request.params.agentId, reply)) return;
      const avatar = readAgentAvatar(ctx.cwd, request.params.agentId);
      if (!avatar) return reply.code(404).send({ error: '头像不存在' });
      // no-cache：头像可被覆盖更新，<img> 需要拿到最新内容。
      return reply.header('cache-control', 'no-cache').type(avatar.mimeType).send(avatar.data);
    },
  );

  // 画像派生（QoderWake 0.4.2 summarize-profile）：默认只返回派生结果；
  // apply=true 时把 coreCapabilities/workStyles 回写 frontmatter 的 strengths/workStyles。
  app.post<{ Params: { agentId: string }; Body: SummarizeAgentProfileRequest }>(
    '/agents/:agentId/summarize-profile',
    { schema: { params: AgentParamsSchema, body: SummarizeAgentProfileSchema } },
    async (request, reply): Promise<SummarizeAgentProfileResponse | void> => {
      const agent = agentOr404(ctx, request.params.agentId, reply);
      if (!agent) return;
      const { model, thinking, apply } = request.body;
      if (model) {
        const available = new Set(listCodexModels(ctx.cwd).map((entry) => entry.id));
        if (!available.has(model))
          return reply.code(400).send({ error: `模型不在可用列表中：${model}` });
      }
      let raw: string;
      try {
        raw = await ctx.summarizeAgentProfile(buildAgentProfileSummarizePrompt(agent), {
          ...(model ? { model } : {}),
          ...(thinking ? { thinking } : {}),
        });
      } catch (error) {
        return reply.code(502).send({
          error: `画像派生失败：${error instanceof Error ? error.message : '模型调用失败'}`,
        });
      }
      let profile: SummarizeAgentProfileResponse['profile'];
      try {
        profile = parseAgentProfileOutput(raw);
      } catch (error) {
        return reply.code(502).send({
          error: `画像派生失败：${error instanceof Error ? error.message : 'AI 输出无法解析'}`,
        });
      }
      if (apply) {
        try {
          writeAgentProfileSections(ctx.cwd, agent.id, {
            strengths: profile.coreCapabilities,
            workStyles: profile.workStyles,
          });
        } catch (error) {
          if (error instanceof AgentCreateError)
            return reply.code(400).send({ error: error.message });
          throw error;
        }
      }
      return { agentId: agent.id, profile, applied: apply === true };
    },
  );
  // Waker Home 数据：入职时间取定义文件 birthtime，计数与 delete-impact 同源，
  // 活跃度按会话 updated_at 的日期分组（session store SQL 聚合，只扫该 Agent 的行）。
  app.get<{ Params: { agentId: string } }>(
    '/agents/:agentId/home',
    { schema: { params: AgentParamsSchema } },
    async (request, reply): Promise<AgentHomeResponse | void> => {
      const agentId = request.params.agentId;
      if (!agentOr404(ctx, agentId, reply)) return;
      const sessions = await ctx.sessions.listSessions(agentId);
      return {
        createdAt: agentCreatedAt(ctx.cwd, agentId),
        counts: {
          sessions: sessions.length,
          questions: sessions.reduce((sum, session) => sum + session.questionCount, 0),
          automations: ctx.workspaceData.listAutomations(agentId).length,
          projects: ctx.workspaceData
            .listProjects(agentId)
            .filter((project) => project.wakerId === agentId).length,
          workflows: ctx.workspaceData.listWorkflows(agentId).length,
          tasks: ctx.workspaceData.queryTasks(agentId).total,
        },
        activity: ctx.sessions.workbench.sessionActivityByDay(agentId),
      };
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
      const memoryScope = { type: 'waker' as const, id: agentId };
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
        memories: ctx.memory.list({ scope: memoryScope }).length,
        knowledgeBindings: ctx.knowledge
          .listBindings()
          .filter((item) => item.scopeType === 'waker' && item.scopeId === agentId).length,
        sharedSkills: resources.skills.length,
        behavior: {
          definition: 'delete',
          sessions: 'delete',
          projects: 'delete-record-only',
          board: 'soft-delete-history',
          connectors: 'delete',
          memories: 'soft-delete',
          knowledgeBindings: 'delete',
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
        const memoryScope = { type: 'waker' as const, id: agentId };
        for (const memory of ctx.memory.list({ scope: memoryScope }))
          ctx.memory.delete(memory.id, { expectedVersion: memory.version, scope: memoryScope });
        for (const binding of ctx.knowledge
          .listBindings()
          .filter((item) => item.scopeType === 'waker' && item.scopeId === agentId)) {
          ctx.knowledge.unbindNotebook(binding.notebookId, {
            scopeType: 'waker',
            scopeId: agentId,
          });
        }
        deletePreference(ctx.cwd, `thinking.${agentId}`);
        deletePreference(ctx.cwd, `model.${agentId}`);
        // Catch requests that passed their first guard immediately before deletion began.
        await deleteSessions();
        ctx.sessions.deleteSidebarSections(agentId);
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
