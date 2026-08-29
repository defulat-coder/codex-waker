import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  normalizeSessionSkillNames,
  sessionSkillConfigOverrides,
  unknownSessionSkillNames,
} from './session-skills.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function writeSkill(root: string, base: '.agents/skills' | '.codex/skills', name: string): void {
  const directory = join(root, base, name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${name} skill.\n---\n\nDo ${name}.\n`,
  );
}

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'codex-session-skills-'));
  roots.push(root);
  writeSkill(root, '.agents/skills', 'alpha');
  writeSkill(root, '.agents/skills', 'beta');
  writeSkill(root, '.codex/skills', 'gamma');
  return root;
}

describe('normalizeSessionSkillNames', () => {
  it('trims, drops empties and dedupes in first-seen order', () => {
    assert.deepEqual(normalizeSessionSkillNames([' alpha ', '', 'beta', 'alpha', '  ']), [
      'alpha',
      'beta',
    ]);
  });
});

describe('unknownSessionSkillNames', () => {
  it('returns names absent from the project skill catalog', () => {
    const root = fixture();
    assert.deepEqual(unknownSessionSkillNames(root, ['alpha', 'gamma']), []);
    assert.deepEqual(unknownSessionSkillNames(root, ['alpha', 'nope']), ['nope']);
  });
});

describe('sessionSkillConfigOverrides', () => {
  it('returns undefined when the session mounts nothing (CLI default discovery)', () => {
    const root = fixture();
    assert.equal(sessionSkillConfigOverrides(root, undefined), undefined);
  });

  it('disables every catalog skill not in the mount list by absolute SKILL.md path', () => {
    const root = fixture();
    const config = sessionSkillConfigOverrides(root, ['alpha']) as {
      skills: { config: Array<{ path: string; enabled: boolean }> };
    };
    const disabled = config.skills.config;
    assert.deepEqual(
      disabled.map((entry) => entry.path).sort(),
      [join(root, '.agents/skills/beta/SKILL.md'), join(root, '.codex/skills/gamma/SKILL.md')].sort(),
    );
    assert.ok(disabled.every((entry) => entry.enabled === false));
  });

  it('disables the whole catalog for an empty mount list', () => {
    const root = fixture();
    const config = sessionSkillConfigOverrides(root, []) as {
      skills: { config: Array<{ path: string; enabled: boolean }> };
    };
    assert.equal(config.skills.config.length, 3);
  });

  it('emits an empty config array when everything is mounted', () => {
    const root = fixture();
    const config = sessionSkillConfigOverrides(root, ['alpha', 'beta', 'gamma']) as {
      skills: { config: unknown[] };
    };
    assert.deepEqual(config.skills.config, []);
  });
});
