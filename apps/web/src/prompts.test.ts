import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { PromptSummary } from '@waker/contracts';
import { filterPrompts, movePromptSelection, promptQueryFromInput } from './lib/prompts.js';

const prompts: PromptSummary[] = [
  { name: 'agent-chat', path: '.codex/prompts/agent-chat.md', description: '和 Agent 对话的引导' },
  { name: 'explain', path: '.codex/prompts/explain.md', description: '解释一段代码或概念' },
  { name: 'review-code', path: '.codex/prompts/review-code.md', description: '审查代码' },
];

describe('filterPrompts', () => {
  it('空查询返回全部', () => {
    assert.deepEqual(
      filterPrompts(prompts, '').map((p) => p.name),
      ['agent-chat', 'explain', 'review-code'],
    );
    assert.deepEqual(
      filterPrompts(prompts, '   ').map((p) => p.name),
      ['agent-chat', 'explain', 'review-code'],
    );
  });

  it('按名称子串过滤，大小写不敏感', () => {
    assert.deepEqual(
      filterPrompts(prompts, 'AGENT').map((p) => p.name),
      ['agent-chat'],
    );
    assert.deepEqual(
      filterPrompts(prompts, 'chat').map((p) => p.name),
      ['agent-chat'],
    );
  });

  it('名称前缀匹配排在子串匹配之前', () => {
    const list: PromptSummary[] = [
      { name: 'code-review', path: 'a.md' },
      { name: 'review-code', path: 'b.md' },
    ];
    assert.deepEqual(
      filterPrompts(list, 'review').map((p) => p.name),
      ['review-code', 'code-review'],
    );
  });

  it('描述也参与匹配', () => {
    assert.deepEqual(
      filterPrompts(prompts, '代码').map((p) => p.name),
      ['explain', 'review-code'],
    );
  });

  it('无匹配返回空数组', () => {
    assert.deepEqual(filterPrompts(prompts, 'zzz'), []);
  });
});

describe('promptQueryFromInput', () => {
  it('以 / 开头的输入提取查询', () => {
    assert.equal(promptQueryFromInput('/'), '');
    assert.equal(promptQueryFromInput('/exp'), 'exp');
  });

  it('非 / 开头或含空格/换行时关闭面板', () => {
    assert.equal(promptQueryFromInput('hello'), null);
    assert.equal(promptQueryFromInput('/explain 这段代码'), null);
    assert.equal(promptQueryFromInput('/a\nb'), null);
  });
});

describe('movePromptSelection', () => {
  it('向下/向上循环移动', () => {
    assert.equal(movePromptSelection(0, 1, 3), 1);
    assert.equal(movePromptSelection(2, 1, 3), 0);
    assert.equal(movePromptSelection(0, -1, 3), 2);
  });

  it('空列表返回 -1', () => {
    assert.equal(movePromptSelection(0, 1, 0), -1);
  });
});
