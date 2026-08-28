import type { FastifyInstance } from 'fastify';
import {
  AGENT_THINKING_LEVELS,
  type PreferencesResponse,
  type PreferenceUpdateRequest,
} from '@waker/contracts';
import {
  deletePreference,
  getPreferences,
  listCodexModels,
  setPreference,
} from '@waker/codex-runtime';
import { PreferenceUpdateSchema } from '../schemas.js';
import type { AppContext } from '../context.js';

// UI 偏好（ui.* / thinking.<agentId> / model.<agentId>）持久化在 .codex/workbench.sqlite；浏览器仍以 localStorage 做即时缓存。
export function registerPreferenceRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/preferences', async (): Promise<PreferencesResponse> => ({
    items: getPreferences(ctx.cwd),
  }));

  app.put<{ Body: PreferenceUpdateRequest }>(
    '/preferences',
    { schema: { body: PreferenceUpdateSchema } },
    async (request, reply) => {
      const { key, value } = request.body;
      // model.<agentId> 的 value 必须在模型目录内；空串表示「跟随全局默认」，直接删除该偏好。
      if (key.startsWith('model.')) {
        if (value === '') {
          deletePreference(ctx.cwd, key);
          return { items: getPreferences(ctx.cwd) };
        }
        const available = listCodexModels(ctx.cwd);
        if (typeof value !== 'string' || !available.some((model) => model.id === value)) {
          return reply.code(400).send({ error: `模型不在可用列表内：${String(value)}` });
        }
      }
      // thinking.<agentId> 的 value 必须是合法的 reasoning effort 档位。
      if (
        key.startsWith('thinking.') &&
        (typeof value !== 'string' || !(AGENT_THINKING_LEVELS as readonly string[]).includes(value))
      ) {
        return reply.code(400).send({ error: `thinking 档位不合法：${String(value)}` });
      }
      setPreference(ctx.cwd, key, value);
      return { items: getPreferences(ctx.cwd) };
    },
  );
}
