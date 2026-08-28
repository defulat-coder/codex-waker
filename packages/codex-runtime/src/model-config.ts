import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENT_THINKING_LEVELS, type AgentThinkingLevel } from '@waker/contracts';
import type { CodexOptions } from '@openai/codex-sdk';

export type CodexReasoningEffort = AgentThinkingLevel;

export type CodexSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
export type CodexApprovalPolicy = 'never' | 'on-request' | 'on-failure' | 'untrusted';

const SANDBOX_MODES: readonly string[] = ['read-only', 'workspace-write', 'danger-full-access'];
const APPROVAL_POLICIES: readonly string[] = ['never', 'on-request', 'on-failure', 'untrusted'];

export interface CodexModelConfig {
  /** Undefined means「跟随 CLI 默认模型」; the workbench never invents model names. */
  model?: string;
}

/**
 * 自定义模型提供方（如 Kimi for Coding）。settings.json 声明：
 * `modelProvider` 选定 id，`providers.<id>` 用 camelCase 声明字段，
 * 这里转换成 Codex CLI `--config` 需要的 snake_case model_providers 表。
 */
export interface CodexProviderConfig {
  /** 传给 `new Codex({ config })` 的 --config 覆盖（model_provider + model_providers.*）。 */
  config: NonNullable<CodexOptions['config']>;
  /** CLI 从该环境变量读取 API key（如 KIMI_API_KEY），由 SDK 注入子进程环境。 */
  envKey?: string;
}

export interface CodexSandboxConfig {
  sandboxMode: CodexSandboxMode;
  approvalPolicy: CodexApprovalPolicy;
}

/**
 * settings.json 按 path+mtimeMs 缓存（与 session-store 的 rolloutCache 同款思路）：
 * chat/meta 路由每请求要读 2-3 次配置，mtime 不变时直接复用上次的解析结果。
 */
const settingsCache = new Map<string, { mtimeMs: number; parsed: Record<string, unknown> }>();

export function readCodexSettings(cwd: string): Record<string, unknown> {
  const path = resolve(cwd, '.codex/settings.json');
  let mtimeMs: number;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    settingsCache.delete(path);
    return {};
  }
  const cached = settingsCache.get(path);
  if (cached && cached.mtimeMs === mtimeMs) return cached.parsed;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    settingsCache.set(path, { mtimeMs, parsed });
    return parsed;
  } catch {
    // Environment variables and the CLI defaults remain the contract.
    return {};
  }
}

/** Walks up from process.cwd() looking for a .codex/ project root. */
export function getCodexProjectRoot(): string {
  const candidate = process.cwd();
  for (const current of [candidate, resolve(candidate, '..'), resolve(candidate, '../..')]) {
    if (existsSync(resolve(current, '.codex'))) return current;
  }
  return resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
}

export function getCodexModelConfig(
  overrides: { model?: string } = {},
  cwd = getCodexProjectRoot(),
): CodexModelConfig {
  const settings = readCodexSettings(cwd) as { defaultModel?: unknown };
  const configured =
    typeof settings.defaultModel === 'string' && settings.defaultModel.trim()
      ? settings.defaultModel.trim()
      : undefined;
  const model = overrides.model ?? process.env.CODEX_MODEL?.trim() ?? configured;
  return model ? { model } : {};
}

/**
 * 解析自定义 model provider：env `CODEX_MODEL_PROVIDER` → settings `modelProvider`。
 * 未配置返回 undefined（走 CLI 默认的 OpenAI 提供方与登录态）；配置但 providers
 * 表缺定义/缺 baseUrl 时直接抛错，避免 CLI 收到半截配置报出难懂的错。
 * settings 级可选项：`webSearch`（透传 CLI 顶层 web_search，如 "disabled"——
 * 第三方端点大多不认识 codex 注入的原生 web_search 工具）和 `modelCatalog`
 *（模型元数据目录 JSON 路径，相对 repo 根；提供上下文窗口/搜索能力等元数据，
 * 消除 "Model metadata not found" 警告并按 supports_search_tool 控制工具注入）。
 */
export function getCodexProviderConfig(
  cwd = getCodexProjectRoot(),
  model?: string,
): CodexProviderConfig | undefined {
  const settings = readCodexSettings(cwd) as {
    modelProvider?: unknown;
    providers?: unknown;
    models?: unknown;
    webSearch?: unknown;
    modelCatalog?: unknown;
  };
  const modelProvider = Array.isArray(settings.models)
    ? settings.models.find(
        (entry): entry is { id?: unknown; provider?: unknown } =>
          Boolean(entry) && typeof entry === 'object' && (entry as { id?: unknown }).id === model,
      )?.provider
    : undefined;
  const provider =
    process.env.CODEX_MODEL_PROVIDER?.trim() ||
    (typeof modelProvider === 'string' ? modelProvider.trim() : '') ||
    (typeof settings.modelProvider === 'string' ? settings.modelProvider.trim() : '');
  // "openai" is the workbench label for Codex CLI's built-in OpenAI provider.
  if (!provider || provider === 'openai') return undefined;

  const table =
    settings.providers && typeof settings.providers === 'object'
      ? (settings.providers as Record<string, unknown>)
      : {};
  const raw = table[provider];
  if (!raw || typeof raw !== 'object') {
    throw new Error(`模型提供方未在 .codex/settings.json 的 providers 中定义：${provider}`);
  }
  const entry = raw as { name?: unknown; baseUrl?: unknown; envKey?: unknown; wireApi?: unknown };
  if (typeof entry.baseUrl !== 'string' || !entry.baseUrl.trim()) {
    throw new Error(
      `模型提供方 ${provider} 缺少 baseUrl（.codex/settings.json providers.${provider}）`,
    );
  }
  const wireApi = entry.wireApi;
  // codex CLI ≥0.144 移除了 wire_api = "chat"：缺省或任何非 "responses" 的值一律
  // 抛错（与缺 baseUrl 同级），不再静默回退成 CLI 会拒绝的配置。
  if (wireApi !== 'responses') {
    throw new Error(
      `模型提供方 ${provider} 的 wireApi 必须为 "responses"（codex CLI ≥0.144 只支持 Responses API）`,
    );
  }
  const definition: NonNullable<CodexOptions['config']> = {
    name: typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : provider,
    base_url: entry.baseUrl.trim(),
    wire_api: 'responses',
  };
  const envKey =
    typeof entry.envKey === 'string' && entry.envKey.trim() ? entry.envKey.trim() : undefined;
  if (envKey) definition.env_key = envKey;

  const config: NonNullable<CodexOptions['config']> = {
    model_provider: provider,
    model_providers: { [provider]: definition },
  };
  if (typeof settings.webSearch === 'string' && settings.webSearch.trim()) {
    config.web_search = settings.webSearch.trim();
  }
  if (typeof settings.modelCatalog === 'string' && settings.modelCatalog.trim()) {
    config.model_catalog_json = resolve(cwd, settings.modelCatalog.trim());
  }

  return {
    config,
    ...(envKey ? { envKey } : {}),
  };
}

/**
 * CODEX_AGENT_ENABLED 的统一判定：'true'/'1'/'yes'（大小写不敏感）为真，
 * 其余（含未设置）为假。apps/api 的 env-schema 声明与这里的 runAgentTurn 共用本函数。
 */
export function isCodexAgentEnabled(value: string | undefined): boolean {
  return value !== undefined && ['true', '1', 'yes'].includes(value.trim().toLowerCase());
}

export function getCodexReasoningEffort(
  level?: CodexReasoningEffort,
  cwd = getCodexProjectRoot(),
): CodexReasoningEffort {
  if (level) return level;
  const configured = process.env.CODEX_REASONING_EFFORT;
  if (configured && (AGENT_THINKING_LEVELS as readonly string[]).includes(configured))
    return configured as CodexReasoningEffort;
  const settings = readCodexSettings(cwd) as { defaultReasoningEffort?: unknown };
  if (
    typeof settings.defaultReasoningEffort === 'string' &&
    (AGENT_THINKING_LEVELS as readonly string[]).includes(settings.defaultReasoningEffort)
  ) {
    return settings.defaultReasoningEffort as CodexReasoningEffort;
  }
  return 'medium';
}

/**
 * Web 会话默认锁死在只读沙箱 + 永不请求审批（HITL 审批不在本次移植范围）；
 * 环境变量与 settings.json 可显式放宽。
 */
export function getCodexSandboxConfig(cwd = getCodexProjectRoot()): CodexSandboxConfig {
  const settings = readCodexSettings(cwd) as { sandboxMode?: unknown; approvalPolicy?: unknown };
  const envSandbox = process.env.CODEX_SANDBOX_MODE;
  const envApproval = process.env.CODEX_APPROVAL_POLICY;
  const sandboxMode = SANDBOX_MODES.includes(envSandbox ?? '')
    ? (envSandbox as CodexSandboxMode)
    : SANDBOX_MODES.includes(String(settings.sandboxMode))
      ? (settings.sandboxMode as CodexSandboxMode)
      : 'read-only';
  const approvalPolicy = APPROVAL_POLICIES.includes(envApproval ?? '')
    ? (envApproval as CodexApprovalPolicy)
    : APPROVAL_POLICIES.includes(String(settings.approvalPolicy))
      ? (settings.approvalPolicy as CodexApprovalPolicy)
      : 'never';
  return { sandboxMode, approvalPolicy };
}

/**
 * Model catalog for the Web picker: only what .codex/settings.json declares in
 * `models` (`[{id, name}]`). Falls back to the single configured current model;
 * the CLI's own default is reported as an empty catalog rather than invented.
 */
export function listCodexModels(cwd = getCodexProjectRoot()): Array<{ id: string; name: string }> {
  const settings = readCodexSettings(cwd) as { models?: unknown };
  if (Array.isArray(settings.models)) {
    const models = settings.models
      .map((entry) => {
        const record =
          entry && typeof entry === 'object' ? (entry as { id?: unknown; name?: unknown }) : {};
        return typeof record.id === 'string' && record.id.trim()
          ? {
              id: record.id.trim(),
              name:
                typeof record.name === 'string' && record.name.trim()
                  ? record.name.trim()
                  : record.id.trim(),
            }
          : undefined;
      })
      .filter((model): model is { id: string; name: string } => Boolean(model));
    if (models.length) return models;
  }
  const { model } = getCodexModelConfig({}, cwd);
  return model ? [{ id: model, name: model }] : [];
}
