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
  listPrompts,
  listSkills,
  loadAgents,
  readAppendSystem,
  readAgentSource,
  readPrompt,
  updateAgent,
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
  it('returns an empty list when repo .agents/skills is absent', () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-skills-empty-'));
    roots.push(root);
    assert.deepEqual(listSkills(root), []);
    mkdirSync(join(root, '.codex', 'skills'), { recursive: true });
    assert.deepEqual(listSkills(root), []);
  });

  it('lists SKILL.md entries with frontmatter metadata and body preview', () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-skills-'));
    roots.push(root);
    mkdirSync(join(root, '.agents', 'skills', 'research'), { recursive: true });
    writeFileSync(
      join(root, '.agents', 'skills', 'research', 'SKILL.md'),
      `---\nname: research\ndescription: 按来源做桌面调研。\n---\n\n先搜一手来源，再写结论。\n`,
    );
    const skills = listSkills(root);
    assert.deepEqual(
      skills.map((skill) => skill.name),
      ['research'],
    );
    const research = skills[0];
    assert.equal(research?.path, '.agents/skills/research/SKILL.md');
    assert.equal(research?.description, '按来源做桌面调研。');
    assert.equal(research?.preview, '先搜一手来源，再写结论。');
  });
});
