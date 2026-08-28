import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertSkillsMutationRootsSafe,
  hasRepoSkillResidue,
  listInstalledSkills,
  readInstalledSkillContent,
  removeProjectSkill,
  removeUploadedSkillSource,
  SkillUploadError,
  stageUploadedSkill,
} from './skills.js';
import { listSkills } from './agents.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'waker-skills-'));
  roots.push(value);
  return value;
}

function writeSkill(base: string, scope: '.agents' | '.codex', name: string, content: string) {
  const directory = join(base, scope, 'skills', name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'SKILL.md'), content);
  return directory;
}

const VALID = `---
name: research
description: Research primary sources.
version: 2
---

Search, then cite.
`;

describe('authoritative skill inventory', () => {
  it('keeps duplicate names by locator and exposes lock, policy, dependencies and files', () => {
    const base = root();
    const repo = writeSkill(base, '.agents', 'research', VALID);
    mkdirSync(join(repo, 'agents'), { recursive: true });
    writeFileSync(
      join(repo, 'agents', 'openai.yaml'),
      `policy:
  allow_implicit_invocation: false
dependencies:
  tools:
    - type: mcp
      value: docs
      description: Documentation server
`,
    );
    writeFileSync(join(repo, 'notes.md'), 'reference');
    writeSkill(base, '.codex', 'research', VALID);
    writeFileSync(
      join(base, 'skills-lock.json'),
      JSON.stringify({
        version: 1,
        skills: {
          research: {
            source: 'acme/skills',
            sourceType: 'github',
            skillPath: 'skills/research/SKILL.md',
            computedHash: 'abc123',
          },
        },
      }),
    );

    const items = listInstalledSkills(base);
    assert.equal(items.length, 2);
    assert.equal(new Set(items.map((item) => item.locator)).size, 2);
    const available = items.find((item) => item.scope === 'agents')!;
    assert.equal(available.availability, 'available');
    assert.equal(available.managed, true);
    assert.equal(available.source, 'acme/skills');
    assert.equal(available.lock?.computedHash, 'abc123');
    assert.equal(available.lock?.version, 1);
    assert.equal(available.integrity, 'unverified');
    assert.equal(available.version, '2');
    assert.equal(available.allowImplicitInvocation, false);
    assert.deepEqual(available.dependencies, [
      { type: 'mcp', value: 'docs', description: 'Documentation server' },
    ]);
    assert.ok(available.files.some((file) => file.path === 'notes.md'));
    const legacy = items.find((item) => item.scope === 'codex')!;
    assert.equal(legacy.availability, 'available');
    assert.equal(legacy.managed, false);
    assert.equal(legacy.integrity, 'unmanaged');
  });

  it('reports invalid metadata instead of blessing malformed skills', () => {
    const base = root();
    writeSkill(base, '.agents', 'broken', '---\nname: other\n---\n\nBody.\n');
    const item = listInstalledSkills(base)[0]!;
    assert.equal(item.valid, false);
    assert.ok(item.errors.some((error) => error.includes('目录名一致')));
    assert.ok(item.errors.some((error) => error.includes('description 必填')));
  });

  it('reads duplicate names by stable locator and refuses an outside-workspace symlink', () => {
    const base = root();
    writeSkill(base, '.agents', 'research', VALID);
    writeSkill(base, '.codex', 'research', VALID.replace('Search, then cite.', 'Legacy body.'));
    const [repo, legacy] = listInstalledSkills(base);
    assert.equal(
      readInstalledSkillContent(base, 'agents', 'research', repo!.locator)?.content,
      'Search, then cite.',
    );
    assert.equal(
      readInstalledSkillContent(base, 'codex', 'research', legacy!.locator)?.content,
      'Legacy body.',
    );

    const outside = root();
    writeSkill(outside, '.agents', 'external', VALID.replaceAll('research', 'external'));
    mkdirSync(join(base, '.agents', 'skills'), { recursive: true });
    symlinkSync(
      join(outside, '.agents', 'skills', 'external'),
      join(base, '.agents', 'skills', 'external'),
    );
    const external = listInstalledSkills(base).find((item) => item.name === 'external')!;
    assert.equal(external.valid, false);
    assert.ok(external.errors.some((error) => error.includes('工作区外')));
    assert.equal(
      readInstalledSkillContent(base, 'agents', 'external', external.locator),
      undefined,
    );
  });

  it('never reads SKILL.md or metadata through symlinks and omits invalid runtime skills', () => {
    const base = root();
    const leak = join(base, '.agents', 'skills', 'leak');
    mkdirSync(leak, { recursive: true });
    writeFileSync(join(base, 'private.txt'), 'PRIVATE_WORKSPACE_VALUE');
    symlinkSync(join(base, 'private.txt'), join(leak, 'SKILL.md'));

    const outside = root();
    mkdirSync(join(outside, 'agents'), { recursive: true });
    writeFileSync(
      join(outside, 'agents', 'openai.yaml'),
      'dependencies:\n  tools:\n    - type: mcp\n      value: private-server\n',
    );
    const metadataSkill = writeSkill(
      base,
      '.agents',
      'metadata-link',
      VALID.replaceAll('research', 'metadata-link'),
    );
    symlinkSync(join(outside, 'agents'), join(metadataSkill, 'agents'));

    const inventory = listInstalledSkills(base);
    const leaked = inventory.find((item) => item.name === 'leak')!;
    assert.equal(leaked.valid, false);
    assert.equal(readInstalledSkillContent(base, 'agents', leaked.name, leaked.locator), undefined);
    const metadata = inventory.find((item) => item.name === 'metadata-link')!;
    assert.equal(metadata.valid, false);
    assert.deepEqual(metadata.dependencies, []);
    assert.deepEqual(listSkills(base), []);
  });
});

describe('uploaded skill staging', () => {
  it('requires strict frontmatter and permits an identical retry after CLI failure', () => {
    const base = root();
    const input = { name: 'research', content: VALID };
    const first = stageUploadedSkill(base, input);
    const retry = stageUploadedSkill(base, input);
    assert.equal(retry.directory, first.directory);
    assert.match(readFileSync(join(first.directory, 'SKILL.md'), 'utf8'), /description:/);
    assert.throws(
      () => stageUploadedSkill(base, { name: 'research', content: VALID.replace('cite', 'write') }),
      (error: unknown) => error instanceof SkillUploadError && error.code === 'CONFLICT',
    );
    assert.throws(
      () => stageUploadedSkill(base, { name: 'plain', content: 'Only a body.' }),
      (error: unknown) => error instanceof SkillUploadError && error.code === 'INVALID_SKILL',
    );
    assert.throws(
      () =>
        stageUploadedSkill(base, {
          name: 'bad-yaml',
          content: '---\nname: bad-yaml\ndescription: [\n---\n\nBody.\n',
        }),
      (error: unknown) => error instanceof SkillUploadError && error.code === 'INVALID_SKILL',
    );
  });

  it('deletes only an explicitly located legacy host source', () => {
    const base = root();
    writeSkill(base, '.codex', 'legacy', VALID.replaceAll('research', 'legacy'));
    writeSkill(base, '.agents', 'legacy', VALID.replaceAll('research', 'legacy'));
    const legacy = listInstalledSkills(base).find((item) => item.scope === 'codex')!;
    assert.equal(removeProjectSkill(base, 'legacy', legacy.locator), true);
    assert.equal(existsSync(join(base, '.codex', 'skills', 'legacy')), false);
    assert.equal(existsSync(join(base, '.agents', 'skills', 'legacy')), true);
  });

  it('removes only the matching durable upload source after CLI deletion', () => {
    const base = root();
    const staged = stageUploadedSkill(base, { name: 'research', content: VALID });
    assert.equal(removeUploadedSkillSource(base, staged.directory, 'other'), false);
    assert.equal(existsSync(staged.directory), true);
    assert.equal(removeUploadedSkillSource(base, staged.directory, 'research'), true);
    assert.equal(existsSync(staged.directory), false);
  });

  it('never deletes through parent-root symlinks', () => {
    const base = root();
    const outside = root();
    const outsideHost = writeSkill(
      outside,
      '.codex',
      'external',
      VALID.replaceAll('research', 'external'),
    );
    mkdirSync(join(base, '.codex'), { recursive: true });
    symlinkSync(join(outside, '.codex', 'skills'), join(base, '.codex', 'skills'));
    const external = listInstalledSkills(base).find((item) => item.name === 'external')!;
    assert.throws(() => removeProjectSkill(base, 'external', external.locator), /符号链接/);
    assert.equal(existsSync(outsideHost), true);

    rmSync(join(base, '.codex', 'skills'));
    const outsideSources = join(outside, 'sources');
    mkdirSync(join(outsideSources, 'upload'), { recursive: true });
    writeFileSync(
      join(outsideSources, 'upload', '.waker-source.json'),
      JSON.stringify({ kind: 'upload', source: 'local-upload', skillId: 'upload' }),
    );
    symlinkSync(outsideSources, join(base, '.codex', 'skill-sources'));
    assert.throws(
      () => removeUploadedSkillSource(base, '.codex/skill-sources/upload', 'upload'),
      /符号链接/,
    );
    assert.equal(existsSync(join(outsideSources, 'upload')), true);
  });

  it('rejects CLI mutation roots that are symlinks and detects ghost lock entries', () => {
    const base = root();
    const outside = root();
    mkdirSync(join(base, '.agents'), { recursive: true });
    mkdirSync(join(outside, 'skills'), { recursive: true });
    symlinkSync(join(outside, 'skills'), join(base, '.agents', 'skills'));
    assert.throws(() => assertSkillsMutationRootsSafe(base, 'research'), /符号链接/);

    rmSync(join(base, '.agents', 'skills'));
    writeFileSync(
      join(base, 'skills-lock.json'),
      JSON.stringify({ version: 1, skills: { research: { source: 'local' } } }),
    );
    assert.equal(hasRepoSkillResidue(base, 'research'), true);
  });
});
