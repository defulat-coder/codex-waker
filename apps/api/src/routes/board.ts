import type { FastifyInstance, FastifyReply } from 'fastify';
import { Type } from '@sinclair/typebox';
import type {
  BoardHumanActionListResponse,
  BoardTaskDeleteImpactRecord,
  BoardTaskDetailResponse,
  BoardTaskEventRecord,
  BoardTaskListResponse,
  HumanActionRecord,
  WakerTask,
} from '@waker/contracts';
import {
  HumanActionConflictError,
  TaskConflictError,
  type HumanAction,
  type Task,
  type TaskEvent,
  type TaskListFilter,
} from '@waker/workspace-data';
import type { AppContext } from '../context.js';
import { agentOr404, rejectDeletingAgent } from '../context.js';

const id = Type.String({ minLength: 1, maxLength: 200 });
const taskStatus = Type.Union([
  Type.Literal('queued'),
  Type.Literal('waiting'),
  Type.Literal('running'),
  Type.Literal('completed'),
  Type.Literal('failed'),
  Type.Literal('cancelled'),
]);
const taskPriority = Type.Union([
  Type.Literal('low'),
  Type.Literal('normal'),
  Type.Literal('high'),
  Type.Literal('urgent'),
]);
const taskSort = Type.Union([
  Type.Literal('updated_desc'),
  Type.Literal('updated_asc'),
  Type.Literal('priority_desc'),
  Type.Literal('title_asc'),
]);
const nullableId = Type.Union([id, Type.Null()]);

function iso(value: number | null): string | undefined {
  return value === null ? undefined : new Date(value).toISOString();
}

function sourceLinks(ctx: AppContext, task: Task) {
  const automationRun =
    task.sourceType === 'automation' && task.runId
      ? ctx.workspaceData.getAutomationRun(task.wakerId, task.runId)
      : undefined;
  const workflowRun =
    task.sourceType === 'workflow' && task.runId
      ? ctx.workspaceData.getWorkflowRun(task.wakerId, task.runId)
      : undefined;
  return {
    type: task.sourceType,
    id: task.sourceId,
    ...(task.runId ? { runId: task.runId } : {}),
    ...(task.sessionId ? { sessionId: task.sessionId } : {}),
    ...(automationRun ? { automationId: automationRun.automationId } : {}),
    ...(workflowRun ? { workflowId: workflowRun.workflowId } : {}),
  };
}

function taskDto(
  ctx: AppContext,
  value: Task,
): WakerTask & {
  projectName?: string;
  automationId?: string;
  workflowId?: string;
} {
  const project = value.projectId
    ? ctx.workspaceData.getOwnedProject(value.wakerId, value.projectId)
    : undefined;
  const links = sourceLinks(ctx, value);
  return {
    id: value.id,
    wakerId: value.wakerId,
    title: value.title,
    description: value.description,
    type: value.type,
    origin: value.origin,
    status: value.status,
    sourceType: value.sourceType,
    sourceId: value.sourceId,
    source: value.source,
    ...(value.projectId ? { projectId: value.projectId } : {}),
    ...(project ? { projectName: project.name } : {}),
    ...('automationId' in links ? { automationId: links.automationId } : {}),
    ...('workflowId' in links ? { workflowId: links.workflowId } : {}),
    ...(value.runId ? { runId: value.runId } : {}),
    ...(value.sessionId ? { sessionId: value.sessionId } : {}),
    ...(value.parentTaskId ? { parentTaskId: value.parentTaskId } : {}),
    ...(value.result === null ? {} : { result: value.result }),
    ...(value.error === null ? {} : { error: value.error }),
    priority: value.priority,
    position: value.position,
    version: value.version,
    managed: value.origin === 'derived',
    lastActiveAt: new Date(value.lastActiveAt).toISOString(),
    createdAt: new Date(value.createdAt).toISOString(),
    updatedAt: new Date(value.updatedAt).toISOString(),
    ...(iso(value.startedAt) ? { startedAt: iso(value.startedAt) } : {}),
    ...(iso(value.completedAt) ? { completedAt: iso(value.completedAt) } : {}),
  };
}

function eventDto(value: TaskEvent): BoardTaskEventRecord & { label: string } {
  return {
    id: value.id,
    taskId: value.taskId,
    sequence: value.sequence,
    type: value.type,
    label: value.type,
    ...(value.status ? { status: value.status } : {}),
    ...(value.payload === undefined ? {} : { payload: value.payload }),
    createdAt: new Date(value.createdAt).toISOString(),
  };
}

function actionDto(
  ctx: AppContext,
  value: HumanAction,
): HumanActionRecord & { category: HumanAction['kind'] } {
  const task = value.taskId ? ctx.workspaceData.getTask(value.wakerId, value.taskId) : undefined;
  return {
    id: value.id,
    wakerId: value.wakerId,
    source: value.source,
    sourceId: value.sourceId,
    ...(value.taskId ? { taskId: value.taskId } : {}),
    ...(task?.sessionId
      ? { sessionId: task.sessionId }
      : value.source === 'codex'
        ? { sessionId: value.sourceId }
        : {}),
    kind: value.kind,
    category: value.kind,
    title: value.title,
    prompt: value.prompt,
    status: value.status,
    ...(value.result === undefined ? {} : { result: value.result }),
    version: value.version,
    createdAt: new Date(value.createdAt).toISOString(),
    updatedAt: new Date(value.updatedAt).toISOString(),
    ...(iso(value.resolvedAt) ? { resolvedAt: iso(value.resolvedAt) } : {}),
  };
}

function ownedTask(ctx: AppContext, reply: FastifyReply, wakerId: string, taskId: string) {
  const value = ctx.workspaceData.getTask(wakerId, taskId);
  if (!value) reply.code(404).send({ error: '任务不存在' });
  return value;
}

function ownedAction(ctx: AppContext, reply: FastifyReply, wakerId: string, actionId: string) {
  const value = ctx.workspaceData.getHumanAction(wakerId, actionId);
  if (!value) reply.code(404).send({ error: 'Human Action 不存在' });
  return value;
}

function sendMutationError(reply: FastifyReply, error: unknown): void {
  const message = error instanceof Error ? error.message : '请求无法处理';
  if (
    error instanceof TaskConflictError ||
    error instanceof HumanActionConflictError ||
    /Derived Tasks|version conflict|already handled|not asking for input/i.test(message)
  ) {
    reply.code(409).send({ error: message });
    return;
  }
  reply.code(400).send({ error: message });
}

function csv(value: string | undefined): string[] {
  return value
    ? value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
    : [];
}

export function registerBoardRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get(
    '/board/tasks',
    {
      schema: {
        querystring: Type.Object(
          {
            wakerId: id,
            query: Type.Optional(Type.String({ maxLength: 500 })),
            status: Type.Optional(Type.String({ maxLength: 200 })),
            type: Type.Optional(Type.String({ maxLength: 200 })),
            sourceType: Type.Optional(Type.String({ maxLength: 200 })),
            projectId: Type.Optional(id),
            priority: Type.Optional(taskPriority),
            sort: Type.Optional(taskSort),
            limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
            offset: Type.Optional(Type.Integer({ minimum: 0 })),
          },
          { additionalProperties: false },
        ),
      },
    },
    async (request, reply) => {
      const query = request.query as {
        wakerId: string;
        query?: string;
        status?: string;
        type?: string;
        sourceType?: string;
        projectId?: string;
        priority?: Task['priority'];
        sort?: TaskListFilter['sort'];
        limit?: number;
        offset?: number;
      };
      if (!agentOr404(ctx, query.wakerId, reply)) return;
      try {
        const page = ctx.workspaceData.queryTasks(query.wakerId, {
          query: query.query,
          statuses: csv(query.status) as Task['status'][],
          types: csv(query.type) as Task['type'][],
          sourceTypes: csv(query.sourceType) as Task['sourceType'][],
          ...(query.projectId ? { projectId: query.projectId } : {}),
          ...(query.priority ? { priority: query.priority } : {}),
          ...(query.sort ? { sort: query.sort } : {}),
          limit: query.limit,
          offset: query.offset,
        });
        const response: BoardTaskListResponse & {
          projects: Array<{ id: string; name: string }>;
        } = {
          items: page.items.map((item) => taskDto(ctx, item)),
          total: page.total,
          limit: query.limit ?? 50,
          offset: query.offset ?? 0,
          projects: ctx.workspaceData
            .listProjects(query.wakerId)
            .map((project) => ({ id: project.id, name: project.name })),
        };
        return response;
      } catch (error) {
        return sendMutationError(reply, error);
      }
    },
  );

  app.get(
    '/board/tasks/:taskId',
    {
      schema: {
        params: Type.Object({ taskId: id }),
        querystring: Type.Object(
          {
            wakerId: id,
            eventLimit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
          },
          { additionalProperties: false },
        ),
      },
    },
    async (request, reply) => {
      const { taskId } = request.params as { taskId: string };
      const { wakerId, eventLimit = 200 } = request.query as {
        wakerId: string;
        eventLimit?: number;
      };
      if (!agentOr404(ctx, wakerId, reply)) return;
      const detail = ctx.workspaceData.getTaskDetail(wakerId, taskId, eventLimit);
      if (!detail) return reply.code(404).send({ error: '任务不存在' });
      const response: BoardTaskDetailResponse & { source: ReturnType<typeof sourceLinks> } = {
        task: taskDto(ctx, detail.task),
        events: detail.events.map(eventDto),
        children: detail.children.map((item) => taskDto(ctx, item)),
        humanActions: detail.humanActions.map((item) => actionDto(ctx, item)),
        source: sourceLinks(ctx, detail.task),
      };
      return response;
    },
  );

  app.post(
    '/board/tasks',
    {
      schema: {
        body: Type.Object(
          {
            wakerId: id,
            title: Type.String({ minLength: 1, maxLength: 240 }),
            description: Type.Optional(Type.String({ maxLength: 10_000 })),
            status: Type.Optional(taskStatus),
            projectId: Type.Optional(nullableId),
            priority: Type.Optional(taskPriority),
            position: Type.Optional(Type.Integer({ minimum: 0 })),
            parentTaskId: Type.Optional(nullableId),
            result: Type.Optional(Type.Union([Type.String({ maxLength: 100_000 }), Type.Null()])),
            error: Type.Optional(Type.Union([Type.String({ maxLength: 10_000 }), Type.Null()])),
          },
          { additionalProperties: false },
        ),
      },
    },
    async (request, reply) => {
      const body = request.body as {
        wakerId: string;
        title: string;
        description?: string;
        status?: Task['status'];
        projectId?: string | null;
        priority?: Task['priority'];
        position?: number;
        parentTaskId?: string | null;
        result?: string | null;
        error?: string | null;
      };
      if (!agentOr404(ctx, body.wakerId, reply)) return;
      if (rejectDeletingAgent(reply, body.wakerId)) return;
      try {
        const terminal = body.status && ['completed', 'failed', 'cancelled'].includes(body.status);
        return reply.code(201).send(
          taskDto(
            ctx,
            ctx.workspaceData.createTask({
              ...body,
              type: 'manual',
              ...(body.status === 'running' ? { startedAt: Date.now() } : {}),
              ...(terminal ? { completedAt: Date.now() } : {}),
            }),
          ),
        );
      } catch (error) {
        return sendMutationError(reply, error);
      }
    },
  );

  app.patch(
    '/board/tasks/:taskId',
    {
      schema: {
        params: Type.Object({ taskId: id }),
        body: Type.Object(
          {
            wakerId: id,
            expectedVersion: Type.Integer({ minimum: 1 }),
            title: Type.Optional(Type.String({ minLength: 1, maxLength: 240 })),
            description: Type.Optional(Type.String({ maxLength: 10_000 })),
            status: Type.Optional(taskStatus),
            projectId: Type.Optional(nullableId),
            priority: Type.Optional(taskPriority),
            position: Type.Optional(Type.Integer({ minimum: 0 })),
            parentTaskId: Type.Optional(nullableId),
            result: Type.Optional(Type.Union([Type.String({ maxLength: 100_000 }), Type.Null()])),
            error: Type.Optional(Type.Union([Type.String({ maxLength: 10_000 }), Type.Null()])),
          },
          { additionalProperties: false },
        ),
      },
    },
    async (request, reply) => {
      const { taskId } = request.params as { taskId: string };
      const body = request.body as { wakerId: string; expectedVersion: number } & Record<
        string,
        unknown
      >;
      if (!agentOr404(ctx, body.wakerId, reply)) return;
      if (!ownedTask(ctx, reply, body.wakerId, taskId)) return;
      if (rejectDeletingAgent(reply, body.wakerId)) return;
      try {
        const { wakerId: _wakerId, ...patch } = body;
        return taskDto(ctx, ctx.workspaceData.updateTask(body.wakerId, taskId, patch as never)!);
      } catch (error) {
        return sendMutationError(reply, error);
      }
    },
  );

  app.get(
    '/board/tasks/:taskId/delete-impact',
    {
      schema: {
        params: Type.Object({ taskId: id }),
        querystring: Type.Object({ wakerId: id }, { additionalProperties: false }),
      },
    },
    async (request, reply) => {
      const { taskId } = request.params as { taskId: string };
      const { wakerId } = request.query as { wakerId: string };
      if (!agentOr404(ctx, wakerId, reply)) return;
      const task = ownedTask(ctx, reply, wakerId, taskId);
      if (!task) return;
      if (task.origin !== 'manual')
        return reply.code(409).send({ error: '派生任务由宿主运行管理，不能删除' });
      const impact = ctx.workspaceData.getTaskDeleteImpact(wakerId, taskId)!;
      const response: BoardTaskDeleteImpactRecord & {
        linkedRuns: number;
        linkedSessions: number;
      } = { ...impact, linkedRuns: 0, linkedSessions: 0 };
      return response;
    },
  );

  app.delete(
    '/board/tasks/:taskId',
    {
      schema: {
        params: Type.Object({ taskId: id }),
        querystring: Type.Object(
          { wakerId: id, expectedVersion: Type.Integer({ minimum: 1 }) },
          { additionalProperties: false },
        ),
      },
    },
    async (request, reply) => {
      const { taskId } = request.params as { taskId: string };
      const { wakerId, expectedVersion } = request.query as {
        wakerId: string;
        expectedVersion: number;
      };
      if (!agentOr404(ctx, wakerId, reply)) return;
      if (!ownedTask(ctx, reply, wakerId, taskId)) return;
      if (rejectDeletingAgent(reply, wakerId)) return;
      try {
        return ctx.workspaceData.deleteTask(wakerId, taskId, expectedVersion)
          ? reply.code(204).send()
          : reply.code(404).send({ error: '任务不存在' });
      } catch (error) {
        return sendMutationError(reply, error);
      }
    },
  );

  app.get(
    '/board/human-actions',
    {
      schema: {
        querystring: Type.Object(
          {
            wakerId: id,
            status: Type.Optional(
              Type.Union([
                Type.Literal('pending'),
                Type.Literal('handled'),
                Type.Literal('ignored'),
              ]),
            ),
            source: Type.Optional(Type.Union([Type.Literal('workflow'), Type.Literal('codex')])),
            taskId: Type.Optional(id),
            limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
            offset: Type.Optional(Type.Integer({ minimum: 0 })),
          },
          { additionalProperties: false },
        ),
      },
    },
    async (request, reply) => {
      const query = request.query as {
        wakerId: string;
        status?: HumanAction['status'];
        source?: HumanAction['source'];
        taskId?: string;
        limit?: number;
        offset?: number;
      };
      if (!agentOr404(ctx, query.wakerId, reply)) return;
      try {
        const page = ctx.workspaceData.queryHumanActions(query.wakerId, query);
        const response: BoardHumanActionListResponse = {
          items: page.items.map((item) => actionDto(ctx, item)),
          total: page.total,
          limit: query.limit ?? 50,
          offset: query.offset ?? 0,
        };
        return response;
      } catch (error) {
        return sendMutationError(reply, error);
      }
    },
  );

  app.post(
    '/board/human-actions/:actionId/resolve',
    {
      schema: {
        params: Type.Object({ actionId: id }),
        body: Type.Object(
          { wakerId: id, expectedVersion: Type.Integer({ minimum: 1 }), result: Type.Unknown() },
          { additionalProperties: false },
        ),
      },
    },
    async (request, reply) => {
      const { actionId } = request.params as { actionId: string };
      const body = request.body as { wakerId: string; expectedVersion: number; result: unknown };
      if (!agentOr404(ctx, body.wakerId, reply)) return;
      const action = ownedAction(ctx, reply, body.wakerId, actionId);
      if (!action) return;
      if (rejectDeletingAgent(reply, body.wakerId)) return;
      try {
        if (action.source === 'workflow') {
          await ctx.workflowExecutor.resume(
            body.wakerId,
            action.sourceId,
            body.result,
            body.expectedVersion,
          );
          return actionDto(ctx, ctx.workspaceData.getHumanAction(body.wakerId, actionId)!);
        }
        return actionDto(
          ctx,
          ctx.workspaceData.resolveHumanAction(
            body.wakerId,
            actionId,
            body.expectedVersion,
            body.result,
          ),
        );
      } catch (error) {
        return sendMutationError(reply, error);
      }
    },
  );

  app.post(
    '/board/human-actions/:actionId/ignore',
    {
      schema: {
        params: Type.Object({ actionId: id }),
        body: Type.Object(
          { wakerId: id, expectedVersion: Type.Integer({ minimum: 1 }) },
          { additionalProperties: false },
        ),
      },
    },
    async (request, reply) => {
      const { actionId } = request.params as { actionId: string };
      const body = request.body as { wakerId: string; expectedVersion: number };
      if (!agentOr404(ctx, body.wakerId, reply)) return;
      const action = ownedAction(ctx, reply, body.wakerId, actionId);
      if (!action) return;
      if (rejectDeletingAgent(reply, body.wakerId)) return;
      try {
        if (action.source === 'workflow') {
          await ctx.workflowExecutor.cancel(body.wakerId, action.sourceId, body.expectedVersion);
          return actionDto(ctx, ctx.workspaceData.getHumanAction(body.wakerId, actionId)!);
        }
        return actionDto(
          ctx,
          ctx.workspaceData.ignoreHumanAction(body.wakerId, actionId, body.expectedVersion),
        );
      } catch (error) {
        return sendMutationError(reply, error);
      }
    },
  );
}
