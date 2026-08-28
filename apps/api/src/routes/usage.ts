import type { FastifyInstance } from 'fastify';
import type { TokenTotals, UsageResponse } from '@waker/contracts';
import { loadAgents, summarizeUsage } from '@waker/codex-runtime';
import type { AppContext } from '../context.js';

const ZERO_TOKENS: TokenTotals = { input: 0, output: 0, total: 0 };

export function registerUsageRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/usage', async (): Promise<UsageResponse> => {
    const sessions = await ctx.sessions.listSessions();
    const base = summarizeUsage(sessions, loadAgents(ctx.cwd));

    // 没有独立的 usage 事件存储：token 总量从 rollout 解析。rollout 的 token_count
    // 是会话级累计值（挂在最后一条 assistant 消息上），每会话取最新一条求和。
    const tokensByAgent = new Map<string, TokenTotals>();
    const totals = { ...ZERO_TOKENS };
    for (const session of sessions) {
      const messages = await ctx.sessions.listMessages(session.id, session.agentId);
      const usage = [...messages].reverse().find((message) => message.usage)?.usage;
      if (!usage) continue;
      const bucket = tokensByAgent.get(session.agentId) ?? { ...ZERO_TOKENS };
      bucket.input += usage.input;
      bucket.output += usage.output;
      bucket.total += usage.total;
      tokensByAgent.set(session.agentId, bucket);
      totals.input += usage.input;
      totals.output += usage.output;
      totals.total += usage.total;
    }

    return {
      ...base,
      tokens: totals,
      perAgent: base.perAgent.map((row) => ({
        ...row,
        tokens: tokensByAgent.get(row.agentId) ?? { ...ZERO_TOKENS },
      })),
    };
  });
}
