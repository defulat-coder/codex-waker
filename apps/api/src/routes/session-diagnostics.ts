import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import type {
  SessionDebugTimeline,
  SessionRuntimeDiagnostics,
  SessionTracesResponse,
} from '@waker/contracts';
import { SessionIdSchema } from '../schemas.js';
import type { AppContext } from '../context.js';

const SessionDiagnosticsParamsSchema = Type.Object({ sessionId: SessionIdSchema });
// limit 语义对齐旧版（clamp 1..1000）：debug-timeline 取最近 N 轮，traces 取最近 N 条。
const LimitQuerySchema = Type.Object({
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
});

/**
 * Session-runtime 诊断三件套（复刻 QoderWake 0.4.2）：
 * - GET /sessions/:sessionId/runtime-diagnostics  绑定/状态/失败记录/事件计数/usage/rollout 文件
 * - GET /sessions/:sessionId/debug-timeline       按 turn 归组的 rounds+nodes 时间线
 * - GET /sessions/:sessionId/traces               每次 turn 的模型/thinking/token/耗时/工具计数
 * 会话是全局唯一的（workbench sessions 表主键），不需要 agentId 定位；
 * 绑定缺失/非法的会话一律 404，不做迁移或推断。
 */
export function registerSessionDiagnosticsRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get<{ Params: { sessionId: string } }>(
    '/sessions/:sessionId/runtime-diagnostics',
    { schema: { params: SessionDiagnosticsParamsSchema } },
    async (request, reply): Promise<SessionRuntimeDiagnostics | undefined> => {
      const diagnostics = await ctx.sessions.getRuntimeDiagnostics(request.params.sessionId);
      if (!diagnostics) return reply.code(404).send({ error: '会话不存在' });
      return diagnostics;
    },
  );

  app.get<{ Params: { sessionId: string }; Querystring: { limit?: number } }>(
    '/sessions/:sessionId/debug-timeline',
    { schema: { params: SessionDiagnosticsParamsSchema, querystring: LimitQuerySchema } },
    async (request, reply): Promise<SessionDebugTimeline | undefined> => {
      const timeline = await ctx.sessions.getDebugTimeline(
        request.params.sessionId,
        request.query.limit,
      );
      if (!timeline) return reply.code(404).send({ error: '会话不存在' });
      return timeline;
    },
  );

  app.get<{ Params: { sessionId: string }; Querystring: { limit?: number } }>(
    '/sessions/:sessionId/traces',
    { schema: { params: SessionDiagnosticsParamsSchema, querystring: LimitQuerySchema } },
    async (request, reply): Promise<SessionTracesResponse | undefined> => {
      const traces = await ctx.sessions.getSessionTraces(
        request.params.sessionId,
        request.query.limit,
      );
      if (!traces) return reply.code(404).send({ error: '会话不存在' });
      return traces;
    },
  );
}
