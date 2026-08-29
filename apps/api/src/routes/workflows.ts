import type { FastifyInstance, FastifyReply } from 'fastify';
import { Type } from '@sinclair/typebox';
import {
  AGENT_THINKING_LEVELS,
  type ChatUsage,
  type WakerWorkflow,
  type WorkflowDeleteImpactRecord,
  type WorkflowMutationResponse,
  type WorkflowRunListResponse,
  type WorkflowRunEventRecord,
  type WorkflowRunRecord,
  type WorkflowGenerateDefinitionRequest,
  type WorkflowGenerateDefinitionResponse,
  type WorkflowValidationResponse,
  type WorkflowValidationRequest,
  type WorkflowVersionListResponse,
  type WorkflowVersionRecord,
} from '@waker/contracts';
import {
  serializeWorkflowDefinition,
  validateWorkflowDefinition,
  WorkflowConflictError,
  type Workflow,
  type WorkflowDeleteImpact,
  type WorkflowMutationPreview,
  type WorkflowRun,
  type WorkflowRunEvent,
  type WorkflowVersion,
} from '@waker/workspace-data';
import { listCodexModels } from '@waker/codex-runtime';
import type { AppContext } from '../context.js';
import { agentOr404, rejectDeletingAgent } from '../context.js';
import {
  buildWorkflowDefinitionPrompt,
  parseWorkflowDefinitionOutput,
} from '../workflow-generate.js';

const id = Type.String({ minLength: 1, maxLength: 160 });
const wakerQuery = Type.Object({ wakerId: id }, { additionalProperties: false });
const thinking = Type.Union(AGENT_THINKING_LEVELS.map((level) => Type.Literal(level)));
const nullableId = Type.Union([id, Type.Null()]);
const nullableThinking = Type.Union([thinking, Type.Null()]);
const workflowStatus = Type.Union([
  Type.Literal('draft'),
  Type.Literal('active'),
  Type.Literal('paused'),
]);

const iso = (value: number | null): string | undefined =>
  value === null ? undefined : new Date(value).toISOString();

function workflowDto(value: Workflow): WakerWorkflow {
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
    script: value.script,
    ...(value.definition ? { definition: value.definition } : {}),
    createdAt: new Date(value.createdAt).toISOString(),
    updatedAt: new Date(value.updatedAt).toISOString(),
  };
}

function workflowSummaryDto(value: Workflow): Omit<WakerWorkflow, 'script' | 'definition'> {
  const { script: _script, definition: _definition, ...summary } = workflowDto(value);
  return summary;
}

function versionDto(value: WorkflowVersion, includeDefinition = false): WorkflowVersionRecord {
  return {
    workflowId: value.workflowId,
    version: value.version,
    wakerId: value.wakerId,
    ...(value.projectId ? { projectId: value.projectId } : {}),
    ...(value.model ? { model: value.model } : {}),
    ...(value.thinking ? { thinking: value.thinking } : {}),
    name: value.name,
    ...(value.description ? { description: value.description } : {}),
    ...(includeDefinition && value.definition ? { definition: value.definition } : {}),
    status: value.status,
    validationErrors: value.validationErrors,
    operation: value.operation,
    createdAt: new Date(value.createdAt).toISOString(),
  };
}

function usageDto(value: unknown): ChatUsage | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const usage = value as Record<string, unknown>;
  if (
    !['input', 'output', 'total'].every(
      (key) => Number.isSafeInteger(usage[key]) && (usage[key] as number) >= 0,
    )
  ) {
    return undefined;
  }
  return {
    input: usage.input as number,
    output: usage.output as number,
    total: usage.total as number,
  };
}

function runDto(value: WorkflowRun): WorkflowRunRecord {
  const usage = usageDto(value.usage);
  return {
    id: value.id,
    taskId: value.taskId,
    workflowId: value.workflowId,
    workflowVersion: value.workflowVersion,
    nameSnapshot: value.nameSnapshot,
    descriptionSnapshot: value.descriptionSnapshot,
    scriptSnapshot: value.scriptSnapshot,
    ...(value.definitionSnapshot ? { definitionSnapshot: value.definitionSnapshot } : {}),
    wakerId: value.wakerId,
    ...(value.projectId ? { projectId: value.projectId } : {}),
    ...(value.model ? { model: value.model } : {}),
    ...(value.thinking ? { thinking: value.thinking } : {}),
    ...(value.sessionId ? { sessionId: value.sessionId } : {}),
    ...(value.parentRunId ? { parentRunId: value.parentRunId } : {}),
    ...(value.parentNodeId ? { parentNodeId: value.parentNodeId } : {}),
    ...(value.childRunId ? { childRunId: value.childRunId } : {}),
    depth: value.depth,
    attempt: value.attempt,
    ...(value.retryOfRunId ? { retryOfRunId: value.retryOfRunId } : {}),
    ...(value.currentNodeId ? { currentNodeId: value.currentNodeId } : {}),
    context: value.context,
    ...(iso(value.wakeAt) ? { wakeAt: iso(value.wakeAt) } : {}),
    ...(value.waitingActionId ? { waitingActionId: value.waitingActionId } : {}),
    status: value.status,
    ...(value.input === undefined ? {} : { input: value.input }),
    ...(value.output === undefined ? {} : { output: value.output }),
    ...(value.result === undefined ? {} : { result: value.result }),
    ...(usage ? { usage } : {}),
    ...(value.error ? { error: value.error } : {}),
    createdAt: new Date(value.createdAt).toISOString(),
    updatedAt: new Date(value.updatedAt).toISOString(),
    ...(iso(value.startedAt) ? { startedAt: iso(value.startedAt) } : {}),
    ...(iso(value.completedAt) ? { completedAt: iso(value.completedAt) } : {}),
  };
}

function eventDto(value: WorkflowRunEvent): WorkflowRunEventRecord {
  return {
    id: value.id,
    runId: value.runId,
    sequence: value.sequence,
    type: value.type,
    ...(value.payload === undefined ? {} : { payload: value.payload }),
    createdAt: new Date(value.createdAt).toISOString(),
  };
}

function mutationDto(value: WorkflowMutationPreview): WorkflowMutationResponse {
  return { applied: value.applied, workflow: workflowDto(value.workflow), diff: value.diff };
}

function impactDto(value: WorkflowDeleteImpact): WorkflowDeleteImpactRecord {
  return {
    ...value,
    behavior: { definition: 'soft-delete', versions: 'preserve', runs: 'preserve' },
  };
}

function sendError(reply: FastifyReply, error: unknown): void {
  const message = error instanceof Error ? error.message : '请求无法处理';
  if (error instanceof WorkflowConflictError || /active run|already has an active/.test(message)) {
    reply.code(409).send({ error: message });
  } else {
    reply.code(400).send({ error: message });
  }
}

function validateModels(
  ctx: AppContext,
  model: string | null | undefined,
  definition: unknown,
): void {
  const available = new Set(listCodexModels(ctx.cwd).map((entry) => entry.id));
  if (model && !available.has(model)) throw new Error(`模型不在可用列表中：${model}`);
  if (!definition || typeof definition !== 'object' || !('nodes' in definition)) return;
  for (const node of ((definition as { nodes?: unknown }).nodes as unknown[] | undefined) ?? []) {
    if (node && typeof node === 'object' && 'model' in node) {
      const value = (node as { model?: unknown }).model;
      if (typeof value === 'string' && !available.has(value)) {
        throw new Error(`模型不在可用列表中：${value}`);
      }
    }
  }
}

function validateDefinition(
  ctx: AppContext,
  wakerId: string,
  source: unknown,
  workflowId?: string,
): WorkflowValidationResponse {
  const result = ctx.workspaceData.validateWorkflow(wakerId, source, { workflowId });
  if (!result.definition) return { valid: false, errors: result.errors };
  try {
    validateModels(ctx, undefined, result.definition);
  } catch (error) {
    return { valid: false, errors: [error instanceof Error ? error.message : '模型无效'] };
  }
  return {
    valid: true,
    definition: result.definition,
    script: serializeWorkflowDefinition(result.definition),
    errors: [],
  };
}

function ownedWorkflow(ctx: AppContext, reply: FastifyReply, wakerId: string, workflowId: string) {
  const value = ctx.workspaceData.getWorkflow(wakerId, workflowId);
  if (!value) reply.code(404).send({ error: 'WakerFlow 不存在' });
  return value;
}

function ownedWorkflowRun(ctx: AppContext, reply: FastifyReply, wakerId: string, runId: string) {
  const value = ctx.workspaceData.getWorkflowRun(wakerId, runId);
  if (!value) reply.code(404).send({ error: 'Workflow run 不存在' });
  return value;
}

export function registerWorkflowRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post(
    '/workflows/validate',
    {
      schema: {
        body: Type.Object(
          {
            wakerId: id,
            workflowId: Type.Optional(id),
            script: Type.String({ minLength: 1, maxLength: 100_000 }),
          },
          { additionalProperties: false },
        ),
      },
    },
    async (request, reply) => {
      const { wakerId, workflowId, script } = request.body as WorkflowValidationRequest;
      if (!agentOr404(ctx, wakerId, reply)) return;
      if (workflowId && !ownedWorkflow(ctx, reply, wakerId, workflowId)) return;
      return validateDefinition(ctx, wakerId, script, workflowId);
    },
  );

  // AI 生成定义（矩阵行 75）：无状态一次性调用；输出经服务端 DSL 校验后才返回。
  app.post(
    '/workflows/generate-definition',
    {
      schema: {
        body: Type.Object(
          {
            description: Type.String({ minLength: 1, maxLength: 2_000 }),
            model: Type.Optional(id),
          },
          { additionalProperties: false },
        ),
      },
    },
    async (request, reply) => {
      const { description, model } = request.body as WorkflowGenerateDefinitionRequest;
      if (model) {
        const available = new Set(listCodexModels(ctx.cwd).map((entry) => entry.id));
        if (!available.has(model))
          return reply.code(400).send({ error: `模型不在可用列表中：${model}` });
      }
      let raw: string;
      try {
        raw = await ctx.generateWorkflowDefinition(
          buildWorkflowDefinitionPrompt(description),
          model,
        );
      } catch (error) {
        return reply.code(502).send({
          error: `AI 生成定义失败：${error instanceof Error ? error.message : '模型调用失败'}`,
        });
      }
      let source: unknown;
      try {
        source = parseWorkflowDefinitionOutput(raw);
      } catch {
        return reply.code(502).send({ error: 'AI 未返回有效的 JSON 定义，请重试' });
      }
      const result = validateWorkflowDefinition(source);
      if (!result.definition) {
        return reply
          .code(422)
          .send({ error: '生成的定义未通过校验，请调整描述后重试', errors: result.errors });
      }
      const response: WorkflowGenerateDefinitionResponse = { definition: result.definition };
      return response;
    },
  );

  app.get('/workflows', { schema: { querystring: wakerQuery } }, async (request, reply) => {
    const { wakerId } = request.query as { wakerId: string };
    if (!agentOr404(ctx, wakerId, reply)) return;
    return { items: ctx.workspaceData.listWorkflows(wakerId).map(workflowSummaryDto) };
  });

  app.get(
    '/workflows/:workflowId',
    { schema: { params: Type.Object({ workflowId: id }), querystring: wakerQuery } },
    async (request, reply) => {
      const { workflowId } = request.params as { workflowId: string };
      const { wakerId } = request.query as { wakerId: string };
      if (!agentOr404(ctx, wakerId, reply)) return;
      const value = ownedWorkflow(ctx, reply, wakerId, workflowId);
      return value ? workflowDto(value) : undefined;
    },
  );

  app.post(
    '/workflows',
    {
      schema: {
        body: Type.Object(
          {
            wakerId: id,
            name: Type.String({ minLength: 1, maxLength: 160 }),
            description: Type.Optional(Type.String({ maxLength: 2_000 })),
            projectId: Type.Optional(nullableId),
            model: Type.Optional(nullableId),
            thinking: Type.Optional(nullableThinking),
            status: Type.Optional(workflowStatus),
            definition: Type.Unknown(),
          },
          { additionalProperties: false },
        ),
      },
    },
    async (request, reply) => {
      const body = request.body as {
        wakerId: string;
        name: string;
        description?: string;
        projectId?: string | null;
        model?: string | null;
        thinking?: (typeof AGENT_THINKING_LEVELS)[number] | null;
        status?: 'draft' | 'active' | 'paused';
        definition: unknown;
      };
      if (!agentOr404(ctx, body.wakerId, reply)) return;
      if (rejectDeletingAgent(reply, body.wakerId)) return;
      try {
        validateModels(ctx, body.model, body.definition);
        return reply.code(201).send(workflowDto(ctx.workspaceData.createWorkflow(body)));
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.patch(
    '/workflows/:workflowId',
    {
      schema: {
        params: Type.Object({ workflowId: id }),
        body: Type.Object(
          {
            wakerId: id,
            expectedVersion: Type.Integer({ minimum: 1 }),
            name: Type.Optional(Type.String({ minLength: 1, maxLength: 160 })),
            description: Type.Optional(Type.String({ maxLength: 2_000 })),
            projectId: Type.Optional(nullableId),
            model: Type.Optional(nullableId),
            thinking: Type.Optional(nullableThinking),
            status: Type.Optional(workflowStatus),
            definition: Type.Optional(Type.Unknown()),
          },
          { additionalProperties: false },
        ),
      },
    },
    async (request, reply) => {
      const { workflowId } = request.params as { workflowId: string };
      const body = request.body as {
        wakerId: string;
        expectedVersion: number;
        model?: string | null;
        definition?: unknown;
      } & Record<string, unknown>;
      if (!agentOr404(ctx, body.wakerId, reply)) return;
      if (rejectDeletingAgent(reply, body.wakerId)) return;
      if (!ownedWorkflow(ctx, reply, body.wakerId, workflowId)) return;
      try {
        validateModels(ctx, body.model, body.definition);
        const { wakerId, ...patch } = body;
        return workflowDto(ctx.workspaceData.updateWorkflow(wakerId, workflowId, patch as never)!);
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.get(
    '/workflows/:workflowId/versions',
    {
      schema: {
        params: Type.Object({ workflowId: id }),
        querystring: Type.Object(
          {
            wakerId: id,
            limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
            offset: Type.Optional(Type.Integer({ minimum: 0 })),
          },
          { additionalProperties: false },
        ),
      },
    },
    async (request, reply) => {
      const { workflowId } = request.params as { workflowId: string };
      const {
        wakerId,
        limit = 100,
        offset = 0,
      } = request.query as {
        wakerId: string;
        limit?: number;
        offset?: number;
      };
      if (!ownedWorkflow(ctx, reply, wakerId, workflowId)) return;
      const response: WorkflowVersionListResponse = {
        items: ctx.workspaceData
          .listWorkflowVersions(wakerId, workflowId, limit, offset)
          .map((value) => versionDto(value)),
        total: ctx.workspaceData.countWorkflowVersions(wakerId, workflowId),
      };
      return response;
    },
  );

  app.get(
    '/workflows/:workflowId/diff',
    {
      schema: {
        params: Type.Object({ workflowId: id }),
        querystring: Type.Object(
          {
            wakerId: id,
            fromVersion: Type.Integer({ minimum: 1 }),
            toVersion: Type.Integer({ minimum: 1 }),
          },
          { additionalProperties: false },
        ),
      },
    },
    async (request, reply) => {
      const { workflowId } = request.params as { workflowId: string };
      const query = request.query as { wakerId: string; fromVersion: number; toVersion: number };
      if (!ownedWorkflow(ctx, reply, query.wakerId, workflowId)) return;
      const diff = ctx.workspaceData.diffWorkflowVersions(
        query.wakerId,
        workflowId,
        query.fromVersion,
        query.toVersion,
      );
      return diff === undefined ? reply.code(404).send({ error: 'Workflow 版本不存在' }) : { diff };
    },
  );

  app.post(
    '/workflows/:workflowId/rollback',
    {
      schema: {
        params: Type.Object({ workflowId: id }),
        body: Type.Object(
          {
            wakerId: id,
            targetVersion: Type.Integer({ minimum: 1 }),
            expectedVersion: Type.Integer({ minimum: 1 }),
            apply: Type.Optional(Type.Boolean()),
          },
          { additionalProperties: false },
        ),
      },
    },
    async (request, reply) => {
      const { workflowId } = request.params as { workflowId: string };
      const body = request.body as {
        wakerId: string;
        targetVersion: number;
        expectedVersion: number;
        apply?: boolean;
      };
      if (!ownedWorkflow(ctx, reply, body.wakerId, workflowId)) return;
      if (rejectDeletingAgent(reply, body.wakerId)) return;
      try {
        const target = ctx.workspaceData.getWorkflowVersion(
          body.wakerId,
          workflowId,
          body.targetVersion,
        );
        if (!target?.definition) return reply.code(404).send({ error: 'Workflow 版本不存在' });
        validateModels(ctx, target.model, target.definition);
        const validation = validateDefinition(ctx, body.wakerId, target.definition, workflowId);
        if (!validation.valid) throw new Error(validation.errors.join('; '));
        const value = ctx.workspaceData.rollbackWorkflow(body.wakerId, workflowId, body);
        return value ? mutationDto(value) : reply.code(404).send({ error: 'Workflow 版本不存在' });
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.get(
    '/workflows/:workflowId/delete-impact',
    { schema: { params: Type.Object({ workflowId: id }), querystring: wakerQuery } },
    async (request, reply) => {
      const { workflowId } = request.params as { workflowId: string };
      const { wakerId } = request.query as { wakerId: string };
      const value = ctx.workspaceData.getWorkflowDeleteImpact(wakerId, workflowId);
      return value ? impactDto(value) : reply.code(404).send({ error: 'WakerFlow 不存在' });
    },
  );

  app.delete(
    '/workflows/:workflowId',
    {
      schema: {
        params: Type.Object({ workflowId: id }),
        querystring: Type.Object(
          { wakerId: id, expectedVersion: Type.Integer({ minimum: 1 }) },
          { additionalProperties: false },
        ),
      },
    },
    async (request, reply) => {
      const { workflowId } = request.params as { workflowId: string };
      const { wakerId, expectedVersion } = request.query as {
        wakerId: string;
        expectedVersion: number;
      };
      if (rejectDeletingAgent(reply, wakerId)) return;
      try {
        return ctx.workspaceData.deleteWorkflow(wakerId, workflowId, expectedVersion)
          ? reply.code(204).send()
          : reply.code(404).send({ error: 'WakerFlow 不存在' });
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.post(
    '/workflows/:workflowId/run',
    {
      schema: {
        params: Type.Object({ workflowId: id }),
        body: Type.Object(
          { wakerId: id, input: Type.Optional(Type.Unknown()) },
          { additionalProperties: false },
        ),
      },
    },
    async (request, reply) => {
      const { workflowId } = request.params as { workflowId: string };
      const { wakerId, input } = request.body as { wakerId: string; input?: unknown };
      if (!agentOr404(ctx, wakerId, reply)) return;
      if (!ownedWorkflow(ctx, reply, wakerId, workflowId)) return;
      if (rejectDeletingAgent(reply, wakerId)) return;
      try {
        const run = ctx.workspaceData.runWorkflow(wakerId, workflowId, input);
        ctx.workflowExecutor.enqueue(wakerId, run.id);
        return reply.code(202).send(runDto(run));
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.get(
    '/workflow-runs',
    {
      schema: {
        querystring: Type.Object(
          {
            wakerId: id,
            workflowId: Type.Optional(id),
            limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
            offset: Type.Optional(Type.Integer({ minimum: 0 })),
          },
          { additionalProperties: false },
        ),
      },
    },
    async (request, reply) => {
      const {
        wakerId,
        workflowId,
        limit = 100,
        offset = 0,
      } = request.query as {
        wakerId: string;
        workflowId?: string;
        limit?: number;
        offset?: number;
      };
      if (!agentOr404(ctx, wakerId, reply)) return;
      const items = ctx.workspaceData
        .listWorkflowRuns(wakerId, workflowId, limit, offset)
        .map(runDto);
      const response: WorkflowRunListResponse = {
        items,
        total: ctx.workspaceData.countWorkflowRuns(wakerId, workflowId),
      };
      return response;
    },
  );

  app.get(
    '/workflow-runs/:runId/trace',
    { schema: { params: Type.Object({ runId: id }), querystring: wakerQuery } },
    async (request, reply) => {
      const { runId } = request.params as { runId: string };
      const { wakerId } = request.query as { wakerId: string };
      try {
        const trace = ctx.workspaceData.getWorkflowRunTrace(wakerId, runId);
        return { run: runDto(trace.run), events: trace.events.map(eventDto) };
      } catch {
        return reply.code(404).send({ error: 'Workflow run 不存在' });
      }
    },
  );

  app.post(
    '/workflow-runs/:runId/resume',
    {
      schema: {
        params: Type.Object({ runId: id }),
        body: Type.Object(
          { wakerId: id, input: Type.Optional(Type.Unknown()) },
          { additionalProperties: false },
        ),
      },
    },
    async (request, reply) => {
      const { runId } = request.params as { runId: string };
      const { wakerId, input } = request.body as { wakerId: string; input?: unknown };
      if (!agentOr404(ctx, wakerId, reply)) return;
      if (!ownedWorkflowRun(ctx, reply, wakerId, runId)) return;
      if (rejectDeletingAgent(reply, wakerId)) return;
      try {
        return reply
          .code(202)
          .send(runDto(await ctx.workflowExecutor.resume(wakerId, runId, input)));
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  for (const action of ['cancel', 'retry'] as const) {
    app.post(
      `/workflow-runs/:runId/${action}`,
      {
        schema: {
          params: Type.Object({ runId: id }),
          body: Type.Object({ wakerId: id }, { additionalProperties: false }),
        },
      },
      async (request, reply) => {
        const { runId } = request.params as { runId: string };
        const { wakerId } = request.body as { wakerId: string };
        if (!agentOr404(ctx, wakerId, reply)) return;
        if (!ownedWorkflowRun(ctx, reply, wakerId, runId)) return;
        if (rejectDeletingAgent(reply, wakerId)) return;
        try {
          const run =
            action === 'cancel'
              ? await ctx.workflowExecutor.cancel(wakerId, runId)
              : ctx.workflowExecutor.retry(wakerId, runId);
          return reply.code(action === 'retry' ? 202 : 200).send(runDto(run));
        } catch (error) {
          return sendError(reply, error);
        }
      },
    );
  }
}
