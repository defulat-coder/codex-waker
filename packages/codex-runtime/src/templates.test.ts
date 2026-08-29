import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listAgentTemplates } from './templates.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const VALID = `---
name: 测试模板
mark: 模
tagline: 模板角色
description: 模板描述。
suggestions:
  - 你好
---

你是模板角色。
`;

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'codex-agent-templates-'));
  roots.push(root);
  mkdirSync(join(root, '.codex', 'agent-templates'), { recursive: true });
  return root;
}

describe('agent templates', () => {
  it('returns an empty list when .codex/agent-templates is absent', () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-agent-templates-empty-'));
    roots.push(root);
    assert.deepEqual(listAgentTemplates(root), []);
  });

  it('parses template files sorted by filename and skips broken ones', () => {
    const root = fixtureRoot();
    writeFileSync(join(root, '.codex', 'agent-templates', 'beta-template.md'), VALID);
    writeFileSync(
      join(root, '.codex', 'agent-templates', 'alpha-template.md'),
      VALID.replace('测试模板', '甲模板').replace(
        'mark: 模',
        'mark: 模\navatar: alpha-template.avatar.jpg',
      ),
    );
    writeFileSync(
      join(root, '.codex', 'agent-templates', 'alpha-template.avatar.jpg'),
      Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
    );
    writeFileSync(
      join(root, '.codex', 'agent-templates', 'broken-template.md'),
      VALID.replace('name: 测试模板\n', ''),
    );
    const templates = listAgentTemplates(root);
    assert.deepEqual(
      templates.map((template) => template.id),
      ['alpha-template', 'beta-template'],
    );
    const alpha = templates[0]!;
    assert.equal(alpha.name, '甲模板');
    assert.equal(alpha.mark, '模');
    assert.equal(alpha.tagline, '模板角色');
    assert.equal(alpha.hasAvatar, true);
    assert.deepEqual(alpha.suggestions, ['你好']);
    assert.equal(alpha.body, '你是模板角色。');
    // AgentTemplate 不携带磁盘路径。
    assert.equal('path' in alpha, false);
  });

  it('ships parseable repo templates with unique valid ids', () => {
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');
    const templates = listAgentTemplates(repoRoot);
    assert.ok(templates.length >= 4);
    const ids = templates.map((template) => template.id);
    assert.equal(new Set(ids).size, ids.length);
    assert.ok(ids.includes('translator-pro'));
    for (const template of templates) {
      assert.match(template.id, /^[a-z][a-z0-9-]{1,63}$/);
      assert.ok(template.body.trim().length > 0);
      assert.ok(template.suggestions.length > 0);
      assert.equal(template.hasAvatar, true, `${template.id} 缺少头像`);
      // 仓库模板都携带真实的关于我区块（我最擅长 / 工作风格）。
      assert.ok(template.strengths && template.strengths.length > 0, `${template.id} 缺少 strengths`);
      assert.ok(
        template.workStyles && template.workStyles.length > 0,
        `${template.id} 缺少 workStyles`,
      );
    }
  });
});
