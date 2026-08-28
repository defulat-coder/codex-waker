import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from './app.js';
import type { AppConfig } from './config.js';

const config: AppConfig = {
  PORT: 4310,
  HOST: '127.0.0.1',
  WEB_ORIGIN: 'http://localhost:5173',
  CODEX_AGENT_ENABLED: false,
  LOG_LEVEL: 'error',
};

describe('files endpoints', () => {
  const root = mkdtempSync(join(tmpdir(), 'codex-api-files-'));
  mkdirSync(join(root, 'src', 'lib'), { recursive: true });
  writeFileSync(join(root, 'README.md'), '# 示例项目\n\n只读浏览。\n');
  writeFileSync(join(root, 'src', 'index.ts'), 'export const x = 1;\n');
  writeFileSync(join(root, 'src', 'lib', 'util.ts'), 'export const y = 2;\n');
  writeFileSync(join(root, '.env'), 'SECRET=do-not-serve\n');
  writeFileSync(join(root, 'binary.bin'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d]));
  mkdirSync(join(root, '.git'));
  mkdirSync(join(root, 'node_modules'));
  symlinkSync(tmpdir(), join(root, 'escape-link'));

  const app = buildApp(config, { cwd: root });

  before(async () => app.ready());
  after(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('GET /files lists the repo root with directories first and denied names hidden', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/files' });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.path, '');
    const names = body.entries.map((entry: { name: string }) => entry.name);
    // 启动时 AgentSessionStore 会建好 .codex/（workbench.sqlite 落在此处），目录优先列出。
    assert.deepEqual(names, ['.codex', 'src', 'binary.bin', 'README.md']);
    assert.equal(body.entries[0].kind, 'directory');
    assert.equal(body.entries[0].size, 0);
    assert.equal(body.entries[2].kind, 'file');
    assert.ok(body.entries[2].size > 0);
  });

  it('GET /files?path= lists a subdirectory and returns the relative path', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/files?path=src' });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.path, 'src');
    assert.deepEqual(
      body.entries.map((entry: { name: string }) => entry.name),
      ['lib', 'index.ts'],
    );
  });

  it('GET /files/content returns text content untruncated', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/files/content?path=${encodeURIComponent('src/index.ts')}`,
    });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.path, 'src/index.ts');
    assert.equal(body.content, 'export const x = 1;\n');
    assert.equal(body.truncated, false);
  });

  it('rejects path escapes and absolute paths with 400', async () => {
    for (const path of ['../outside', 'src/../../outside', '/etc/passwd', 'escape-link']) {
      const list = await app.inject({
        method: 'GET',
        url: `/api/v1/files?path=${encodeURIComponent(path)}`,
      });
      assert.equal(list.statusCode, 400, `list ${path}`);
      const content = await app.inject({
        method: 'GET',
        url: `/api/v1/files/content?path=${encodeURIComponent(path)}`,
      });
      assert.equal(content.statusCode, 400, `content ${path}`);
    }
  });

  it('rejects denied names (.env, .git, node_modules, key files) with 400', async () => {
    for (const path of ['.env', '.git', 'node_modules', 'id_rsa', 'cert.pem', 'tls.key']) {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/files/content?path=${encodeURIComponent(path)}`,
      });
      assert.equal(response.statusCode, 400, path);
    }
  });

  it('returns 404 for missing paths and 400 when content targets a directory', async () => {
    const missing = await app.inject({
      method: 'GET',
      url: '/api/v1/files/content?path=no-such-file.md',
    });
    assert.equal(missing.statusCode, 404);
    const missingDir = await app.inject({ method: 'GET', url: '/api/v1/files?path=no-such-dir' });
    assert.equal(missingDir.statusCode, 404);
    const directory = await app.inject({
      method: 'GET',
      url: '/api/v1/files/content?path=src',
    });
    assert.equal(directory.statusCode, 400);
    const fileAsDir = await app.inject({ method: 'GET', url: '/api/v1/files?path=README.md' });
    assert.equal(fileAsDir.statusCode, 400);
  });

  it('returns 415 for binary content', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/files/content?path=binary.bin',
    });
    assert.equal(response.statusCode, 415);
  });
});
