import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AgentCreateError,
  createAgent,
  deleteAgent,
  deriveAgentId,
  getAgent,
  importAgent,
  listInstalledSkills,
  listPrompts,
  listSkills,
  loadAgents,
  readAppendSystem,
  readAgentSource,
  readInstalledSkillContent,
  readPrompt,
  removeProjectSkill,
  SkillUploadError,
  updateAgent,
  uploadSkill,
  writeAppendSystem,
  writePrompt,
} from './agents.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'codex-agents-'));
  roots.push(root);
  mkdirSync(join(root, '.codex', 'agents'), { recursive: true });
  return root;
}

const VALID = `---
name: 测试助手
mark: 测
tagline: 测试
description: 测试用 agent。
suggestions:
  - 你好
---

你是测试助手。
`;

describe('agent registry', () => {
  it('loads the project agent definitions sorted by filename', () => {
    const root = fixtureRoot();
    writeFileSync(join(root, '.codex', 'agents', 'beta-agent.md'), VALID);
    writeFileSync(
      join(root, '.codex', 'agents', 'alpha-agent.md'),
      VALID.replace('测试助手', '甲'),
    );
    const agents = loadAgents(root);
    assert.deepEqual(
      agents.map((agent) => agent.id),
      ['alpha-agent', 'beta-agent'],
    );
    assert.equal(agents[0]?.name, '甲');
    assert.equal(agents[0]?.path, '.codex/agents/alpha-agent.md');
    assert.deepEqual(agents[0]?.suggestions, ['你好']);
    assert.equal(agents[0]?.body, '你是测试助手。');
  });

  it('returns an empty list when .codex/agents is absent', () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-agents-empty-'));
    roots.push(root);
    assert.deepEqual(loadAgents(root), []);
  });

  it('skips files with missing frontmatter fields instead of failing the whole list', () => {
    const root = fixtureRoot();
    writeFileSync(join(root, '.codex', 'agents', 'good-agent.md'), VALID);
    writeFileSync(
      join(root, '.codex', 'agents', 'broken-agent.md'),
      VALID.replace('name: 测试助手\n', ''),
    );
    assert.deepEqual(
      loadAgents(root).map((agent) => agent.id),
      ['good-agent'],
    );
    // getAgent 保持不变：坏文件按不存在处理，照常抛错。
    assert.throws(() => getAgent(root, 'broken-agent'), /不存在/);
  });

  it('skips files without a system prompt body', () => {
    const root = fixtureRoot();
    writeFileSync(join(root, '.codex', 'agents', 'good-agent.md'), VALID);
    writeFileSync(
      join(root, '.codex', 'agents', 'empty-agent.md'),
      VALID.replace('你是测试助手。', ''),
    );
    assert.deepEqual(
      loadAgents(root).map((agent) => agent.id),
      ['good-agent'],
    );
  });

  it('skips files with invalid suggestions', () => {
    const root = fixtureRoot();
    writeFileSync(join(root, '.codex', 'agents', 'good-agent.md'), VALID);
    writeFileSync(
      join(root, '.codex', 'agents', 'bad-suggestions.md'),
      VALID.replace('suggestions:\n  - 你好', 'suggestions: 你好'),
    );
    assert.deepEqual(
      loadAgents(root).map((agent) => agent.id),
      ['good-agent'],
    );
  });

  it('skips filenames that are not valid agent ids', () => {
    const root = fixtureRoot();
    writeFileSync(join(root, '.codex', 'agents', 'good-agent.md'), VALID);
    writeFileSync(join(root, '.codex', 'agents', 'Bad Agent.md'), VALID);
    assert.deepEqual(
      loadAgents(root).map((agent) => agent.id),
      ['good-agent'],
    );
  });
});

describe('prompt templates', () => {
  function promptRoot(): string {
    const root = fixtureRoot();
    mkdirSync(join(root, '.codex', 'prompts'), { recursive: true });
    writeFileSync(
      join(root, '.codex', 'prompts', 'explain.md'),
      '---\ndescription: 解释概念\n---\n\n请解释这个概念。\n',
    );
    return root;
  }

  it('lists project prompts with metadata', () => {
    const prompts = listPrompts(promptRoot());
    const explain = prompts.find((prompt) => prompt.name === 'explain');
    assert.ok(explain);
    assert.equal(explain.path, '.codex/prompts/explain.md');
    assert.equal(explain.description, '解释概念');
    assert.ok(explain.preview && !explain.preview.startsWith('---'));
  });

  it('reads a prompt body without frontmatter and rejects traversal names', () => {
    const root = promptRoot();
    const document = readPrompt(root, 'explain');
    assert.ok(document);
    assert.ok(!document.content.startsWith('---'));
    assert.match(document.content, /请解释/);
    assert.equal(readPrompt(root, '../settings'), undefined);
    assert.equal(readPrompt(root, 'missing-prompt'), undefined);
  });
});

describe('writePrompt', () => {
  const PROMPT = '---\ndescription: 旧描述\nargument-hint: "<概念>"\n---\n\n旧正文。\n';

  function promptRoot(): string {
    const root = fixtureRoot();
    mkdirSync(join(root, '.codex', 'prompts'), { recursive: true });
    writeFileSync(join(root, '.codex', 'prompts', 'edit-me.md'), PROMPT);
    return root;
  }

  it('rewrites the body and keeps the other frontmatter fields', () => {
    const root = promptRoot();
    const document = writePrompt(root, 'edit-me', { content: '新正文。' });
    assert.equal(document.content, '新正文。');
    assert.equal(document.description, '旧描述');
    const raw = readFileSync(join(root, '.codex', 'prompts', 'edit-me.md'), 'utf8');
    assert.match(raw, /argument-hint/);
    assert.equal(readPrompt(root, 'edit-me')?.content, '新正文。');
  });

  it('updates the frontmatter description when provided', () => {
    const root = promptRoot();
    const document = writePrompt(root, 'edit-me', { content: '新正文。', description: '新描述' });
    assert.equal(document.description, '新描述');
    assert.equal(
      listPrompts(root).find((prompt) => prompt.name === 'edit-me')?.description,
      '新描述',
    );
  });

  it('throws NOT_FOUND for a missing prompt without creating a file', () => {
    const root = promptRoot();
    assert.throws(
      () => writePrompt(root, 'ghost', { content: '正文' }),
      (error: unknown) => error instanceof AgentCreateError && error.code === 'NOT_FOUND',
    );
    assert.equal(existsSync(join(root, '.codex', 'prompts', 'ghost.md')), false);
  });

  it('rejects traversal names and empty bodies', () => {
    const root = promptRoot();
    assert.throws(
      () => writePrompt(root, '../settings', { content: '正文' }),
      (error: unknown) => error instanceof AgentCreateError && error.code === 'INVALID_ID',
    );
    assert.throws(
      () => writePrompt(root, 'edit-me', { content: '   ' }),
      (error: unknown) => error instanceof AgentCreateError && error.code === 'INVALID_FIELD',
    );
  });
});

describe('append-system file', () => {
  it('reads null when the file is absent', () => {
    assert.equal(readAppendSystem(fixtureRoot()), null);
  });

  it('writes atomically and reads back the normalized content', () => {
    const root = fixtureRoot();
    assert.equal(writeAppendSystem(root, '  全局规则。\n'), '全局规则。');
    assert.equal(readAppendSystem(root), '全局规则。');
  });

  it('deletes the file on empty content', () => {
    const root = fixtureRoot();
    writeAppendSystem(root, '全局规则。');
    assert.ok(existsSync(join(root, '.codex', 'APPEND_SYSTEM.md')));
    assert.equal(writeAppendSystem(root, '   '), null);
    assert.equal(existsSync(join(root, '.codex', 'APPEND_SYSTEM.md')), false);
    assert.equal(readAppendSystem(root), null);
  });
});

describe('createAgent', () => {
  const input = {
    name: '翻译助手 Pro',
    mark: '译',
    tagline: '双语互译',
    description: '在中英文之间互译，保留语气。',
    suggestions: ['把这段话译成英文'],
    body: '你是翻译助手，专注中英互译。',
  };

  it('writes .codex/agents/<id>.md with parseable frontmatter', () => {
    const root = fixtureRoot();
    const agent = createAgent(root, { ...input, id: 'translator-pro' });
    assert.equal(agent.id, 'translator-pro');
    assert.equal(agent.path, '.codex/agents/translator-pro.md');
    const reloaded = getAgent(root, 'translator-pro');
    assert.equal(reloaded.name, input.name);
    assert.deepEqual(reloaded.suggestions, input.suggestions);
    assert.equal(reloaded.body, input.body);
  });

  it('derives the id from ascii names and rejects underivable ones', () => {
    assert.equal(deriveAgentId('Code Review Bot'), 'code-review-bot');
    assert.equal(deriveAgentId('翻译助手'), undefined);
    const root = fixtureRoot();
    const agent = createAgent(root, { ...input, name: 'Brainstorm Buddy' });
    assert.equal(agent.id, 'brainstorm-buddy');
    assert.throws(
      () => createAgent(root, { ...input, name: '翻译助手' }),
      (error: unknown) => error instanceof AgentCreateError && error.code === 'INVALID_ID',
    );
    assert.throws(
      () => createAgent(root, { ...input, id: 'Bad Id' }),
      (error: unknown) => error instanceof AgentCreateError && error.code === 'INVALID_ID',
    );
  });

  it('rejects conflicts without overwriting the existing file', () => {
    const root = fixtureRoot();
    writeFileSync(join(root, '.codex', 'agents', 'taken.md'), VALID);
    assert.throws(
      () => createAgent(root, { ...input, id: 'taken' }),
      (error: unknown) => error instanceof AgentCreateError && error.code === 'CONFLICT',
    );
    assert.equal(readFileSync(join(root, '.codex', 'agents', 'taken.md'), 'utf8'), VALID);
  });

  it('rejects oversized bodies and multiline frontmatter fields', () => {
    const root = fixtureRoot();
    assert.throws(
      () => createAgent(root, { ...input, id: 'big-body', body: '长'.repeat(40 * 1024) }),
      (error: unknown) => error instanceof AgentCreateError && error.code === 'TOO_LARGE',
    );
    assert.throws(
      () => createAgent(root, { ...input, id: 'bad-name', name: '两行\n名称' }),
      (error: unknown) => error instanceof AgentCreateError && error.code === 'INVALID_FIELD',
    );
  });

  it('imports, exports, and deletes a complete Markdown definition', () => {
    const root = fixtureRoot();
    const imported = importAgent(root, { id: 'imported-agent', content: VALID });
    assert.equal(imported.name, '测试助手');
    assert.match(readAgentSource(root, 'imported-agent'), /name: "测试助手"/);
    deleteAgent(root, 'imported-agent');
    assert.equal(existsSync(join(root, '.codex', 'agents', 'imported-agent.md')), false);
  });

  it('rejects malformed imports without writing a file', () => {
    const root = fixtureRoot();
    assert.throws(
      () => importAgent(root, { id: 'bad-import', content: '# missing frontmatter' }),
      (error: unknown) => error instanceof AgentCreateError && error.code === 'INVALID_FIELD',
    );
    assert.equal(existsSync(join(root, '.codex', 'agents', 'bad-import.md')), false);
  });
});

describe('updateAgent', () => {
  it('updates the patched fields and keeps the rest', () => {
    const root = fixtureRoot();
    writeFileSync(join(root, '.codex', 'agents', 'translator-pro.md'), VALID);
    const updated = updateAgent(root, 'translator-pro', {
      name: '改名助手',
      body: '你是改名后的助手。',
    });
    assert.equal(updated.name, '改名助手');
    assert.equal(updated.body, '你是改名后的助手。');
    const reloaded = getAgent(root, 'translator-pro');
    assert.equal(reloaded.name, '改名助手');
    assert.equal(reloaded.mark, '测');
    assert.equal(reloaded.tagline, '测试');
    assert.equal(reloaded.description, '测试用 agent。');
    assert.deepEqual(reloaded.suggestions, ['你好']);
  });

  it('replaces suggestions wholesale', () => {
    const root = fixtureRoot();
    writeFileSync(join(root, '.codex', 'agents', 'translator-pro.md'), VALID);
    const updated = updateAgent(root, 'translator-pro', { suggestions: ['新问题一', '新问题二'] });
    assert.deepEqual(updated.suggestions, ['新问题一', '新问题二']);
  });

  it('throws NOT_FOUND for a missing agent without creating a file', () => {
    const root = fixtureRoot();
    assert.throws(
      () => updateAgent(root, 'ghost-agent', { name: '幽灵' }),
      (error: unknown) => error instanceof AgentCreateError && error.code === 'NOT_FOUND',
    );
    assert.deepEqual(loadAgents(root), []);
  });

  it('rejects invalid ids and invalid fields with the create rules', () => {
    const root = fixtureRoot();
    writeFileSync(join(root, '.codex', 'agents', 'translator-pro.md'), VALID);
    assert.throws(
      () => updateAgent(root, 'Bad Id', { name: 'x' }),
      (error: unknown) => error instanceof AgentCreateError && error.code === 'INVALID_ID',
    );
    assert.throws(
      () => updateAgent(root, 'translator-pro', { name: '两行\n名称' }),
      (error: unknown) => error instanceof AgentCreateError && error.code === 'INVALID_FIELD',
    );
    assert.throws(
      () => updateAgent(root, 'translator-pro', { suggestions: [] }),
      (error: unknown) => error instanceof AgentCreateError && error.code === 'INVALID_FIELD',
    );
    assert.throws(
      () => updateAgent(root, 'translator-pro', { body: '长'.repeat(40 * 1024) }),
      (error: unknown) => error instanceof AgentCreateError && error.code === 'TOO_LARGE',
    );
    // A failed update must not touch the existing file.
    assert.equal(getAgent(root, 'translator-pro').name, '测试助手');
  });
});

describe('listSkills', () => {
  it('returns an empty list when .codex/skills is absent or empty', () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-skills-empty-'));
    roots.push(root);
    assert.deepEqual(listSkills(root), []);
    mkdirSync(join(root, '.codex', 'skills'), { recursive: true });
    assert.deepEqual(listSkills(root), []);
  });

  it('lists SKILL.md entries with frontmatter metadata and body preview', () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-skills-'));
    roots.push(root);
    mkdirSync(join(root, '.codex', 'skills', 'research'), { recursive: true });
    writeFileSync(
      join(root, '.codex', 'skills', 'research', 'SKILL.md'),
      `---\nname: 调研助手\ndescription: 按来源做桌面调研。\n---\n\n先搜一手来源，再写结论。\n`,
    );
    mkdirSync(join(root, '.codex', 'skills', 'no-frontmatter'), { recursive: true });
    writeFileSync(join(root, '.codex', 'skills', 'no-frontmatter', 'SKILL.md'), '只有正文。');
    const skills = listSkills(root);
    assert.deepEqual(
      skills.map((skill) => skill.name),
      ['no-frontmatter', '调研助手'],
    );
    const research = skills.find((skill) => skill.name === '调研助手');
    assert.equal(research?.path, '.codex/skills/research/SKILL.md');
    assert.equal(research?.description, '按来源做桌面调研。');
    assert.equal(research?.preview, '先搜一手来源，再写结论。');
    const plain = skills.find((skill) => skill.path.includes('no-frontmatter'));
    assert.equal(plain?.name, 'no-frontmatter');
    assert.equal(plain?.preview, '只有正文。');
  });
});

describe('listInstalledSkills', () => {
  it('returns an empty list when both skill directories are absent', () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-installed-skills-empty-'));
    roots.push(root);
    assert.deepEqual(listInstalledSkills(root), []);
  });

  it('lists .agents/skills and .codex/skills with scope and lockfile source', () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-installed-skills-'));
    roots.push(root);
    mkdirSync(join(root, '.agents', 'skills', 'web-research'), { recursive: true });
    writeFileSync(
      join(root, '.agents', 'skills', 'web-research', 'SKILL.md'),
      `---\nname: web-research\ndescription: 联网调研。\n---\n\n先搜索再总结。\n`,
    );
    mkdirSync(join(root, '.codex', 'skills', 'local-skill'), { recursive: true });
    writeFileSync(join(root, '.codex', 'skills', 'local-skill', 'SKILL.md'), '只有正文。');
    writeFileSync(
      join(root, 'skills-lock.json'),
      JSON.stringify({
        version: 1,
        skills: {
          'web-research': {
            source: 'acme/skills',
            sourceType: 'github',
            skillPath: 'skills/web-research/SKILL.md',
            computedHash: 'abc',
          },
        },
      }),
    );
    const items = listInstalledSkills(root);
    assert.deepEqual(
      items.map((item) => item.name),
      ['web-research', 'local-skill'],
    );
    const agents = items.find((item) => item.scope === 'agents');
    assert.equal(agents?.path, '.agents/skills/web-research/SKILL.md');
    assert.equal(agents?.source, 'acme/skills');
    assert.equal(agents?.description, '联网调研。');
    assert.equal(agents?.preview, '先搜索再总结。');
    const codex = items.find((item) => item.scope === 'codex');
    assert.equal(codex?.path, '.codex/skills/local-skill/SKILL.md');
    assert.equal(codex?.source, undefined);
    assert.equal(codex?.preview, '只有正文。');
  });

  it('survives a missing or malformed lockfile', () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-installed-skills-lock-'));
    roots.push(root);
    mkdirSync(join(root, '.agents', 'skills', 'solo'), { recursive: true });
    writeFileSync(
      join(root, '.agents', 'skills', 'solo', 'SKILL.md'),
      '---\nname: solo\n---\n\n正文。\n',
    );
    assert.deepEqual(
      listInstalledSkills(root).map((item) => item.source),
      [undefined],
    );
    writeFileSync(join(root, 'skills-lock.json'), '{ not json');
    assert.deepEqual(
      listInstalledSkills(root).map((item) => item.source),
      [undefined],
    );
  });
});

describe('readInstalledSkillContent', () => {
  function contentRoot(): string {
    const root = mkdtempSync(join(tmpdir(), 'codex-skill-content-'));
    roots.push(root);
    mkdirSync(join(root, '.agents', 'skills', 'web-research'), { recursive: true });
    writeFileSync(
      join(root, '.agents', 'skills', 'web-research', 'SKILL.md'),
      `---\nname: web-research\ndescription: 联网调研。\n---\n\n## 步骤\n\n1. 先搜索。\n2. 再总结。\n`,
    );
    mkdirSync(join(root, '.codex', 'skills', 'plain'), { recursive: true });
    writeFileSync(
      join(root, '.codex', 'skills', 'plain', 'SKILL.md'),
      '没有 frontmatter 的正文。\n',
    );
    return root;
  }

  it('returns the full body with frontmatter stripped plus the raw frontmatter text', () => {
    const root = contentRoot();
    const doc = readInstalledSkillContent(root, 'agents', 'web-research');
    assert.ok(doc);
    assert.equal(doc.name, 'web-research');
    assert.equal(doc.scope, 'agents');
    assert.equal(doc.description, '联网调研。');
    assert.equal(doc.content, '## 步骤\n\n1. 先搜索。\n2. 再总结。');
    assert.equal(doc.frontmatter, 'name: web-research\ndescription: 联网调研。');
  });

  it('omits frontmatter for files without one and rejects unknown or traversal names', () => {
    const root = contentRoot();
    const plain = readInstalledSkillContent(root, 'codex', 'plain');
    assert.ok(plain);
    assert.equal(plain.content, '没有 frontmatter 的正文。');
    assert.equal(plain.frontmatter, undefined);
    assert.equal(readInstalledSkillContent(root, 'agents', 'missing'), undefined);
    assert.equal(readInstalledSkillContent(root, 'agents', '../settings'), undefined);
    // name 匹配 scope：同名不同 scope 不串。
    assert.equal(readInstalledSkillContent(root, 'codex', 'web-research'), undefined);
  });
});

describe('uploadSkill', () => {
  it('writes .codex/skills/<name>/SKILL.md and returns the installed summary', () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-skill-upload-'));
    roots.push(root);
    const summary = uploadSkill(root, {
      name: 'my-skill',
      content: '---\nname: my-skill\ndescription: 手工上传。\n---\n\n## 用法\n\n照做。\n',
    });
    assert.equal(summary.name, 'my-skill');
    assert.equal(summary.scope, 'codex');
    assert.equal(summary.path, '.codex/skills/my-skill/SKILL.md');
    assert.equal(summary.description, '手工上传。');
    assert.equal(summary.preview, '## 用法 照做。');
    const written = readFileSync(join(root, '.codex', 'skills', 'my-skill', 'SKILL.md'), 'utf8');
    assert.match(written, /^---\nname: my-skill/);
  });

  it('synthesizes a frontmatter block from name/description when absent', () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-skill-upload-fm-'));
    roots.push(root);
    const summary = uploadSkill(root, {
      name: 'plain-skill',
      content: '没有 frontmatter 的正文。',
      description: '纯正文上传。',
    });
    const written = readFileSync(join(root, '.codex', 'skills', 'plain-skill', 'SKILL.md'), 'utf8');
    assert.match(written, /^---\nname: "plain-skill"\ndescription: "纯正文上传。"\n---\n\n/);
    assert.equal(summary.description, '纯正文上传。');
    assert.equal(summary.preview, '没有 frontmatter 的正文。');
    // 无 description 时 frontmatter 只有 name，也不影响解析。
    const bare = uploadSkill(root, { name: 'bare-skill', content: '只有正文。' });
    assert.equal(bare.name, 'bare-skill');
    assert.equal(bare.description, undefined);
  });

  it('rejects conflicts with CONFLICT and never overwrites', () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-skill-upload-conflict-'));
    roots.push(root);
    uploadSkill(root, { name: 'dup-skill', content: '旧内容。' });
    assert.throws(
      () => uploadSkill(root, { name: 'dup-skill', content: '新内容。' }),
      (error: unknown) => error instanceof SkillUploadError && error.code === 'CONFLICT',
    );
    assert.match(
      readFileSync(join(root, '.codex', 'skills', 'dup-skill', 'SKILL.md'), 'utf8'),
      /旧内容。/,
    );
  });

  it('rejects invalid names with INVALID_NAME and writes nothing', () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-skill-upload-name-'));
    roots.push(root);
    for (const name of ['Bad Name', 'a/b', '..', '中文名', '']) {
      assert.throws(
        () => uploadSkill(root, { name, content: '正文。' }),
        (error: unknown) => error instanceof SkillUploadError && error.code === 'INVALID_NAME',
      );
    }
    assert.deepEqual(listInstalledSkills(root), []);
  });

  it('rejects oversized content with TOO_LARGE', () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-skill-upload-large-'));
    roots.push(root);
    assert.throws(
      () => uploadSkill(root, { name: 'big-skill', content: '长'.repeat(128 * 1024) }),
      (error: unknown) => error instanceof SkillUploadError && error.code === 'TOO_LARGE',
    );
  });

  it('removes an uploaded skill through removeProjectSkill', () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-skill-remove-'));
    roots.push(root);
    uploadSkill(root, { name: 'gone-skill', content: '正文。' });
    assert.equal(removeProjectSkill(root, 'gone-skill'), true);
    assert.deepEqual(listInstalledSkills(root), []);
    assert.equal(removeProjectSkill(root, 'gone-skill'), false);
  });
});
