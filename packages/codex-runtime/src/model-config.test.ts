import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  getCodexModelConfig,
  getCodexProviderConfig,
  getCodexReasoningEffort,
  getCodexSandboxConfig,
  isCodexAgentEnabled,
  listCodexModels,
} from './model-config.js';

const roots: string[] = [];
const ENV_KEYS = [
  'CODEX_MODEL',
  'CODEX_MODEL_PROVIDER',
  'CODEX_REASONING_EFFORT',
  'CODEX_SANDBOX_MODE',
  'CODEX_APPROVAL_POLICY',
] as const;
const savedEnv = new Map<string, string | undefined>();

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv.set(key, process.env[key]);
    delete process.env[key];
  }
});

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  savedEnv.clear();
});

function fixtureCwd(settings: Record<string, unknown>): { cwd: string; file: string } {
  const cwd = mkdtempSync(join(tmpdir(), 'codex-settings-'));
  roots.push(cwd);
  mkdirSync(join(cwd, '.codex'), { recursive: true });
  const file = join(cwd, '.codex', 'settings.json');
  writeFileSync(file, JSON.stringify(settings));
  return { cwd, file };
}

describe('settings.json mtime 缓存', () => {
  it('mtime 不变时复用缓存，文件改写（mtime 变化）后配置随之更新', () => {
    const { cwd, file } = fixtureCwd({
      defaultModel: 'gpt-5-codex',
      defaultReasoningEffort: 'low',
    });
    assert.equal(getCodexModelConfig({}, cwd).model, 'gpt-5-codex');
    assert.equal(getCodexReasoningEffort(undefined, cwd), 'low');

    // 改写配置并显式拨动 mtime，避免同毫秒写入被旧缓存命中。
    writeFileSync(
      file,
      JSON.stringify({ defaultModel: 'gpt-5.1-codex', defaultReasoningEffort: 'high' }),
    );
    const bumped = new Date(Date.now() + 5000);
    utimesSync(file, bumped, bumped);

    assert.equal(
      getCodexModelConfig({}, cwd).model,
      'gpt-5.1-codex',
      'mtime 变化后必须重读 settings.json',
    );
    assert.equal(getCodexReasoningEffort(undefined, cwd), 'high');
  });

  it('不同 cwd 的 settings.json 分别缓存、互不污染', () => {
    const alpha = fixtureCwd({ defaultModel: 'gpt-5-codex' });
    const beta = fixtureCwd({ defaultModel: 'codex-mini-latest' });
    assert.equal(getCodexModelConfig({}, alpha.cwd).model, 'gpt-5-codex');
    assert.equal(getCodexModelConfig({}, beta.cwd).model, 'codex-mini-latest');

    writeFileSync(alpha.file, JSON.stringify({ defaultModel: 'gpt-5.1-codex' }));
    const bumped = new Date(Date.now() + 5000);
    utimesSync(alpha.file, bumped, bumped);

    assert.equal(getCodexModelConfig({}, alpha.cwd).model, 'gpt-5.1-codex');
    assert.equal(
      getCodexModelConfig({}, beta.cwd).model,
      'codex-mini-latest',
      'beta 的缓存不受 alpha 改写影响',
    );
  });
});

describe('codex model/effort/sandbox resolution', () => {
  it('env wins over settings; nothing configured means CLI default (undefined)', () => {
    const { cwd } = fixtureCwd({ defaultModel: 'gpt-5-codex' });
    process.env.CODEX_MODEL = 'env-model';
    assert.equal(getCodexModelConfig({}, cwd).model, 'env-model');
    delete process.env.CODEX_MODEL;
    assert.equal(getCodexModelConfig({}, cwd).model, 'gpt-5-codex');
    assert.deepEqual(getCodexModelConfig({ model: 'explicit-model' }, cwd), {
      model: 'explicit-model',
    });

    const empty = fixtureCwd({});
    assert.deepEqual(getCodexModelConfig({}, empty.cwd), {});
  });

  it('reasoning effort falls back env → settings → medium, ignoring invalid values', () => {
    const { cwd } = fixtureCwd({ defaultReasoningEffort: 'xhigh' });
    assert.equal(getCodexReasoningEffort(undefined, cwd), 'xhigh');
    process.env.CODEX_REASONING_EFFORT = 'minimal';
    assert.equal(getCodexReasoningEffort(undefined, cwd), 'minimal');
    process.env.CODEX_REASONING_EFFORT = 'bogus';
    assert.equal(getCodexReasoningEffort(undefined, cwd), 'xhigh');
    delete process.env.CODEX_REASONING_EFFORT;
    assert.equal(getCodexReasoningEffort('low', cwd), 'low');

    const empty = fixtureCwd({ defaultReasoningEffort: 'bogus' });
    assert.equal(getCodexReasoningEffort(undefined, empty.cwd), 'medium');
  });

  it('sandbox defaults to read-only + never, overridable via env and settings', () => {
    const empty = fixtureCwd({});
    assert.deepEqual(getCodexSandboxConfig(empty.cwd), {
      sandboxMode: 'read-only',
      approvalPolicy: 'never',
    });

    const configured = fixtureCwd({ sandboxMode: 'workspace-write', approvalPolicy: 'on-failure' });
    assert.deepEqual(getCodexSandboxConfig(configured.cwd), {
      sandboxMode: 'workspace-write',
      approvalPolicy: 'on-failure',
    });

    process.env.CODEX_SANDBOX_MODE = 'danger-full-access';
    process.env.CODEX_APPROVAL_POLICY = 'bogus';
    assert.deepEqual(getCodexSandboxConfig(configured.cwd), {
      sandboxMode: 'danger-full-access',
      approvalPolicy: 'on-failure',
    });
  });

  it('lists models from settings, falling back to the configured current model only', () => {
    const withCatalog = fixtureCwd({
      defaultModel: 'gpt-5-codex',
      models: [
        { id: 'gpt-5-codex', name: 'GPT-5 Codex' },
        { id: 'codex-mini-latest' },
        { broken: true },
      ],
    });
    assert.deepEqual(listCodexModels(withCatalog.cwd), [
      { id: 'gpt-5-codex', name: 'GPT-5 Codex' },
      { id: 'codex-mini-latest', name: 'codex-mini-latest' },
    ]);

    const onlyDefault = fixtureCwd({ defaultModel: 'gpt-5-codex' });
    assert.deepEqual(listCodexModels(onlyDefault.cwd), [
      { id: 'gpt-5-codex', name: 'gpt-5-codex' },
    ]);

    // 没有任何配置时不编造模型名。
    const empty = fixtureCwd({});
    assert.deepEqual(listCodexModels(empty.cwd), []);
  });

  it('provider：未配置返回 undefined；配置后转换为 CLI 的 snake_case model_providers 表', () => {
    const empty = fixtureCwd({});
    assert.equal(getCodexProviderConfig(empty.cwd), undefined);

    const kimi = fixtureCwd({
      modelProvider: 'kimi-coding',
      providers: {
        'kimi-coding': {
          name: 'Kimi for Coding',
          baseUrl: 'https://api.kimi.com/coding/v1',
          envKey: 'KIMI_API_KEY',
          wireApi: 'responses',
        },
      },
    });
    assert.deepEqual(getCodexProviderConfig(kimi.cwd), {
      config: {
        model_provider: 'kimi-coding',
        model_providers: {
          'kimi-coding': {
            name: 'Kimi for Coding',
            base_url: 'https://api.kimi.com/coding/v1',
            wire_api: 'responses',
            env_key: 'KIMI_API_KEY',
          },
        },
      },
      envKey: 'KIMI_API_KEY',
    });

    // env 覆盖 settings 的 modelProvider；name 缺省时回退 provider id。
    const viaEnv = fixtureCwd({
      providers: { proxy: { baseUrl: 'http://127.0.0.1:8787/v1', wireApi: 'responses' } },
    });
    process.env.CODEX_MODEL_PROVIDER = 'proxy';
    assert.deepEqual(getCodexProviderConfig(viaEnv.cwd), {
      config: {
        model_provider: 'proxy',
        model_providers: {
          proxy: { name: 'proxy', base_url: 'http://127.0.0.1:8787/v1', wire_api: 'responses' },
        },
      },
    });
    delete process.env.CODEX_MODEL_PROVIDER;

    // webSearch / modelCatalog 透传为 CLI 顶层 web_search / model_catalog_json。
    const tuned = fixtureCwd({
      modelProvider: 'kimi-coding',
      providers: {
        'kimi-coding': { baseUrl: 'https://api.kimi.com/coding/v1', wireApi: 'responses' },
      },
      webSearch: 'disabled',
      modelCatalog: '.codex/model-catalog.json',
    });
    assert.deepEqual(getCodexProviderConfig(tuned.cwd), {
      config: {
        model_provider: 'kimi-coding',
        model_providers: {
          'kimi-coding': {
            name: 'kimi-coding',
            base_url: 'https://api.kimi.com/coding/v1',
            wire_api: 'responses',
          },
        },
        web_search: 'disabled',
        model_catalog_json: resolve(tuned.cwd, '.codex/model-catalog.json'),
      },
    });

    const mixed = fixtureCwd({
      modelProvider: 'kimi-coding',
      providers: {
        'kimi-coding': {
          name: 'Kimi for Coding',
          baseUrl: 'https://api.kimi.com/coding/v1',
          wireApi: 'responses',
        },
      },
      models: [
        { id: 'gpt-5.6-sol', provider: 'openai' },
        { id: 'kimi-for-coding', provider: 'kimi-coding' },
      ],
    });
    assert.equal(getCodexProviderConfig(mixed.cwd, 'gpt-5.6-sol'), undefined);
    assert.equal(
      getCodexProviderConfig(mixed.cwd, 'kimi-for-coding')?.config.model_provider,
      'kimi-coding',
    );
  });

  it('provider：providers 表缺定义或缺 baseUrl 时抛出可读错误', () => {
    const missing = fixtureCwd({ modelProvider: 'ghost' });
    assert.throws(() => getCodexProviderConfig(missing.cwd), /providers 中定义：ghost/);

    const noBaseUrl = fixtureCwd({ modelProvider: 'kimi', providers: { kimi: {} } });
    assert.throws(() => getCodexProviderConfig(noBaseUrl.cwd), /缺少 baseUrl/);
  });

  it('provider：wireApi 缺省或非 "responses" 直接抛错（codex CLI ≥0.144 只支持 Responses API）', () => {
    const legacy = fixtureCwd({
      modelProvider: 'kimi',
      providers: { kimi: { baseUrl: 'https://api.kimi.com/coding/v1', wireApi: 'chat' } },
    });
    assert.throws(() => getCodexProviderConfig(legacy.cwd), /wireApi 必须为 "responses"/);

    const missing = fixtureCwd({
      modelProvider: 'kimi',
      providers: { kimi: { baseUrl: 'https://api.kimi.com/coding/v1' } },
    });
    assert.throws(() => getCodexProviderConfig(missing.cwd), /wireApi 必须为 "responses"/);
  });
});

describe('isCodexAgentEnabled', () => {
  it("只认 'true'/'1'/'yes'（大小写不敏感），其余为假", () => {
    assert.equal(isCodexAgentEnabled('true'), true);
    assert.equal(isCodexAgentEnabled('TRUE'), true);
    assert.equal(isCodexAgentEnabled('1'), true);
    assert.equal(isCodexAgentEnabled(' Yes '), true);
    assert.equal(isCodexAgentEnabled('false'), false);
    assert.equal(isCodexAgentEnabled('0'), false);
    assert.equal(isCodexAgentEnabled(''), false);
    assert.equal(isCodexAgentEnabled(undefined), false);
  });
});
