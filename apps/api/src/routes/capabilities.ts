import type { FastifyInstance, FastifyReply } from 'fastify';
import { Type } from '@sinclair/typebox';
import { join } from 'node:path';
import {
  getCodexSandboxConfig,
  probeMcpServerTools,
  registerMcpServer,
  removeMcpServer,
} from '@waker/codex-runtime';
import type { Connector, HumanAction, PermissionPolicy } from '@waker/workspace-data';
import type { AppContext } from '../context.js';

const id = Type.String({ minLength: 1, maxLength: 200 });
const HOST_TOOLS = ['file_read', 'shell', 'web_search', 'mcp'] as const;

function connectorError(value: Connector): string | undefined {
  const message = value.metadata.lastError;
  return typeof message === 'string' && message ? message : undefined;
}

function connectorDto(value: Connector) {
  const error = connectorError(value);
  return {
    ...value,
    ...(value.command ? { command: value.command } : { command: undefined }),
    ...(value.url ? { url: value.url } : { url: undefined }),
    ...(error ? { error } : {}),
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** connector 对应的 mcp_servers 条目名（UUID 只含安全字符）。 */
function mcpServerName(connector: Connector): string {
  return `waker_${connector.id}`;
}

function metadataWithError(connector: Connector, message: string): Record<string, unknown> {
  return { ...connector.metadata, lastError: message };
}

function metadataWithoutError(connector: Connector): Record<string, unknown> {
  const { lastError: _dropped, ...metadata } = connector.metadata;
  return metadata;
}

/**
 * enable 的真实语义（对齐 QoderWake 0.4.2 ConnectorToolDiscoveryService）：
 * 先把 MCP server 合并写入 Codex CLI 配置面（$CODEX_HOME/config.toml，新线程生效），
 * 再用 MCP 协议直连探测工具列表；任一步失败 status='error' + lastError。
 */
async function enableConnectorReal(
  ctx: AppContext,
  wakerId: string,
  connectorId: string,
): Promise<Connector | undefined> {
  const connector = ctx.workspaceData.getConnector(wakerId, connectorId);
  if (!connector) return undefined;
  const spec = {
    name: mcpServerName(connector),
    transport: connector.transport,
    ...(connector.command ? { command: connector.command } : {}),
    ...(connector.url ? { url: connector.url } : {}),
  };
  const codexHome = join(ctx.cwd, '.codex');
  try {
    await registerMcpServer(codexHome, spec);
  } catch (error) {
    return ctx.workspaceData.updateConnector(wakerId, connectorId, {
      status: 'error',
      metadata: metadataWithError(connector, errorMessage(error)),
    });
  }
  try {
    const tools = await probeMcpServerTools(spec);
    return ctx.workspaceData.updateConnector(wakerId, connectorId, {
      status: 'ready',
      tools,
      metadata: metadataWithoutError(connector),
    });
  } catch (error) {
    return ctx.workspaceData.updateConnector(wakerId, connectorId, {
      status: 'error',
      metadata: metadataWithError(connector, errorMessage(error)),
    });
  }
}

async function disableConnectorReal(
  ctx: AppContext,
  wakerId: string,
  connectorId: string,
): Promise<Connector | undefined> {
  const connector = ctx.workspaceData.getConnector(wakerId, connectorId);
  if (!connector) return undefined;
  try {
    await removeMcpServer(join(ctx.cwd, '.codex'), mcpServerName(connector));
  } catch (error) {
    return ctx.workspaceData.updateConnector(wakerId, connectorId, {
      status: 'error',
      metadata: metadataWithError(connector, errorMessage(error)),
    });
  }
  return ctx.workspaceData.updateConnector(wakerId, connectorId, {
    status: 'disabled',
    metadata: metadataWithoutError(connector),
  });
}

async function probeConnectorReal(
  ctx: AppContext,
  wakerId: string,
  connectorId: string,
): Promise<Connector | undefined> {
  const connector = ctx.workspaceData.getConnector(wakerId, connectorId);
  if (!connector) return undefined;
  try {
    const tools = await probeMcpServerTools({
      transport: connector.transport,
      ...(connector.command ? { command: connector.command } : {}),
      ...(connector.url ? { url: connector.url } : {}),
    });
    return ctx.workspaceData.updateConnector(wakerId, connectorId, {
      status: connector.status === 'disabled' ? 'disabled' : 'ready',
      tools,
      metadata: metadataWithoutError(connector),
    });
  } catch (error) {
    return ctx.workspaceData.updateConnector(wakerId, connectorId, {
      status: 'error',
      metadata: metadataWithError(connector, errorMessage(error)),
    });
  }
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
              ? await enableConnectorReal(ctx, wakerId, connectorId)
              : await disableConnectorReal(ctx, wakerId, connectorId);
          return updated
            ? connectorDto(updated)
            : reply.code(404).send({ error: 'Connector 不存在' });
        } catch (error) {
          return badRequest(reply, error);
        }
      },
    );
  }

  app.post(
    '/connectors/:connectorId/probe',
    { schema: { params: Type.Object({ connectorId: id }), body: Type.Object({ wakerId: id }) } },
    async (request, reply) => {
      const { connectorId } = request.params as { connectorId: string };
      const { wakerId } = request.body as { wakerId: string };
      try {
        const updated = await probeConnectorReal(ctx, wakerId, connectorId);
        return updated
          ? connectorDto(updated)
          : reply.code(404).send({ error: 'Connector 不存在' });
      } catch (error) {
        return badRequest(reply, error);
      }
    },
  );

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
      const connector = ctx.workspaceData.getConnector(wakerId, connectorId);
      if (!connector) return reply.code(404).send({ error: 'Connector 不存在' });
      // 删除连带清掉 Codex CLI 配置面里的条目；清理失败不阻塞删除（残留条目
      // 指向的 server 不再被引用，下次 enable 同名覆盖）。
      try {
        await removeMcpServer(join(ctx.cwd, '.codex'), mcpServerName(connector));
      } catch {
        // best-effort
      }
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
