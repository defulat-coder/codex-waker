import type { FastifyInstance } from 'fastify';
import type { AgentPackageImportReport } from '@waker/contracts';
import {
  AGENT_PACKAGE_MAX_BYTES,
  buildAgentPackage,
  importAgentPackage,
  PackageImportError,
} from '../lib/agent-package.js';
import { AgentParamsSchema, ImportAgentPackageQuerySchema } from '../schemas.js';
import { agentOr404, type AppContext } from '../context.js';

interface ImportPackageQuery {
  agentId?: string;
  mode?: 'dry-run' | 'apply';
  conflict?: 'error' | 'overwrite';
}

/**
 * Agent 整包导出/导入（对齐 QoderWake 0.4.2 的 export-package / import-package）。
 * body 是原始 ZIP 二进制，由 app.ts 在 /api/v1 scope 注册的 buffer parser 解析。
 */
export function registerAgentPackageRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get<{ Params: { agentId: string } }>(
    '/agents/:agentId/export-package',
    { schema: { params: AgentParamsSchema } },
    async (request, reply) => {
      if (!agentOr404(ctx, request.params.agentId, reply)) return;
      try {
        const { data, fileName } = buildAgentPackage(ctx, request.params.agentId);
        return reply
          .header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`)
          .type('application/zip')
          .send(data);
      } catch (error) {
        if (error instanceof PackageImportError) {
          return reply.code(error.statusCode).send({ error: error.message });
        }
        throw error;
      }
    },
  );

  app.post<{ Querystring: ImportPackageQuery }>(
    '/agents/import-package',
    {
      bodyLimit: AGENT_PACKAGE_MAX_BYTES,
      schema: { querystring: ImportAgentPackageQuerySchema },
    },
    async (request, reply): Promise<AgentPackageImportReport | void> => {
      const body = request.body;
      if (!Buffer.isBuffer(body) || body.length === 0) {
        return reply.code(400).send({ error: '请求体为空（应为 ZIP 整包）' });
      }
      try {
        const report = importAgentPackage(ctx, body, {
          ...(request.query.agentId ? { agentId: request.query.agentId } : {}),
          mode: request.query.mode ?? 'dry-run',
          conflict: request.query.conflict ?? 'error',
        });
        return reply.code(report.mode === 'apply' ? 201 : 200).send(report);
      } catch (error) {
        if (error instanceof PackageImportError) {
          return reply.code(error.statusCode).send({ error: error.message });
        }
        throw error;
      }
    },
  );
}
