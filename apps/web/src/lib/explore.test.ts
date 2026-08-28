import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentSummary, AgentTemplate, LibrarySkillSummary } from '@waker/contracts';
import {
  agentCardStats,
  blankAgentRequest,
  formatInstallCount,
  groupLibraryOwners,
  librarySkillOwner,
  templateToCreateRequest,
} from './explore.js';

const agent: AgentSummary = {
  id: 'codex-assistant',
  name: 'Codex 助手',
  mark: '⌘',
  tagline: '通用聊天助手',
  description: '一个通用聊天助手。',
  suggestions: ['问题一', '问题二'],
  sessionCount: 3,
};

const template: AgentTemplate = {
  id: 'translator-pro',
  name: '翻译助手',
  mark: '译',
  tagline: '中英互译与润色',
  description: '在中英文之间互译。',
  suggestions: ['把这段话译成英文'],
  body: '你是翻译助手，专注中英互译。',
};

describe('agent templates', () => {
  it('maps a template into a create request and lets the user override the id', () => {
    const request = templateToCreateRequest(template);
    assert.equal(request.id, template.id);
    assert.deepEqual(request.suggestions, template.suggestions);
    assert.notEqual(
      request.suggestions,
      template.suggestions,
      'suggestions 应该是拷贝而不是同一引用',
    );
    const renamed = templateToCreateRequest(template, 'my-translator');
    assert.equal(renamed.id, 'my-translator');
    assert.equal(renamed.name, template.name);
  });
});

describe('blankAgentRequest', () => {
  it('projects the short Fleet form onto a complete local definition', () => {
    const request = blankAgentRequest(
      'Support Triage',
      'Routes support requests.',
      'support-triage',
    );
    assert.equal(request.id, 'support-triage');
    assert.equal(request.mark, 'ST');
    assert.equal(request.tagline, 'Routes support requests.');
    assert.match(request.body, /Support Triage/);
    assert.equal(request.suggestions.length, 2);
  });

  it('uses useful defaults when description is omitted', () => {
    const request = blankAgentRequest('研究助手', '', 'research-agent');
    assert.equal(request.mark, '研究');
    assert.equal(request.tagline, '自定义 Agent');
    assert.match(request.description, /研究助手/);
  });
});

describe('agentCardStats', () => {
  it('counts suggestions and sessions, defaulting missing session counts to 0', () => {
    assert.deepEqual(agentCardStats(agent), { suggestionCount: 2, sessionCount: 3 });
    const { sessionCount: _dropped, ...withoutCount } = agent;
    assert.deepEqual(agentCardStats(withoutCount), { suggestionCount: 2, sessionCount: 0 });
  });
});

describe('formatInstallCount', () => {
  it('formats compact install counts', () => {
    assert.equal(formatInstallCount(3_100_000), '3.1M');
    assert.equal(formatInstallCount(2_000_000), '2M');
    assert.equal(formatInstallCount(653_000), '653K');
    assert.equal(formatInstallCount(12_300), '12.3K');
    assert.equal(formatInstallCount(999), '999');
    assert.equal(formatInstallCount(0), '0');
  });
});

const libraryItem = (id: string, source: string): LibrarySkillSummary => ({
  id,
  name: id.split('/').pop() ?? id,
  source,
  installs: 0,
  installed: false,
});

describe('librarySkillOwner', () => {
  it('takes the owner segment of an "owner/repo" source', () => {
    assert.equal(librarySkillOwner('vercel-labs/skills'), 'vercel-labs');
    assert.equal(librarySkillOwner('no-slash-source'), 'no-slash-source');
    assert.equal(librarySkillOwner('/leading'), '/leading');
  });
});

describe('groupLibraryOwners', () => {
  it('groups by owner, sorted by count desc then name asc', () => {
    const items = [
      libraryItem('vercel-labs/skills/find-skills', 'vercel-labs/skills'),
      libraryItem('vercel-labs/skills/web-design', 'vercel-labs/skills'),
      libraryItem('anthropics/skills/pdf', 'anthropics/skills'),
      libraryItem('obra/superpowers/brainstorming', 'obra/superpowers'),
    ];
    assert.deepEqual(groupLibraryOwners(items), [
      { owner: 'vercel-labs', count: 2 },
      { owner: 'anthropics', count: 1 },
      { owner: 'obra', count: 1 },
    ]);
  });

  it('returns an empty list for an empty result set', () => {
    assert.deepEqual(groupLibraryOwners([]), []);
  });
});
