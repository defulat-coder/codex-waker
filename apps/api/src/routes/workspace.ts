import type { FastifyInstance, FastifyReply } from 'fastify';
import { Type } from '@sinclair/typebox';
import type {
  LocalResourcesResponse,
  ProjectDeleteImpact,
  WakerAutomation,
  WakerChannel,
  WakerProject,
  WakerTask,
  WakerWorkflow,
} from '@waker/contracts';
import type {
  Automation,
  AutomationRun,
  Channel,
  Project,
  Task,
  Workflow,
  WorkflowRun,
  WorkflowRunEvent,
} from '@waker/workspace-data';
import type { AppContext } from '../context.js';
import { resolveProjectDirectory } from '../project-path.js';

const id = Type.String({ minLength: 1, maxLength: 160 });
const wakerBody = Type.Object({ wakerId: id });
const iso = (value: number | null): string | undefined =>
  value === null ? undefined : new Date(value).toISOString();

function projectDto(value: Project): WakerProject {
  return {
    id: value.id,
    ...(value.visibility === 'private' ? { wakerId: value.wakerId } : {}),
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
    enabled: value.enabled,
    ...(iso(value.lastRun) ? { lastRunAt: iso(value.lastRun) } : {}),
    ...(iso(value.nextRun) ? { nextRunAt: iso(value.nextRun) } : {}),
    createdAt: new Date(value.createdAt).toISOString(),
    updatedAt: new Date(value.updatedAt).toISOString(),
  };
}

function automationRunDto(value: AutomationRun) {
  return {
    id: value.id,
    automationId: value.automationId,
    taskId: value.taskId,
    wakerId: value.wakerId,
    status: value.status,
    ...(value.input === undefined ? {} : { input: value.input }),
    ...(value.output === undefined ? {} : { output: value.output }),
    ...(value.error ? { error: value.error } : {}),
    createdAt: new Date(value.createdAt).toISOString(),
    updatedAt: new Date(value.updatedAt).toISOString(),
    ...(iso(value.startedAt) ? { startedAt: iso(value.startedAt) } : {}),
    ...(iso(value.completedAt) ? { completedAt: iso(value.completedAt) } : {}),
  };
}

function workflowDto(value: Workflow): WakerWorkflow {
  return {
    id: value.id,
    name: value.name,
    ...(value.description ? { description: value.description } : {}),
    script: value.script,
    status: value.status === 'error' ? 'error' : value.status === 'draft' ? 'draft' : 'ready',
    createdAt: new Date(value.createdAt).toISOString(),
    updatedAt: new Date(value.updatedAt).toISOString(),
  };
}

function workflowRunDto(value: WorkflowRun) {
  return {
    id: value.id,
    workflowId: value.workflowId,
    workflowVersion: value.workflowVersion,
    nameSnapshot: value.nameSnapshot,
    descriptionSnapshot: value.descriptionSnapshot,
    scriptSnapshot: value.scriptSnapshot,
    status: value.status,
    ...(value.input === undefined ? {} : { input: value.input }),
    ...(value.output === undefined ? {} : { output: value.output }),
    ...(value.error ? { error: value.error } : {}),
    createdAt: new Date(value.createdAt).toISOString(),
    updatedAt: new Date(value.updatedAt).toISOString(),
    ...(iso(value.startedAt) ? { startedAt: iso(value.startedAt) } : {}),
    ...(iso(value.completedAt) ? { completedAt: iso(value.completedAt) } : {}),
  };
}

function workflowEventDto(value: WorkflowRunEvent) {
  return {
    id: value.id,
    runId: value.runId,
    sequence: value.sequence,
    type: value.type,
    ...(value.payload === undefined ? {} : { payload: value.payload }),
    createdAt: new Date(value.createdAt).toISOString(),
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
    title: value.title,
    type: value.type === 'automation' || value.type === 'workflow' ? value.type : 'conversation',
    status:
      value.status === 'queued'
        ? 'pending'
        : value.status === 'cancelled'
          ? 'failed'
          : value.status,
    wakerId: value.wakerId,
    ...(value.projectId ? { projectId: value.projectId } : {}),
    ...(value.source ? { source: value.source } : {}),
    ...(value.result ? { result: value.result } : {}),
    ...(value.error ? { error: value.error } : {}),
    createdAt: new Date(value.createdAt).toISOString(),
    updatedAt: new Date(value.updatedAt).toISOString(),
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
      workflows: ctx.workspaceData.listWorkflows().map(workflowDto),
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
        behavior: { sessionContexts: 'delete', tasks: 'cascade-delete' },
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
      return ctx.workspaceData.deleteProject(wakerId, projectId)
        ? reply.code(204).send()
        : reply.code(404).send({ error: '项目不存在' });
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
        }),
      },
    },
    async (request, reply) => {
      try {
        return reply
          .code(201)
          .send(automationDto(ctx.workspaceData.createAutomation(request.body as never)));
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
      };
      const updated = ctx.workspaceData.updateAutomation(wakerId, automationId, patch);
      return updated ? automationDto(updated) : reply.code(404).send({ error: '自动任务不存在' });
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
      return ctx.workspaceData.deleteAutomation(wakerId, automationId)
        ? reply.code(204).send()
        : reply.code(404).send({ error: '自动任务不存在' });
    },
  );

  app.post(
    '/automations/:automationId/run',
    { schema: { params: Type.Object({ automationId: id }), body: wakerBody } },
    async (request, reply) => {
      const { automationId } = request.params as { automationId: string };
      const { wakerId } = request.body as { wakerId: string };
      try {
        return reply
          .code(202)
          .send(taskDto(ctx.workspaceData.runAutomation(wakerId, automationId)));
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
      try {
        const updated = ctx.workspaceData.resumeAutomation(wakerId, automationId);
        return updated ? automationDto(updated) : reply.code(404).send({ error: '自动任务不存在' });
      } catch (error) {
        return badRequest(reply, error);
      }
    },
  );

  app.get('/automation-runs', async (request, reply) => {
    const query = request.query as { wakerId?: string; automationId?: string };
    if (!query.wakerId) return reply.code(400).send({ error: 'wakerId 必填' });
    const items = ctx.workspaceData
      .listAutomationRuns(query.wakerId, query.automationId)
      .map(automationRunDto);
    return { items, total: items.length };
  });

  for (const action of ['start', 'complete', 'cancel'] as const) {
    app.post(
      `/automation-runs/:runId/${action}`,
      {
        schema: {
          params: Type.Object({ runId: id }),
          body: Type.Object({ wakerId: id, output: Type.Optional(Type.Unknown()) }),
        },
      },
      async (request, reply) => {
        const { runId } = request.params as { runId: string };
        const body = request.body as { wakerId: string; output?: unknown };
        try {
          const run =
            action === 'start'
              ? ctx.workspaceData.startAutomationRun(body.wakerId, runId)
              : action === 'complete'
                ? ctx.workspaceData.completeAutomationRun(body.wakerId, runId, body.output)
                : ctx.workspaceData.cancelAutomationRun(body.wakerId, runId);
          return automationRunDto(run);
        } catch (error) {
          return badRequest(reply, error);
        }
      },
    );
  }

  app.post(
    '/automation-runs/:runId/fail',
    {
      schema: {
        params: Type.Object({ runId: id }),
        body: Type.Object({ wakerId: id, error: Type.String({ minLength: 1, maxLength: 10_000 }) }),
      },
    },
    async (request, reply) => {
      const { runId } = request.params as { runId: string };
      const body = request.body as { wakerId: string; error: string };
      try {
        return automationRunDto(
          ctx.workspaceData.failAutomationRun(body.wakerId, runId, body.error),
        );
      } catch (error) {
        return badRequest(reply, error);
      }
    },
  );

  app.post(
    '/workflows',
    {
      schema: {
        body: Type.Object({
          name: Type.String({ minLength: 1, maxLength: 160 }),
          description: Type.Optional(Type.String({ maxLength: 2000 })),
          script: Type.String({ maxLength: 100_000 }),
          status: Type.Optional(
            Type.Union([
              Type.Literal('draft'),
              Type.Literal('active'),
              Type.Literal('paused'),
              Type.Literal('error'),
            ]),
          ),
        }),
      },
    },
    async (request, reply) => {
      const body = request.body as {
        name: string;
        description?: string;
        script: string;
        status?: 'draft' | 'active' | 'paused' | 'error';
      };
      try {
        return reply.code(201).send(
          workflowDto(
            ctx.workspaceData.createWorkflow({
              ...body,
              description: body.description ?? '',
              status: body.status ?? 'draft',
            }),
          ),
        );
      } catch (error) {
        return badRequest(reply, error);
      }
    },
  );

  app.patch(
    '/workflows/:workflowId',
    {
      schema: {
        params: Type.Object({ workflowId: id }),
        body: Type.Partial(
          Type.Object({
            name: Type.String({ minLength: 1, maxLength: 160 }),
            description: Type.String({ maxLength: 2000 }),
            script: Type.String({ maxLength: 100_000 }),
            status: Type.Union([
              Type.Literal('draft'),
              Type.Literal('active'),
              Type.Literal('paused'),
              Type.Literal('error'),
            ]),
          }),
        ),
      },
    },
    async (request, reply) => {
      const { workflowId } = request.params as { workflowId: string };
      const updated = ctx.workspaceData.updateWorkflow(workflowId, request.body as never);
      return updated ? workflowDto(updated) : reply.code(404).send({ error: 'WakerFlow 不存在' });
    },
  );

  app.delete(
    '/workflows/:workflowId',
    { schema: { params: Type.Object({ workflowId: id }) } },
    async (request, reply) => {
      const { workflowId } = request.params as { workflowId: string };
      return ctx.workspaceData.deleteWorkflow(workflowId)
        ? reply.code(204).send()
        : reply.code(404).send({ error: 'WakerFlow 不存在' });
    },
  );

  app.post(
    '/workflows/:workflowId/run',
    {
      schema: {
        params: Type.Object({ workflowId: id }),
        body: Type.Optional(Type.Object({ input: Type.Optional(Type.Unknown()) })),
      },
    },
    async (request, reply) => {
      const { workflowId } = request.params as { workflowId: string };
      try {
        return reply
          .code(202)
          .send(
            workflowRunDto(
              ctx.workspaceData.runWorkflow(
                workflowId,
                (request.body as { input?: unknown } | undefined)?.input,
              ),
            ),
          );
      } catch (error) {
        return badRequest(reply, error);
      }
    },
  );

  app.get('/workflow-runs', async (request) => {
    const { workflowId } = request.query as { workflowId?: string };
    const items = ctx.workspaceData.listWorkflowRuns(workflowId).map(workflowRunDto);
    return { items, total: items.length };
  });

  app.get(
    '/workflow-runs/:runId/trace',
    { schema: { params: Type.Object({ runId: id }) } },
    async (request, reply) => {
      const { runId } = request.params as { runId: string };
      try {
        const trace = ctx.workspaceData.getWorkflowRunTrace(runId);
        return { run: workflowRunDto(trace.run), events: trace.events.map(workflowEventDto) };
      } catch {
        return reply.code(404).send({ error: 'Workflow run 不存在' });
      }
    },
  );

  app.post(
    '/workflow-runs/:runId/events',
    {
      schema: {
        params: Type.Object({ runId: id }),
        body: Type.Object({
          type: Type.String({ minLength: 1, maxLength: 120 }),
          payload: Type.Optional(Type.Unknown()),
        }),
      },
    },
    async (request, reply) => {
      const { runId } = request.params as { runId: string };
      const body = request.body as { type: string; payload?: unknown };
      try {
        return reply
          .code(201)
          .send(
            workflowEventDto(
              ctx.workspaceData.appendWorkflowRunEvent(runId, body.type, body.payload),
            ),
          );
      } catch (error) {
        return badRequest(reply, error);
      }
    },
  );

  app.post(
    '/workflow-runs/:runId/wait',
    {
      schema: {
        params: Type.Object({ runId: id }),
        body: Type.Optional(Type.Object({ prompt: Type.Optional(Type.Unknown()) })),
      },
    },
    async (request, reply) => {
      const { runId } = request.params as { runId: string };
      try {
        return workflowRunDto(
          ctx.workspaceData.waitForWorkflowInput(
            runId,
            (request.body as { prompt?: unknown } | undefined)?.prompt,
          ),
        );
      } catch (error) {
        return badRequest(reply, error);
      }
    },
  );

  app.post(
    '/workflow-runs/:runId/resume',
    {
      schema: {
        params: Type.Object({ runId: id }),
        body: Type.Optional(Type.Object({ input: Type.Optional(Type.Unknown()) })),
      },
    },
    async (request, reply) => {
      const { runId } = request.params as { runId: string };
      try {
        return workflowRunDto(
          ctx.workspaceData.resumeWorkflowRun(
            runId,
            (request.body as { input?: unknown } | undefined)?.input,
          ),
        );
      } catch (error) {
        return badRequest(reply, error);
      }
    },
  );

  app.post(
    '/workflow-runs/:runId/start',
    { schema: { params: Type.Object({ runId: id }) } },
    async (request, reply) => {
      const { runId } = request.params as { runId: string };
      try {
        return workflowRunDto(ctx.workspaceData.startWorkflowRun(runId));
      } catch (error) {
        return badRequest(reply, error);
      }
    },
  );

  app.post(
    '/workflow-runs/:runId/complete',
    {
      schema: {
        params: Type.Object({ runId: id }),
        body: Type.Optional(Type.Object({ output: Type.Optional(Type.Unknown()) })),
      },
    },
    async (request, reply) => {
      const { runId } = request.params as { runId: string };
      try {
        return workflowRunDto(
          ctx.workspaceData.completeWorkflowRun(
            runId,
            (request.body as { output?: unknown } | undefined)?.output,
          ),
        );
      } catch (error) {
        return badRequest(reply, error);
      }
    },
  );

  app.post(
    '/workflow-runs/:runId/fail',
    {
      schema: {
        params: Type.Object({ runId: id }),
        body: Type.Object({ error: Type.String({ minLength: 1, maxLength: 10_000 }) }),
      },
    },
    async (request, reply) => {
      const { runId } = request.params as { runId: string };
      try {
        return workflowRunDto(
          ctx.workspaceData.failWorkflowRun(runId, (request.body as { error: string }).error),
        );
      } catch (error) {
        return badRequest(reply, error);
      }
    },
  );

  app.post(
    '/workflow-runs/:runId/cancel',
    { schema: { params: Type.Object({ runId: id }) } },
    async (request, reply) => {
      const { runId } = request.params as { runId: string };
      try {
        return workflowRunDto(ctx.workspaceData.cancelWorkflowRun(runId));
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

  app.post(
    '/tasks',
    {
      schema: {
        body: Type.Object({
          wakerId: id,
          title: Type.String({ minLength: 1, maxLength: 240 }),
          type: Type.Union([
            Type.Literal('conversation'),
            Type.Literal('automation'),
            Type.Literal('workflow'),
          ]),
          projectId: Type.Optional(id),
          source: Type.Optional(Type.String({ maxLength: 240 })),
        }),
      },
    },
    async (request, reply) => {
      const body = request.body as {
        wakerId: string;
        title: string;
        type: 'conversation' | 'automation' | 'workflow';
        projectId?: string;
        source?: string;
      };
      try {
        return reply.code(201).send(
          taskDto(
            ctx.workspaceData.createTask({
              ...body,
              projectId: body.projectId ?? null,
              source: body.source ?? 'manual',
              status: 'queued',
            }),
          ),
        );
      } catch (error) {
        return badRequest(reply, error);
      }
    },
  );

  app.patch(
    '/tasks/:taskId',
    {
      schema: {
        params: Type.Object({ taskId: id }),
        body: Type.Object({
          wakerId: id,
          status: Type.Optional(
            Type.Union([
              Type.Literal('queued'),
              Type.Literal('running'),
              Type.Literal('completed'),
              Type.Literal('failed'),
              Type.Literal('cancelled'),
            ]),
          ),
          result: Type.Optional(Type.String({ maxLength: 100_000 })),
          error: Type.Optional(Type.String({ maxLength: 10_000 })),
        }),
      },
    },
    async (request, reply) => {
      const { taskId } = request.params as { taskId: string };
      const { wakerId, ...patch } = request.body as {
        wakerId: string;
        status?: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
        result?: string;
        error?: string;
      };
      if (patch.status === 'failed' && !patch.error)
        return reply.code(400).send({ error: '失败任务必须包含 error' });
      const now = Date.now();
      try {
        const updated = ctx.workspaceData.updateTask(wakerId, taskId, {
          ...patch,
          ...(patch.status === 'completed' || patch.status === 'failed'
            ? { completedAt: now }
            : {}),
        });
        return updated ? taskDto(updated) : reply.code(404).send({ error: '任务不存在' });
      } catch (error) {
        return badRequest(reply, error);
      }
    },
  );

  app.delete(
    '/tasks/:taskId',
    { schema: { params: Type.Object({ taskId: id }), querystring: Type.Object({ wakerId: id }) } },
    async (request, reply) => {
      const { taskId } = request.params as { taskId: string };
      const { wakerId } = request.query as { wakerId: string };
      return ctx.workspaceData.deleteTask(wakerId, taskId)
        ? reply.code(204).send()
        : reply.code(404).send({ error: '任务不存在' });
    },
  );
}
