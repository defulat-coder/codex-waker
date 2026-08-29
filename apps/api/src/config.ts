import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import envSchema from 'env-schema';
import { Type, type Static } from '@sinclair/typebox';
import { AGENT_THINKING_LEVELS, type AgentThinkingLevel } from '@waker/contracts';
import { isCodexAgentEnabled } from '@waker/codex-runtime';

const schema = Type.Object({
  PORT: Type.Number({ default: 4410, minimum: 1, maximum: 65535 }),
  HOST: Type.String({ default: '127.0.0.1' }),
  WEB_ORIGIN: Type.String({ default: 'https://waker.localhost' }),
  // 原文保留为字符串，统一交给 codex-runtime 的 isCodexAgentEnabled 判定（见 loadConfig）。
  CODEX_AGENT_ENABLED: Type.Optional(Type.String()),
  CODEX_MODEL: Type.Optional(Type.String({ minLength: 1, maxLength: 160 })),
  CODEX_REASONING_EFFORT: Type.Optional(
    Type.Unsafe<AgentThinkingLevel>({ enum: [...AGENT_THINKING_LEVELS] }),
  ),
  // Sandbox/approval/API-key 只是透传：packages/codex-runtime 直接读 process.env，
  // 这里列入 schema 仅保证 .env 里的值能被 loadEnvFile 带进进程环境。
  CODEX_SANDBOX_MODE: Type.Optional(
    Type.Union([
      Type.Literal('read-only'),
      Type.Literal('workspace-write'),
      Type.Literal('danger-full-access'),
    ]),
  ),
  CODEX_APPROVAL_POLICY: Type.Optional(
    Type.Union([
      Type.Literal('never'),
      Type.Literal('on-request'),
      Type.Literal('on-failure'),
      Type.Literal('untrusted'),
    ]),
  ),
  CODEX_API_KEY: Type.Optional(Type.String({ minLength: 1, maxLength: 240 })),
  // 对话后自动 memory 提取（memory dream）：'off' 时整体禁用，默认启用。
  WAKER_MEMORY_DREAM: Type.Optional(Type.String()),
  LOG_LEVEL: Type.Union(
    [
      Type.Literal('trace'),
      Type.Literal('debug'),
      Type.Literal('info'),
      Type.Literal('warn'),
      Type.Literal('error'),
    ],
    { default: 'info' },
  ),
});

export type AppConfig = Omit<Static<typeof schema>, 'CODEX_AGENT_ENABLED'> & {
  /** 已按 isCodexAgentEnabled 解析为布尔（'true'/'1'/'yes'，大小写不敏感）。 */
  CODEX_AGENT_ENABLED: boolean;
};

export function loadConfig(): AppConfig {
  const envPath = [resolve(process.cwd(), '.env'), resolve(process.cwd(), '../../.env')].find(
    (candidate) => existsSync(candidate),
  );
  // env-schema 8 reads .env via util.parseEnv, which no longer mutates process.env; load it explicitly so non-schema keys stay visible.
  if (envPath) process.loadEnvFile(envPath);
  const parsed = envSchema<Static<typeof schema>>({ schema });
  // 与 packages/codex-runtime 的 runAgentTurn 共用同一判定，避免两处对 CODEX_AGENT_ENABLED 解读不一致。
  return { ...parsed, CODEX_AGENT_ENABLED: isCodexAgentEnabled(parsed.CODEX_AGENT_ENABLED) };
}
