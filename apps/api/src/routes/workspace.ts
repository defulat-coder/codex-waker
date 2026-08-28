import type { FastifyInstance, FastifyReply } from 'fastify';
import { Type } from '@sinclair/typebox';
import { AGENT_THINKING_LEVELS } from '@waker/contracts';
import type {
  AgentThinkingLevel,
  AutomationRunRecord,
  ChatUsage,
  LocalResourcesResponse,
  ProjectDeleteImpact,
  WakerAutomation,
  WakerChannel,
  WakerProject,
  WakerTask,
  WakerWorkflowSummary,
} from '@waker/contracts';
import type {
  Automation,
  AutomationRun,
  Channel,
  Project,
  Task,
  Workflow,
} from '@waker/workspace-data';
import {
  getCodexModelConfig,
  getCodexReasoningEffort,
  listCodexModels,
} from '@waker/codex-runtime';
import type { AppContext } from '../context.js';
import { agentOr404, rejectDeletingAgent } from '../context.js';
import { resolveProjectDirectory } from '../project-path.js';

const id = Type.String({ minLength: 1, maxLength: 160 });
const wakerBody = Type.Object({ wakerId: id });
const nullableId = Type.Union([id, Type.Null()]);
const nullableText = Type.Union([Type.String({ minLength: 1, maxLength: 240 }), Type.Null()]);
const nullableTimestamp = Type.Union([Type.String({ minLength: 1, maxLength: 80 }), Type.Null()]);
const nullableThinking = Type.Union([
  ...AGENT_THINKING_LEVELS.map((level) => Type.Literal(level)),
  Type.Null(),
]);
const iso = (value: number | null): string | undefined =>
  value === null ? undefined : new Date(value).toISOString();

function projectDto(value: Project): WakerProject {
  return {
    id: value.id,
    wakerId: value.wakerId,
    name: value.name,
    ...(value.description ? { description: value.description } : {}),
    visibility: value.visibility,
    source: value.source === 'git' ? 'git' : 'filesystem',
    path: value.path ?? '',
    status:
      value.status === 'error' ? 'error' : value.status === 'syncing' ? 'initializing' : 'ready',
    ...(value.error ? { error: value.error } : {}),
    createdAt: new Date(value.createdAt).toISOString(),
    updatedAt: new Date(value.updatedAt).toISOString(),
  };
}

function automationDto(value: Automation): WakerAutomation {
  return {
    id: value.id,
    wakerId: value.wakerId,
    name: value.name,
    kind: value.kind,
    ...(value.schedule ? { schedule: value.schedule } : {}),
    prompt: value.prompt,
    ...(value.projectId ? { projectId: value.projectId } : {}),
    ...(value.model ? { model: value.model } : {}),
    ...(value.thinking ? { thinking: value.thinking } : {}),
    enabled: value.enabled,
    lifecycle: value.completedAt ? 'completed' : value.enabled ? 'active' : 'paused',
    timezone: value.timezone,
    ...(iso(value.startAt) ? { startAt: iso(value.startAt) } : {}),
    ...(iso(value.endAt) ? { endAt: iso(value.endAt) } : {}),
    ...(value.maxRuns === null ? {} : { maxRuns: value.maxRuns }),
    runCount: value.runCount,
    misfirePolicy: value.misfirePolicy,
    ...(iso(value.lastRun) ? { lastRunAt: iso(value.lastRun) } : {}),
    ...(iso(value.lastScheduledAt) ? { lastScheduledAt: iso(value.lastScheduledAt) } : {}),
    ...(iso(value.nextRun) ? { nextRunAt: iso(value.nextRun) } : {}),
    ...(iso(value.completedAt) ? { completedAt: iso(value.completedAt) } : {}),
    createdAt: new Date(value.createdAt).toISOString(),
    updatedAt: new Date(value.updatedAt).toISOString(),
  };
}

function usageDto(value: unknown): ChatUsage | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const usage = value as Record<string, unknown>;
  if (
    !['input', 'output', 'total'].every(
      (key) => Number.isSafeInteger(usage[key]) && (usage[key] as number) >= 0,
    )
  )
    return undefined;
  return {
    input: usage.input as number,
    output: usage.output as number,
    total: usage.total as number,
  };
}

function automationRunDto(value: AutomationRun): AutomationRunRecord {
  const usage = usageDto(value.usage);
  return {
    id: value.id,
    automationId: value.automationId,
    taskId: value.taskId,
    wakerId: value.wakerId,
    status: value.status,
    trigger: value.trigger,
    ...(iso(value.scheduledFor) ? { scheduledFor: iso(value.scheduledFor) } : {}),
    nameSnapshot: value.nameSnapshot,
    promptSnapshot: value.promptSnapshot,
    ...(value.projectId ? { projectId: value.projectId } : {}),
    ...(value.sessionId ? { sessionId: value.sessionId } : {}),
    ...(value.model ? { model: value.model } : {}),
    ...(value.thinking ? { thinking: value.thinking } : {}),
    ...(value.input === undefined ? {} : { input: value.input }),
    ...(value.output === undefined ? {} : { output: value.output }),
    ...(typeof value.result === 'string' ? { result: value.result } : {}),
    ...(usage ? { usage } : {}),
    ...(value.error ? { error: value.error } : {}),
    attempt: value.attempt,
    ...(value.retryOfRunId ? { retryOfRunId: value.retryOfRunId } : {}),
    createdAt: new Date(value.createdAt).toISOString(),
    updatedAt: new Date(value.updatedAt).toISOString(),
    ...(iso(value.startedAt) ? { startedAt: iso(value.startedAt) } : {}),
    ...(iso(value.completedAt) ? { completedAt: iso(value.completedAt) } : {}),
  };
}

function optionalTimestamp(value: string | null | undefined): number | null | undefined {
  if (value === undefined || value === null) return value;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error('时间必须是 ISO 8601 格式');
  return parsed;
}

function cleanAutomationPrompt(value: string): string {
  const clean = [...value]
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code === 9 || code === 10 || code === 13 || (code > 31 && code !== 127);
    })
    .join('')
    .trim();
  if (!clean) throw new Error('prompt is required');
  if (clean.length > 20_000) throw new Error('prompt exceeds 20000 characters');
  return clean;
}

function validateAutomationSelection(
  ctx: AppContext,
  wakerId: string,
  value: { projectId?: string | null; model?: string | null; thinking?: string | null },
): { projectId: string | null; model: string | null; thinking: AgentThinkingLevel } {
  const projectId = value.projectId ?? null;
  if (projectId && !ctx.workspaceData.getOwnedProject(wakerId, projectId))
    throw new Error('项目不存在或不属于当前 Waker');
  const model = value.model ?? getCodexModelConfig({}, ctx.cwd).model ?? null;
  if (model && !listCodexModels(ctx.cwd).some((entry) => entry.id === model))
    throw new Error(`模型不在可用列表中：${model}`);
  if (value.thinking && !(AGENT_THINKING_LEVELS as readonly string[]).includes(value.thinking))
    throw new Error(`无效的思考级别：${value.thinking}`);
  const thinking = getCodexReasoningEffort(
    (value.thinking ?? undefined) as AgentThinkingLevel | undefined,
    ctx.cwd,
  );
  return { projectId, model, thinking };
}

function workflowDto(value: Workflow): WakerWorkflowSummary {
  return {
    id: value.id,
    wakerId: value.wakerId,
    ...(value.projectId ? { projectId: value.projectId } : {}),
    ...(value.model ? { model: value.model } : {}),
    ...(value.thinking ? { thinking: value.thinking } : {}),
    name: value.name,
    ...(value.description ? { description: value.description } : {}),
    status: value.status,
    version: value.version,
    nodeCount: value.definition?.nodes.length ?? 0,
    validationErrors: value.validationErrors,
    createdAt: new Date(value.createdAt).toISOString(),
    updatedAt: new Date(value.updatedAt).toISOString(),
  };
}

function channelDto(value: Channel): WakerChannel {
  const providers = ['dingtalk', 'feishu', 'weixin', 'wecom', 'qq'] as const;
  const provider = providers.find((item) => item === value.provider) ?? 'local';
  return {
    id: value.id,
    provider,
    name: value.name,
    status:
      value.status === 'connected' ? 'connected' : value.status === 'error' ? 'error' : 'stopped',
    config: Object.fromEntries(
      Object.entries(value.configMetadata).filter(
        (entry): entry is [string, string | number | boolean] =>
          ['string', 'number', 'boolean'].includes(typeof entry[1]),
      ),
    ),
    createdAt: new Date(value.createdAt).toISOString(),
    updatedAt: new Date(value.updatedAt).toISOString(),
  };
}

function taskDto(value: Task): WakerTask {
  return {
    id: value.id,
    wakerId: value.wakerId,
    title: value.title,
    description: value.description,
    type: value.type,
    origin: value.origin,
    managed: value.origin === 'derived',
    status: value.status,
    priority: value.priority,
    position: value.position,
    version: value.version,
    ...(value.projectId ? { projectId: value.projectId } : {}),
    sourceType: value.sourceType,
    sourceId: value.sourceId,
    source: value.source,
    ...(value.runId ? { runId: value.runId } : {}),
    ...(value.sessionId ? { sessionId: value.sessionId } : {}),
    ...(value.parentTaskId ? { parentTaskId: value.parentTaskId } : {}),
    ...(value.result === null ? {} : { result: value.result }),
    ...(value.error === null ? {} : { error: value.error }),
    createdAt: new Date(value.createdAt).toISOString(),
    updatedAt: new Date(value.updatedAt).toISOString(),
    lastActiveAt: new Date(value.lastActiveAt).toISOString(),
    ...(value.startedAt ? { startedAt: new Date(value.startedAt).toISOString() } : {}),
    ...(value.completedAt ? { completedAt: new Date(value.completedAt).toISOString() } : {}),
  };
}

function badRequest(reply: FastifyReply, error: unknown): void {
  reply.code(400).send({ error: error instanceof Error ? error.message : '请求无法处理' });
}

export function registerWorkspaceRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/local-resources', async (request, reply) => {
    const { wakerId } = request.query as { wakerId?: string };
    if (!wakerId) return reply.code(400).send({ error: 'wakerId 必填' });
    const response: LocalResourcesResponse = {
      projects: ctx.workspaceData.listProjects(wakerId).map(projectDto),
      automations: ctx.workspaceData.listAutomations(wakerId).map(automationDto),
      workflows: ctx.workspaceData.listWorkflows(wakerId).map(workflowDto),
      channels: ctx.workspaceData.listChannels().map(channelDto),
      tasks: ctx.workspaceData.listTasks(wakerId).map(taskDto),
    };
    return response;
  });

  app.post(
    '/projects',
    {
      schema: {
        body: Type.Object({
          wakerId: id,
          name: Type.String({ minLength: 1, maxLength: 160 }),
          description: Type.Optional(Type.String({ maxLength: 2000 })),
          visibility: Type.Union([Type.Literal('public'), Type.Literal('private')]),
          source: Type.Union([Type.Literal('filesystem'), Type.Literal('git')]),
          path: Type.String({ minLength: 1, maxLength: 4000 }),
        }),
      },
    },
    async (request, reply) => {
      const body = request.body as {
        wakerId: string;
        name: string;
        description?: string;
        visibility: 'public' | 'private';
        source: 'filesystem' | 'git';
        path: string;
      };
      if (!agentOr404(ctx, body.wakerId, reply)) return;
      if (rejectDeletingAgent(reply, body.wakerId)) return;
      try {
        const path = resolveProjectDirectory(ctx.cwd, body.path, body.source).storedPath;
        return reply.code(201).send(
          projectDto(
            ctx.workspaceData.createProject({
              ...body,
              path,
              description: body.description ?? '',
              status: 'ready',
            }),
          ),
        );
      } catch (error) {
        return badRequest(reply, error);
      }
    },
  );

  app.patch(
    '/projects/:projectId',
    {
      schema: {
        params: Type.Object({ projectId: id }),
        body: Type.Object({
          wakerId: id,
          name: Type.Optional(Type.String({ minLength: 1, maxLength: 160 })),
          description: Type.Optional(Type.String({ maxLength: 2000 })),
          visibility: Type.Optional(Type.Union([Type.Literal('public'), Type.Literal('private')])),
          source: Type.Optional(Type.Union([Type.Literal('filesystem'), Type.Literal('git')])),
          path: Type.Optional(Type.String({ minLength: 1, maxLength: 4000 })),
        }),
      },
    },
    async (request, reply) => {
      const { projectId } = request.params as { projectId: string };
      const { wakerId, ...patch } = request.body as {
        wakerId: string;
        name?: string;
        description?: string;
        visibility?: 'public' | 'private';
        source?: 'filesystem' | 'git';
        path?: string;
      };
      if (!agentOr404(ctx, wakerId, reply)) return;
      if (rejectDeletingAgent(reply, wakerId)) return;
      const current = ctx.workspaceData.getOwnedProject(wakerId, projectId);
      if (!current) return reply.code(404).send({ error: '项目不存在' });
      try {
        const source = patch.source ?? current.source;
        const path = resolveProjectDirectory(
          ctx.cwd,
          patch.path ?? current.path,
          source,
        ).storedPath;
        return projectDto(ctx.workspaceData.updateProject(wakerId, projectId, { ...patch, path })!);
      } catch (error) {
        return badRequest(reply, error);
      }
    },
  );

  app.get(
    '/projects/:projectId/delete-impact',
    {
      schema: { params: Type.Object({ projectId: id }), querystring: Type.Object({ wakerId: id }) },
    },
    async (request, reply) => {
      const { projectId } = request.params as { projectId: string };
      const { wakerId } = request.query as { wakerId: string };
      const impact = ctx.workspaceData.getProjectDeleteImpact(wakerId, projectId);
      if (!impact) return reply.code(404).send({ error: '项目不存在' });
      const response: ProjectDeleteImpact = {
        ...impact,
        behavior: {
          sessionContexts: 'delete',
          tasks: 'detach-and-preserve',
          automationDefinitions: 'detach-and-pause',
          automationTasks: 'preserve',
          workflowDefinitions: 'detach-and-pause',
          workflowRuns: 'preserve',
        },
      };
      return response;
    },
  );

  app.delete(
    '/projects/:projectId',
    {
      schema: { params: Type.Object({ projectId: id }), querystring: Type.Object({ wakerId: id }) },
    },
    async (request, reply) => {
      const { projectId } = request.params as { projectId: string };
      const { wakerId } = request.query as { wakerId: string };
      if (!agentOr404(ctx, wakerId, reply)) return;
      if (rejectDeletingAgent(reply, wakerId)) return;
      try {
        return ctx.workspaceData.deleteProject(wakerId, projectId)
          ? reply.code(204).send()
          : reply.code(404).send({ error: '项目不存在' });
      } catch (error) {
        return reply.code(409).send({
          error: error instanceof Error ? error.message : '项目暂时无法删除',
        });
      }
    },
  );

  app.post(
    '/automations',
    {
      schema: {
        body: Type.Object({
          wakerId: id,
          name: Type.String({ minLength: 1, maxLength: 160 }),
          kind: Type.Union([Type.Literal('schedule'), Type.Literal('api'), Type.Literal('event')]),
          schedule: Type.Optional(Type.String({ maxLength: 240 })),
          prompt: Type.String({ minLength: 1, maxLength: 20_000 }),
          projectId: Type.Optional(nullableId),
          model: Type.Optional(nullableText),
          thinking: Type.Optional(nullableThinking),
          enabled: Type.Optional(Type.Boolean()),
          timezone: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
          startAt: Type.Optional(nullableTimestamp),
          endAt: Type.Optional(nullableTimestamp),
          maxRuns: Type.Optional(Type.Union([Type.Integer({ minimum: 1 }), Type.Null()])),
          misfirePolicy: Type.Optional(
            Type.Union([Type.Literal('run_once'), Type.Literal('skip')]),
          ),
        }),
      },
    },
    async (request, reply) => {
      const body = request.body as {
        wakerId: string;
        name: string;
        kind: 'schedule' | 'api' | 'event';
        schedule?: string;
        prompt: string;
        projectId?: string | null;
        model?: string | null;
        thinking?: AgentThinkingLevel | null;
        enabled?: boolean;
        timezone?: string;
        startAt?: string | null;
        endAt?: string | null;
        maxRuns?: number | null;
        misfirePolicy?: 'run_once' | 'skip';
      };
      if (!agentOr404(ctx, body.wakerId, reply)) return;
      if (rejectDeletingAgent(reply, body.wakerId)) return;
      try {
        const selection = validateAutomationSelection(ctx, body.wakerId, body);
        return reply.code(201).send(
          automationDto(
            ctx.workspaceData.createAutomation({
              ...body,
              ...selection,
              prompt: cleanAutomationPrompt(body.prompt),
              startAt: optionalTimestamp(body.startAt),
              endAt: optionalTimestamp(body.endAt),
            }),
          ),
        );
      } catch (error) {
        return badRequest(reply, error);
      }
    },
  );

  app.patch(
    '/automations/:automationId',
    {
      schema: {
        params: Type.Object({ automationId: id }),
        body: Type.Object({
          wakerId: id,
          name: Type.Optional(Type.String({ minLength: 1, maxLength: 160 })),
          schedule: Type.Optional(Type.String({ maxLength: 240 })),
          prompt: Type.Optional(Type.String({ minLength: 1, maxLength: 20_000 })),
          enabled: Type.Optional(Type.Boolean()),
          projectId: Type.Optional(nullableId),
          model: Type.Optional(nullableText),
          thinking: Type.Optional(nullableThinking),
          timezone: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
          startAt: Type.Optional(nullableTimestamp),
          endAt: Type.Optional(nullableTimestamp),
          maxRuns: Type.Optional(Type.Union([Type.Integer({ minimum: 1 }), Type.Null()])),
          misfirePolicy: Type.Optional(
            Type.Union([Type.Literal('run_once'), Type.Literal('skip')]),
          ),
        }),
      },
    },
    async (request, reply) => {
      const { automationId } = request.params as { automationId: string };
      const { wakerId, ...patch } = request.body as {
        wakerId: string;
        name?: string;
        schedule?: string;
        prompt?: string;
        enabled?: boolean;
        projectId?: string | null;
        model?: string | null;
        thinking?: AgentThinkingLevel | null;
        timezone?: string;
        startAt?: string | null;
        endAt?: string | null;
        maxRuns?: number | null;
        misfirePolicy?: 'run_once' | 'skip';
      };
      if (!agentOr404(ctx, wakerId, reply)) return;
      if (rejectDeletingAgent(reply, wakerId)) return;
      const current = ctx.workspaceData.getAutomation(wakerId, automationId);
      if (!current) return reply.code(404).send({ error: '自动任务不存在' });
      try {
        const selection = validateAutomationSelection(ctx, wakerId, {
          projectId: patch.projectId === undefined ? current.projectId : patch.projectId,
          model: patch.model === undefined ? current.model : patch.model,
          thinking: patch.thinking === undefined ? current.thinking : patch.thinking,
        });
        const { prompt, startAt, endAt, ...storedPatch } = patch;
        const updated = ctx.workspaceData.updateAutomation(wakerId, automationId, {
          ...storedPatch,
          ...selection,
          ...(prompt === undefined ? {} : { prompt: cleanAutomationPrompt(prompt) }),
          ...(startAt === undefined ? {} : { startAt: optionalTimestamp(startAt) }),
          ...(endAt === undefined ? {} : { endAt: optionalTimestamp(endAt) }),
        });
        return updated ? automationDto(updated) : reply.code(404).send({ error: '自动任务不存在' });
      } catch (error) {
        return badRequest(reply, error);
      }
    },
  );

  app.get(
    '/automations/:automationId/delete-impact',
    {
      schema: {
        params: Type.Object({ automationId: id }),
        querystring: Type.Object({ wakerId: id }),
      },
    },
    async (request, reply) => {
      const { automationId } = request.params as { automationId: string };
      const { wakerId } = request.query as { wakerId: string };
      const impact = ctx.workspaceData.getAutomationDeleteImpact(wakerId, automationId);
      return impact ?? reply.code(404).send({ error: '自动任务不存在' });
    },
  );

  app.delete(
    '/automations/:automationId',
    {
      schema: {
        params: Type.Object({ automationId: id }),
        querystring: Type.Object({ wakerId: id }),
      },
    },
    async (request, reply) => {
      const { automationId } = request.params as { automationId: string };
      const { wakerId } = request.query as { wakerId: string };
      try {
        return ctx.workspaceData.deleteAutomation(wakerId, automationId)
          ? reply.code(204).send()
          : reply.code(404).send({ error: '自动任务不存在' });
      } catch (error) {
        return reply
          .code(409)
          .send({ error: error instanceof Error ? error.message : '自动任务暂时无法删除' });
      }
    },
  );

  app.post(
    '/automations/:automationId/run',
    { schema: { params: Type.Object({ automationId: id }), body: wakerBody } },
    async (request, reply) => {
      const { automationId } = request.params as { automationId: string };
      const { wakerId } = request.body as { wakerId: string };
      if (!agentOr404(ctx, wakerId, reply)) return;
      if (rejectDeletingAgent(reply, wakerId)) return;
      if (!ctx.config.CODEX_AGENT_ENABLED)
        return reply.code(503).send({ error: 'Codex 模型未启用，无法运行自动任务' });
      try {
        const automation = ctx.workspaceData.getAutomation(wakerId, automationId);
        if (!automation) return reply.code(404).send({ error: '自动任务不存在' });
        validateAutomationSelection(ctx, wakerId, automation);
        const run = ctx.workspaceData.enqueueAutomationRun(wakerId, automationId, {
          trigger: 'manual',
        });
        ctx.automationExecutor.enqueue(wakerId, run.id);
        return reply.code(202).send(automationRunDto(run));
      } catch (error) {
        return badRequest(reply, error);
      }
    },
  );

  app.post(
    '/automations/:automationId/pause',
    { schema: { params: Type.Object({ automationId: id }), body: wakerBody } },
    async (request, reply) => {
      const { automationId } = request.params as { automationId: string };
      const { wakerId } = request.body as { wakerId: string };
      if (!agentOr404(ctx, wakerId, reply)) return;
      if (rejectDeletingAgent(reply, wakerId)) return;
      const updated = ctx.workspaceData.pauseAutomation(wakerId, automationId);
      return updated ? automationDto(updated) : reply.code(404).send({ error: '自动任务不存在' });
    },
  );

  app.post(
    '/automations/:automationId/resume',
    { schema: { params: Type.Object({ automationId: id }), body: wakerBody } },
    async (request, reply) => {
      const { automationId } = request.params as { automationId: string };
      const { wakerId } = request.body as { wakerId: string };
      if (!agentOr404(ctx, wakerId, reply)) return;
      if (rejectDeletingAgent(reply, wakerId)) return;
      try {
        const updated = ctx.workspaceData.resumeAutomation(wakerId, automationId);
        return updated ? automationDto(updated) : reply.code(404).send({ error: '自动任务不存在' });
      } catch (error) {
        return badRequest(reply, error);
      }
    },
  );

  app.get(
    '/automation-runs',
    {
      schema: {
        querystring: Type.Object({
          wakerId: id,
          automationId: Type.Optional(id),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
          offset: Type.Optional(Type.Integer({ minimum: 0 })),
        }),
      },
    },
    async (request) => {
      const query = request.query as {
        wakerId: string;
        automationId?: string;
        limit?: number;
        offset?: number;
      };
      const items = ctx.workspaceData
        .listAutomationRuns(query.wakerId, query.automationId, {
          limit: query.limit,
          offset: query.offset,
        })
        .map(automationRunDto);
      return {
        items,
        total: ctx.workspaceData.countAutomationRuns(query.wakerId, query.automationId),
      };
    },
  );

  app.post(
    '/automation-runs/:runId/cancel',
    { schema: { params: Type.Object({ runId: id }), body: wakerBody } },
    async (request, reply) => {
      const { runId } = request.params as { runId: string };
      const { wakerId } = request.body as { wakerId: string };
      try {
        return automationRunDto(await ctx.automationExecutor.cancel(wakerId, runId));
      } catch (error) {
        return badRequest(reply, error);
      }
    },
  );

  app.post(
    '/automation-runs/:runId/retry',
    { schema: { params: Type.Object({ runId: id }), body: wakerBody } },
    async (request, reply) => {
      const { runId } = request.params as { runId: string };
      const { wakerId } = request.body as { wakerId: string };
      if (!agentOr404(ctx, wakerId, reply)) return;
      if (rejectDeletingAgent(reply, wakerId)) return;
      if (!ctx.config.CODEX_AGENT_ENABLED)
        return reply.code(503).send({ error: 'Codex 模型未启用，无法重试自动任务' });
      try {
        const source = ctx.workspaceData.getAutomationRun(wakerId, runId);
        if (!source) return reply.code(404).send({ error: '自动任务运行不存在' });
        validateAutomationSelection(ctx, wakerId, source);
        const retry = ctx.workspaceData.retryAutomationRun(wakerId, runId);
        ctx.automationExecutor.enqueue(wakerId, retry.id);
        return reply.code(202).send(automationRunDto(retry));
      } catch (error) {
        return badRequest(reply, error);
      }
    },
  );

  app.post(
    '/channels',
    {
      schema: {
        body: Type.Object({
          provider: Type.String({ minLength: 1, maxLength: 80 }),
          name: Type.String({ minLength: 1, maxLength: 160 }),
          status: Type.Optional(
            Type.Union([
              Type.Literal('disconnected'),
              Type.Literal('connected'),
              Type.Literal('error'),
            ]),
          ),
          config: Type.Optional(
            Type.Record(Type.String(), Type.Union([Type.String(), Type.Number(), Type.Boolean()])),
          ),
        }),
      },
    },
    async (request, reply) => {
      const body = request.body as {
        provider: string;
        name: string;
        status?: 'disconnected' | 'connected' | 'error';
        config?: Record<string, string | number | boolean>;
      };
      try {
        return reply.code(201).send(
          channelDto(
            ctx.workspaceData.createChannel({
              provider: body.provider,
              name: body.name,
              status: body.status ?? 'disconnected',
              configMetadata: body.config,
            }),
          ),
        );
      } catch (error) {
        return badRequest(reply, error);
      }
    },
  );

  app.patch(
    '/channels/:channelId',
    {
      schema: {
        params: Type.Object({ channelId: id }),
        body: Type.Partial(
          Type.Object({
            name: Type.String({ minLength: 1, maxLength: 160 }),
            status: Type.Union([
              Type.Literal('disconnected'),
              Type.Literal('connected'),
              Type.Literal('error'),
            ]),
            config: Type.Record(
              Type.String(),
              Type.Union([Type.String(), Type.Number(), Type.Boolean()]),
            ),
          }),
        ),
      },
    },
    async (request, reply) => {
      const { channelId } = request.params as { channelId: string };
      const body = request.body as {
        name?: string;
        status?: 'disconnected' | 'connected' | 'error';
        config?: Record<string, string | number | boolean>;
      };
      const updated = ctx.workspaceData.updateChannel(channelId, {
        ...body,
        ...(body.config ? { configMetadata: body.config } : {}),
      });
      return updated ? channelDto(updated) : reply.code(404).send({ error: 'Channel 不存在' });
    },
  );

  app.delete(
    '/channels/:channelId',
    { schema: { params: Type.Object({ channelId: id }) } },
    async (request, reply) => {
      const { channelId } = request.params as { channelId: string };
      return ctx.workspaceData.deleteChannel(channelId)
        ? reply.code(204).send()
        : reply.code(404).send({ error: 'Channel 不存在' });
    },
  );
}
