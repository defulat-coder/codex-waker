import type { FastifyInstance, FastifyReply } from 'fastify';
import { Type } from '@sinclair/typebox';
import { getCodexSandboxConfig } from '@waker/codex-runtime';
import type { Connector, HumanAction, PermissionPolicy } from '@waker/workspace-data';
import type { AppContext } from '../context.js';

const id = Type.String({ minLength: 1, maxLength: 200 });
const HOST_TOOLS = ['file_read', 'shell', 'web_search', 'mcp'] as const;

function connectorDto(value: Connector) {
  return {
    ...value,
    ...(value.command ? { command: value.command } : { command: undefined }),
    ...(value.url ? { url: value.url } : { url: undefined }),
    createdAt: new Date(value.createdAt).toISOString(),
    updatedAt: new Date(value.updatedAt).toISOString(),
  };
}

function permissionDto(value: PermissionPolicy) {
  return { ...value, updatedAt: new Date(value.updatedAt).toISOString() };
}

function actionDto(value: HumanAction) {
  return {
    ...value,
    ...(value.result === undefined ? {} : { result: value.result }),
    createdAt: new Date(value.createdAt).toISOString(),
    updatedAt: new Date(value.updatedAt).toISOString(),
    ...(value.resolvedAt ? { resolvedAt: new Date(value.resolvedAt).toISOString() } : {}),
  };
}

function badRequest(reply: FastifyReply, error: unknown): void {
  reply.code(400).send({ error: error instanceof Error ? error.message : '请求无法处理' });
}

export function registerCapabilityRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/connectors', async (request, reply) => {
    const { wakerId } = request.query as { wakerId?: string };
    if (!wakerId) return reply.code(400).send({ error: 'wakerId 必填' });
    const items = ctx.workspaceData.listConnectors(wakerId).map(connectorDto);
    return { items, total: items.length };
  });

  app.post(
    '/connectors',
    {
      schema: {
        body: Type.Object({
          wakerId: id,
          name: Type.String({ minLength: 1, maxLength: 160 }),
          transport: Type.Union([Type.Literal('stdio'), Type.Literal('http')]),
          command: Type.Optional(Type.String({ maxLength: 4000 })),
          url: Type.Optional(Type.String({ maxLength: 4000 })),
          metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
          tools: Type.Optional(
            Type.Array(
              Type.Object({
                name: Type.String({ minLength: 1, maxLength: 120 }),
                description: Type.Optional(Type.String({ maxLength: 400 })),
              }),
              { maxItems: 100 },
            ),
          ),
        }),
      },
    },
    async (request, reply) => {
      const body = request.body as {
        wakerId: string;
        name: string;
        transport: 'stdio' | 'http';
        command?: string;
        url?: string;
        metadata?: Record<string, unknown>;
        tools?: Array<{ name: string; description?: string }>;
      };
      try {
        return reply
          .code(201)
          .send(connectorDto(ctx.workspaceData.createConnector({ ...body, status: 'disabled' })));
      } catch (error) {
        return badRequest(reply, error);
      }
    },
  );

  for (const action of ['enable', 'disable'] as const) {
    app.post(
      `/connectors/:connectorId/${action}`,
      { schema: { params: Type.Object({ connectorId: id }), body: Type.Object({ wakerId: id }) } },
      async (request, reply) => {
        const { connectorId } = request.params as { connectorId: string };
        const { wakerId } = request.body as { wakerId: string };
        try {
          const updated =
            action === 'enable'
              ? ctx.workspaceData.enableConnector(wakerId, connectorId)
              : ctx.workspaceData.disableConnector(wakerId, connectorId);
          return updated
            ? connectorDto(updated)
            : reply.code(404).send({ error: 'Connector 不存在' });
        } catch (error) {
          return badRequest(reply, error);
        }
      },
    );
  }

  app.delete(
    '/connectors/:connectorId',
    {
      schema: {
        params: Type.Object({ connectorId: id }),
        querystring: Type.Object({ wakerId: id }),
      },
    },
    async (request, reply) => {
      const { connectorId } = request.params as { connectorId: string };
      const { wakerId } = request.query as { wakerId: string };
      return ctx.workspaceData.deleteConnector(wakerId, connectorId)
        ? reply.code(204).send()
        : reply.code(404).send({ error: 'Connector 不存在' });
    },
  );

  app.get(
    '/permissions/:wakerId',
    { schema: { params: Type.Object({ wakerId: id }) } },
    async (request) => {
      const { wakerId } = request.params as { wakerId: string };
      const sandbox = getCodexSandboxConfig(ctx.cwd);
      const host = {
        sandboxMode: sandbox.sandboxMode,
        approvalPolicy: sandbox.approvalPolicy,
        toolGuard: 'allow' as const,
        fileGuard: 'allow' as const,
        builtinTools: [...HOST_TOOLS],
      };
      const policy = ctx.workspaceData.getPermissionPolicy(wakerId);
      return { host, policy: policy ? permissionDto(policy) : null, enforcedBy: 'codex-host' };
    },
  );

  app.put(
    '/permissions/:wakerId',
    {
      schema: {
        params: Type.Object({ wakerId: id }),
        body: Type.Object({
          sandboxMode: Type.Union([
            Type.Literal('read-only'),
            Type.Literal('workspace-write'),
            Type.Literal('danger-full-access'),
          ]),
          approvalPolicy: Type.Union([
            Type.Literal('never'),
            Type.Literal('untrusted'),
            Type.Literal('on-request'),
            Type.Literal('on-failure'),
          ]),
          toolGuard: Type.Union([Type.Literal('deny'), Type.Literal('ask'), Type.Literal('allow')]),
          fileGuard: Type.Union([Type.Literal('deny'), Type.Literal('ask'), Type.Literal('allow')]),
          builtinTools: Type.Array(Type.String({ minLength: 1, maxLength: 120 }), { maxItems: 50 }),
        }),
      },
    },
    async (request, reply) => {
      const { wakerId } = request.params as { wakerId: string };
      const sandbox = getCodexSandboxConfig(ctx.cwd);
      try {
        return permissionDto(
          ctx.workspaceData.setPermissionPolicy(wakerId, request.body as never, {
            sandboxMode: sandbox.sandboxMode,
            approvalPolicy: sandbox.approvalPolicy,
            toolGuard: 'allow',
            fileGuard: 'allow',
            builtinTools: [...HOST_TOOLS],
          }),
        );
      } catch (error) {
        return badRequest(reply, error);
      }
    },
  );

  app.get('/human-actions', async (request, reply) => {
    const query = request.query as { wakerId?: string; status?: 'pending' | 'handled' | 'ignored' };
    if (!query.wakerId) return reply.code(400).send({ error: 'wakerId 必填' });
    const items = ctx.workspaceData.listHumanActions(query.wakerId, query.status).map(actionDto);
    return { items, total: items.length };
  });

  app.get(
    '/sessions/:sessionId/context',
    {
      schema: { params: Type.Object({ sessionId: id }), querystring: Type.Object({ agentId: id }) },
    },
    async (request, reply) => {
      const { sessionId } = request.params as { sessionId: string };
      const { agentId } = request.query as { agentId: string };
      const context = ctx.workspaceData.getSessionContext(agentId, sessionId);
      if (!context) return reply.code(404).send({ error: '会话上下文不存在' });
      return {
        sessionId: context.sessionId,
        wakerId: context.wakerId,
        ...(context.projectId ? { projectId: context.projectId } : {}),
        ...(context.workingDirectory ? { workingDirectory: context.workingDirectory } : {}),
        createdAt: new Date(context.createdAt).toISOString(),
        updatedAt: new Date(context.updatedAt).toISOString(),
      };
    },
  );
}
