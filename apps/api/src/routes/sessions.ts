import type { FastifyInstance } from 'fastify';
import type {
  InboxItem,
  InboxResponse,
  InboxTab,
  RenameSessionRequest,
  SessionListResponse,
  SessionMessagesResponse,
  UpdateInboxStateRequest,
} from '@waker/contracts';
import { codexThreadRegistry, type SessionRecord } from '@waker/codex-runtime';
import {
  AgentParamsSchema,
  InboxQuerySchema,
  RenameSessionSchema,
  SessionParamsSchema,
  UpdateInboxStateSchema,
} from '../schemas.js';
import { agentOr404, withOwnedSession, type AppContext } from '../context.js';

/** SessionRecord 已携带 sessions 表里的 read/completedAt，形状与 InboxItem 一致。 */
function toInboxItem(session: SessionRecord): InboxItem {
  return { ...session };
}

export function registerSessionRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get<{ Querystring: { tab?: InboxTab; q?: string } }>(
    '/inbox',
    { schema: { querystring: InboxQuerySchema } },
    async (request): Promise<InboxResponse> => {
      const tab = request.query.tab ?? 'attention';
      const query = request.query.q?.trim().toLowerCase();
      let sessions = await ctx.sessions.listSessions();

      // 自动完成：被标记过已读（即进过收件箱）、尚未完成，且最新一轮已成功。
      let changed = false;
      for (const session of sessions) {
        if (session.read && !session.completedAt && !session.needsAttention) {
          await ctx.sessions.updateInboxState(session.id, session.agentId, { completed: true });
          changed = true;
        }
      }
      if (changed) sessions = await ctx.sessions.listSessions();

      const inTab = sessions.filter((session) => {
        const completed = Boolean(session.completedAt);
        const attention = session.needsAttention && !completed;
        if (tab === 'attention') return attention;
        if (tab === 'completed') return completed;
        return attention || completed;
      });
      // unreadCount 始终按 attention 集合统计，不受 tab/q 影响。
      const unreadCount = sessions.filter(
        (session) => session.needsAttention && !session.completedAt && !session.read,
      ).length;
      const filtered = query
        ? inTab.filter(
            (session) =>
              session.title.toLowerCase().includes(query) ||
              (session.preview ?? '').toLowerCase().includes(query),
          )
        : inTab;
      const items = filtered
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .map((session) => toInboxItem(session));
      return { items, total: items.length, unreadCount };
    },
  );

  app.get<{ Params: { agentId: string } }>(
    '/agents/:agentId/sessions',
    { schema: { params: AgentParamsSchema } },
    async (request, reply): Promise<SessionListResponse | undefined> => {
      if (!agentOr404(ctx, request.params.agentId, reply)) return;
      const items = await ctx.sessions.listSessions(request.params.agentId);
      return { items, total: items.length };
    },
  );

  app.post<{ Params: { agentId: string } }>(
    '/agents/:agentId/sessions',
    { schema: { params: AgentParamsSchema } },
    async (request, reply) => {
      if (!agentOr404(ctx, request.params.agentId, reply)) return;
      return ctx.sessions.createSession(request.params.agentId);
    },
  );

  app.get<{ Params: { agentId: string; sessionId: string } }>(
    '/agents/:agentId/sessions/:sessionId',
    {
      schema: { params: SessionParamsSchema },
    },
    async (request, reply) => {
      if (!agentOr404(ctx, request.params.agentId, reply)) return;
      const session = await withOwnedSession(reply, () =>
        ctx.sessions.getSession(request.params.sessionId, request.params.agentId),
      );
      if (session === undefined && !reply.sent)
        return reply.code(404).send({ error: '会话不存在' });
      return session;
    },
  );

  app.get<{ Params: { agentId: string; sessionId: string } }>(
    '/agents/:agentId/sessions/:sessionId/messages',
    {
      schema: { params: SessionParamsSchema },
    },
    async (request, reply) => {
      if (!agentOr404(ctx, request.params.agentId, reply)) return;
      const items = await withOwnedSession(reply, () =>
        ctx.sessions.listMessages(request.params.sessionId, request.params.agentId),
      );
      if (items === undefined) return;
      return { items } satisfies SessionMessagesResponse;
    },
  );

  app.patch<{ Params: { agentId: string; sessionId: string }; Body: RenameSessionRequest }>(
    '/agents/:agentId/sessions/:sessionId',
    {
      schema: { params: SessionParamsSchema, body: RenameSessionSchema },
    },
    async (request, reply) => {
      if (!agentOr404(ctx, request.params.agentId, reply)) return;
      // rename 必须与进行中的 turn 共用一个 per-key 串行队列，排在 in-flight turn 之后执行，
      // 避免与 registry 持有的 Codex thread 并发操作同一会话。
      const session = await withOwnedSession(reply, () =>
        codexThreadRegistry.runExclusive(request.params.agentId, request.params.sessionId, () =>
          ctx.sessions.renameSession(
            request.params.sessionId,
            request.params.agentId,
            request.body.title,
          ),
        ),
      );
      if (session === undefined && !reply.sent)
        return reply.code(404).send({ error: '会话不存在' });
      return session;
    },
  );

  app.patch<{ Params: { agentId: string; sessionId: string }; Body: UpdateInboxStateRequest }>(
    '/agents/:agentId/sessions/:sessionId/inbox',
    {
      schema: { params: SessionParamsSchema, body: UpdateInboxStateSchema },
    },
    async (request, reply) => {
      if (!agentOr404(ctx, request.params.agentId, reply)) return;
      // 只写 sessions 表的 inbox 字段，不触碰 rollout JSONL，无需进入 per-session 串行队列。
      const session = await withOwnedSession(reply, () =>
        ctx.sessions.getSession(request.params.sessionId, request.params.agentId),
      );
      if (session === undefined && !reply.sent)
        return reply.code(404).send({ error: '会话不存在' });
      if (!session) return;
      const patch: { read?: boolean; completed?: boolean } = {};
      if (request.body.completed !== undefined) patch.completed = request.body.completed;
      if (request.body.read !== undefined) patch.read = request.body.read;
      // completed=true 顺带标记已读，但不应覆盖本次请求里显式的 read。
      else if (request.body.completed === true) patch.read = true;
      // 不在收件箱任一集合的会话也照常返回最新状态字段。
      return ctx.sessions.updateInboxState(session.id, session.agentId, patch);
    },
  );

  app.delete<{ Params: { agentId: string; sessionId: string } }>(
    '/agents/:agentId/sessions/:sessionId',
    {
      schema: { params: SessionParamsSchema },
    },
    async (request, reply) => {
      if (!agentOr404(ctx, request.params.agentId, reply)) return;
      const removed = await withOwnedSession(reply, async () => {
        // 先取消排队中的 turn：它们出队即 reject，不会在 getOrCreate 里重建绑定；
        // close 再 abort 进行中的 turn 并等该 key 的队列全部落定，最后才删绑定与 rollout 文件。
        codexThreadRegistry.cancelQueued(request.params.agentId, request.params.sessionId);
        await codexThreadRegistry.close(request.params.agentId, request.params.sessionId);
        ctx.artifacts.deleteSession(request.params.sessionId);
        ctx.workspaceData.deleteSessionContext(request.params.agentId, request.params.sessionId);
        // inbox 状态随 sessions 表行一起删除，无需额外清理。
        return ctx.sessions.deleteSession(request.params.sessionId, request.params.agentId);
      });
      if (removed === undefined) return;
      if (!removed) return reply.code(404).send({ error: '会话不存在' });
      return reply.code(204).send();
    },
  );
}
