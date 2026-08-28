import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parse } from 'yaml';
import type {
  InstalledSkillContent,
  InstalledSkillSummary,
  SkillDependencySummary,
  SkillFileSummary,
  SkillLockMetadata,
  UploadSkillRequest,
} from '@waker/contracts';
import { parseFrontmatter, stripFrontmatter } from './frontmatter.js';

export const SKILL_CONTENT_MAX_BYTES = 128 * 1024;
export const SKILLS_CLI_VERSION = '1.5.23';

const SKILL_NAME_REGEX = /^[a-z0-9-]{1,80}$/;
const MAX_DESCRIPTION_LENGTH = 1_024;
const MAX_INVENTORY_FILES = 512;
const FRONTMATTER_BLOCK = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const STAGING_METADATA = '.waker-source.json';

export type SkillUploadErrorCode = 'INVALID_NAME' | 'INVALID_SKILL' | 'CONFLICT' | 'TOO_LARGE';

export class SkillUploadError extends Error {
  readonly code: SkillUploadErrorCode;
  constructor(code: SkillUploadErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

interface SkillsLockEntry {
  source?: string;
  sourceType?: string;
  skillPath?: string;
  computedHash?: string;
}

interface SkillsLock {
  version: number;
  skills: Map<string, SkillsLockEntry>;
}

export interface StagingMetadata {
  kind: 'github' | 'upload';
  source: string;
  skillId: string;
  commit?: string;
}

export interface StagedSkillSource {
  name: string;
  directory: string;
  relativeDirectory: string;
}

function isWithin(root: string, target: string): boolean {
  const fromRoot = relative(root, target);
  return (
    fromRoot === '' ||
    (!isAbsolute(fromRoot) && fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`))
  );
}

function assertSafeWorkspacePath(cwd: string, relativePath: string): void {
  const lexicalRoot = resolve(cwd);
  const workspaceRoot = realpathSync(cwd);
  const target = resolve(cwd, relativePath);
  if (!isWithin(lexicalRoot, target)) throw new Error('Skills 变更路径逃逸工作区');
  let current = lexicalRoot;
  for (const part of relative(lexicalRoot, target).split(sep).filter(Boolean)) {
    current = join(current, part);
    if (!existsSync(current)) break;
    const stats = lstatSync(current);
    if (stats.isSymbolicLink()) throw new Error(`Skills 变更路径不得是符号链接：${relativePath}`);
    if (!isWithin(workspaceRoot, realpathSync(current)))
      throw new Error('Skills 变更路径逃逸工作区');
  }
}

/** Fail closed before any Skills CLI, staging, rollback, or direct removal mutation. */
export function assertSkillsMutationRootsSafe(cwd: string, skillId?: string): void {
  for (const path of [
    '.agents',
    '.agents/skills',
    '.codex',
    '.codex/skills',
    '.codex/skill-sources',
    'skills-lock.json',
  ]) {
    assertSafeWorkspacePath(cwd, path);
  }
  if (skillId) {
    if (!SKILL_NAME_REGEX.test(skillId)) throw new Error('技能名称不合法');
    assertSafeWorkspacePath(cwd, `.agents/skills/${skillId}`);
  }
}

/** Detects both filesystem residue and a ghost skills-lock entry after CLI cleanup. */
export function hasRepoSkillResidue(cwd: string, skillId: string): boolean {
  assertSkillsMutationRootsSafe(cwd, skillId);
  if (existsSync(join(cwd, '.agents', 'skills', skillId))) return true;
  const lock = readSkillsLock(cwd);
  return lock.skills.has(skillId);
}

function readSkillsLock(cwd: string): SkillsLock {
  const target = join(cwd, 'skills-lock.json');
  if (!existsSync(target)) return { version: 0, skills: new Map() };
  try {
    const stats = lstatSync(target);
    if (stats.isSymbolicLink() || !stats.isFile() || stats.size > 1024 * 1024)
      return { version: 0, skills: new Map() };
    const parsed = JSON.parse(readFileSync(target, 'utf8')) as {
      version?: unknown;
      skills?: Record<string, SkillsLockEntry>;
    };
    const version = Number.isSafeInteger(parsed.version) ? (parsed.version as number) : 0;
    return { version, skills: new Map(Object.entries(parsed.skills ?? {})) };
  } catch {
    return { version: 0, skills: new Map() };
  }
}

function lockMetadata(
  cwd: string,
  lock: SkillsLock,
  entry?: SkillsLockEntry,
): SkillLockMetadata | undefined {
  if (!entry) return undefined;
  let source = entry.source;
  if (source && (isAbsolute(source) || source.startsWith('..'))) {
    const absolute = resolve(cwd, source);
    source = isWithin(resolve(cwd), absolute)
      ? relative(resolve(cwd), absolute).split(sep).join('/')
      : undefined;
  }
  return {
    version: lock.version,
    ...(source ? { source } : {}),
    ...(typeof entry.sourceType === 'string' ? { sourceType: entry.sourceType } : {}),
    ...(typeof entry.skillPath === 'string' ? { skillPath: entry.skillPath } : {}),
    ...(typeof entry.computedHash === 'string' ? { computedHash: entry.computedHash } : {}),
  };
}

export function readStagingMetadata(cwd: string, source?: string): StagingMetadata | undefined {
  if (!source) return undefined;
  const absolute = resolve(cwd, source);
  const stagingRoot = resolve(cwd, '.codex', 'skill-sources');
  if (!isWithin(stagingRoot, absolute)) return undefined;
  try {
    if (!isWithin(realpathSync(stagingRoot), realpathSync(absolute))) return undefined;
  } catch {
    return undefined;
  }
  const target = join(absolute, STAGING_METADATA);
  if (!existsSync(target)) return undefined;
  try {
    const stats = lstatSync(target);
    if (stats.isSymbolicLink() || !stats.isFile() || stats.size > 64 * 1024) return undefined;
    const value = JSON.parse(readFileSync(target, 'utf8')) as Partial<StagingMetadata>;
    if (
      (value.kind === 'github' || value.kind === 'upload') &&
      typeof value.source === 'string' &&
      typeof value.skillId === 'string'
    ) {
      return value as StagingMetadata;
    }
  } catch {
    // Staging metadata is informational; a bad file never changes skill execution.
  }
  return undefined;
}

function dependencySummaries(value: unknown): SkillDependencySummary[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const tools = (value as { dependencies?: { tools?: unknown } }).dependencies?.tools;
  if (!Array.isArray(tools)) return [];
  return tools.flatMap((tool) => {
    if (!tool || typeof tool !== 'object' || Array.isArray(tool)) return [];
    const record = tool as Record<string, unknown>;
    if (typeof record.type !== 'string' || typeof record.value !== 'string') return [];
    return [
      {
        type: record.type.slice(0, 80),
        value: record.value.slice(0, 240),
        ...(typeof record.description === 'string'
          ? { description: record.description.slice(0, 500) }
          : {}),
      },
    ];
  });
}

function openAiMetadata(
  workspaceRoot: string,
  directory: string,
  errors: string[],
): {
  allowImplicitInvocation: boolean;
  dependencies: SkillDependencySummary[];
} {
  const target = join(directory, 'agents', 'openai.yaml');
  if (!existsSync(target)) return { allowImplicitInvocation: true, dependencies: [] };
  try {
    const stats = lstatSync(target);
    const realTarget = realpathSync(target);
    if (stats.isSymbolicLink() || !stats.isFile() || !isWithin(workspaceRoot, realTarget)) {
      errors.push('agents/openai.yaml 必须是工作区内的普通文件');
      return { allowImplicitInvocation: false, dependencies: [] };
    }
    if (stats.size > SKILL_CONTENT_MAX_BYTES) {
      errors.push(`agents/openai.yaml 超过 ${SKILL_CONTENT_MAX_BYTES} 字节上限`);
      return { allowImplicitInvocation: false, dependencies: [] };
    }
    const raw = readFileSync(target, 'utf8');
    const value = parse(raw) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('metadata must be an object');
    const implicit = (value as { policy?: { allow_implicit_invocation?: unknown } }).policy
      ?.allow_implicit_invocation;
    if (implicit !== undefined && typeof implicit !== 'boolean') {
      errors.push('allow_implicit_invocation 必须是 boolean');
      return { allowImplicitInvocation: false, dependencies: [] };
    }
    const allowImplicitInvocation = implicit !== false;
    return { allowImplicitInvocation, dependencies: dependencySummaries(value) };
  } catch {
    errors.push('agents/openai.yaml 无法解析');
    return { allowImplicitInvocation: false, dependencies: [] };
  }
}

function fileInventory(directory: string, errors: string[]): SkillFileSummary[] {
  const files: SkillFileSummary[] = [];
  const visit = (current: string) => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true }).sort((a, b) =>
        a.name.localeCompare(b.name),
      );
    } catch {
      errors.push(`技能目录无法读取：${relative(directory, current).split(sep).join('/') || '.'}`);
      return;
    }
    for (const entry of entries) {
      if (files.length >= MAX_INVENTORY_FILES) {
        if (!errors.includes(`技能文件超过 ${MAX_INVENTORY_FILES} 个，清单已截断`))
          errors.push(`技能文件超过 ${MAX_INVENTORY_FILES} 个，清单已截断`);
        return;
      }
      const absolute = join(current, entry.name);
      const path = relative(directory, absolute).split(sep).join('/');
      let stats;
      try {
        stats = lstatSync(absolute);
      } catch {
        errors.push(`技能文件无法读取：${path}`);
        continue;
      }
      if (stats.isSymbolicLink()) {
        files.push({ path, size: 0, executable: false, symlink: true });
      } else if (stats.isDirectory()) {
        visit(absolute);
      } else if (stats.isFile()) {
        files.push({
          path,
          size: stats.size,
          executable: Boolean(stats.mode & 0o111),
          symlink: false,
        });
      }
    }
  };
  visit(directory);
  return files;
}

function previewOf(raw: string): string | undefined {
  const body = stripFrontmatter(raw).replace(/\s+/g, ' ').trim();
  return body ? body.slice(0, 200) : undefined;
}

function scanSkill(
  cwd: string,
  base: '.agents/skills' | '.codex/skills',
  directoryName: string,
  lock: SkillsLock,
): InstalledSkillSummary {
  const scope = base === '.agents/skills' ? 'agents' : 'codex';
  const path = `${base}/${directoryName}/SKILL.md`;
  const locator = `${scope}:${path}`;
  const errors: string[] = [];
  const root = realpathSync(cwd);
  const directoryPath = join(cwd, base, directoryName);
  let directory: string;
  try {
    directory = realpathSync(directoryPath);
    if (!isWithin(root, directory)) errors.push('技能符号链接指向工作区外，内容不会通过 API 暴露');
  } catch {
    errors.push('技能目录无法读取');
    directory = directoryPath;
  }
  const target = join(directory, 'SKILL.md');
  let raw = '';
  if (!errors.length || isWithin(root, directory)) {
    try {
      const stats = lstatSync(target);
      if (stats.isSymbolicLink() || !stats.isFile()) errors.push('SKILL.md 必须是普通文件');
      else if (stats.size > SKILL_CONTENT_MAX_BYTES)
        errors.push(`SKILL.md 超过 ${SKILL_CONTENT_MAX_BYTES} 字节上限`);
      else raw = readFileSync(target, 'utf8');
    } catch {
      errors.push('SKILL.md 无法读取');
    }
  }
  const match = FRONTMATTER_BLOCK.exec(raw);
  const parsed = parseFrontmatter(raw);
  const frontmatter = parsed.frontmatter;
  const name =
    typeof frontmatter.name === 'string' && frontmatter.name.trim()
      ? frontmatter.name.trim()
      : directoryName;
  const description =
    typeof frontmatter.description === 'string' && frontmatter.description.trim()
      ? frontmatter.description.trim()
      : undefined;
  const version =
    typeof frontmatter.version === 'string' || typeof frontmatter.version === 'number'
      ? String(frontmatter.version).trim().slice(0, 120)
      : undefined;
  if (!match) errors.push('SKILL.md 缺少 YAML frontmatter');
  if (!SKILL_NAME_REGEX.test(name)) errors.push('frontmatter.name 必须匹配 [a-z0-9-]{1,80}');
  if (name !== directoryName) errors.push('frontmatter.name 必须与技能目录名一致');
  if (!description) errors.push('frontmatter.description 必填');
  else if (description.length > MAX_DESCRIPTION_LENGTH)
    errors.push(`frontmatter.description 超过 ${MAX_DESCRIPTION_LENGTH} 字符`);
  if (!parsed.body.trim()) errors.push('SKILL.md 指令正文不能为空');
  const safeDirectory = existsSync(directory) && isWithin(root, directory);
  const metadata = safeDirectory
    ? openAiMetadata(root, directory, errors)
    : { allowImplicitInvocation: true, dependencies: [] };
  const files = safeDirectory ? fileInventory(directory, errors) : [];
  if (files.some((file) => file.symlink)) errors.push('技能目录包含符号链接');
  const lockEntry = scope === 'agents' ? lock.skills.get(directoryName) : undefined;
  const staging = readStagingMetadata(cwd, lockEntry?.source);
  const baseLockInfo = lockMetadata(cwd, lock, lockEntry);
  const lockInfo = baseLockInfo
    ? { ...baseLockInfo, ...(staging?.commit ? { commit: staging.commit } : {}) }
    : undefined;
  const source = staging?.source ?? lockInfo?.source;
  return {
    locator,
    name,
    path,
    scope,
    availability: 'available',
    managed: Boolean(lockEntry),
    valid: errors.length === 0,
    errors,
    allowImplicitInvocation: metadata.allowImplicitInvocation,
    dependencies: metadata.dependencies,
    files,
    integrity: lockEntry ? 'unverified' : 'unmanaged',
    ...(description ? { description } : {}),
    ...(version ? { version } : {}),
    ...(previewOf(raw) ? { preview: previewOf(raw) } : {}),
    ...(source ? { source } : {}),
    ...(lockInfo ? { lock: lockInfo } : {}),
  };
}

/** Lists repo skills plus project CODEX_HOME `.codex/skills` sources. No names are merged. */
export function listInstalledSkills(cwd: string): InstalledSkillSummary[] {
  const lock = readSkillsLock(cwd);
  const items: InstalledSkillSummary[] = [];
  for (const base of ['.agents/skills', '.codex/skills'] as const) {
    const directory = join(cwd, base);
    if (!existsSync(directory)) continue;
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (entry.name === '.system' || entry.name === 'skill-sources') continue;
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const target = join(directory, entry.name, 'SKILL.md');
      if (!existsSync(target)) continue;
      items.push(scanSkill(cwd, base, entry.name, lock));
    }
  }
  return items;
}

export function readInstalledSkillContent(
  cwd: string,
  scope: 'codex' | 'agents',
  name: string,
  locator?: string,
): InstalledSkillContent | undefined {
  const item = listInstalledSkills(cwd).find((entry) =>
    locator ? entry.locator === locator : entry.scope === scope && entry.name === name,
  );
  if (!item) return undefined;
  const root = realpathSync(cwd);
  const rawTarget = join(cwd, item.path);
  try {
    const stats = lstatSync(rawTarget);
    if (stats.isSymbolicLink() || !stats.isFile() || stats.size > SKILL_CONTENT_MAX_BYTES)
      return undefined;
  } catch {
    return undefined;
  }
  let target: string;
  try {
    target = realpathSync(rawTarget);
  } catch {
    return undefined;
  }
  if (!isWithin(root, target)) return undefined;
  const raw = readFileSync(target, 'utf8');
  const frontmatter = FRONTMATTER_BLOCK.exec(raw)?.[1]?.trim();
  return {
    locator: item.locator,
    name: item.name,
    scope: item.scope,
    valid: item.valid,
    errors: item.errors,
    allowImplicitInvocation: item.allowImplicitInvocation,
    dependencies: item.dependencies,
    files: item.files,
    integrity: item.integrity,
    ...(item.description ? { description: item.description } : {}),
    ...(item.version ? { version: item.version } : {}),
    ...(item.source ? { source: item.source } : {}),
    content: stripFrontmatter(raw).trim(),
    ...(frontmatter ? { frontmatter } : {}),
  };
}

/** Deletes an explicitly selected project CODEX_HOME source. Repo skills use Skills CLI. */
export function removeProjectSkill(cwd: string, name: string, locator?: string): boolean {
  assertSkillsMutationRootsSafe(cwd);
  const item = listInstalledSkills(cwd).find((entry) =>
    locator
      ? entry.locator === locator && entry.scope === 'codex'
      : entry.scope === 'codex' && entry.name === name,
  );
  if (!item) return false;
  const directory = resolve(cwd, dirname(item.path));
  const legacyRoot = resolve(cwd, '.codex', 'skills');
  if (!isWithin(legacyRoot, directory) || directory === legacyRoot) return false;
  const workspaceRoot = realpathSync(cwd);
  const stats = lstatSync(directory);
  const realLegacyRoot = realpathSync(legacyRoot);
  const realDirectory = realpathSync(directory);
  if (
    stats.isSymbolicLink() ||
    !stats.isDirectory() ||
    !isWithin(workspaceRoot, realLegacyRoot) ||
    !isWithin(realLegacyRoot, realDirectory) ||
    realDirectory === realLegacyRoot
  )
    return false;
  rmSync(directory, { recursive: true, force: true });
  return true;
}

function validateUploadedSkill(input: UploadSkillRequest): { name: string; file: string } {
  const name = input.name.trim();
  if (!SKILL_NAME_REGEX.test(name))
    throw new SkillUploadError('INVALID_NAME', '技能名称需匹配 [a-z0-9-]{1,80}');
  const content = input.content.trim();
  if (!content) throw new SkillUploadError('INVALID_SKILL', '技能内容不能为空');
  if (Buffer.byteLength(content, 'utf8') > SKILL_CONTENT_MAX_BYTES)
    throw new SkillUploadError('TOO_LARGE', `技能内容超过 ${SKILL_CONTENT_MAX_BYTES} 字节上限`);
  const match = FRONTMATTER_BLOCK.exec(content);
  if (!match)
    throw new SkillUploadError(
      'INVALID_SKILL',
      'SKILL.md 必须包含 name 与 description frontmatter',
    );
  let rawFrontmatter: unknown;
  try {
    rawFrontmatter = parse(match[1]!);
  } catch {
    throw new SkillUploadError('INVALID_SKILL', 'SKILL.md frontmatter 不是有效 YAML');
  }
  if (!rawFrontmatter || typeof rawFrontmatter !== 'object' || Array.isArray(rawFrontmatter))
    throw new SkillUploadError('INVALID_SKILL', 'SKILL.md frontmatter 必须是 YAML 对象');
  const { frontmatter, body } = parseFrontmatter(content);
  if (frontmatter.name !== name)
    throw new SkillUploadError('INVALID_SKILL', 'frontmatter.name 必须与上传技能名称一致');
  if (
    typeof frontmatter.description !== 'string' ||
    !frontmatter.description.trim() ||
    frontmatter.description.length > MAX_DESCRIPTION_LENGTH
  ) {
    throw new SkillUploadError('INVALID_SKILL', 'frontmatter.description 必填且不得超过 1024 字符');
  }
  if (!body.trim()) throw new SkillUploadError('INVALID_SKILL', 'SKILL.md 指令正文不能为空');
  return { name, file: `${content}\n` };
}

/** Stages a validated instruction-only skill before Skills CLI copies it into `.agents/skills`. */
export function stageUploadedSkill(cwd: string, input: UploadSkillRequest): StagedSkillSource {
  const { name, file } = validateUploadedSkill(input);
  assertSkillsMutationRootsSafe(cwd, name);
  const root = join(cwd, '.codex', 'skill-sources');
  const directory = join(root, name);
  if (existsSync(join(cwd, '.agents', 'skills', name)))
    throw new SkillUploadError('CONFLICT', `技能已存在：${name}`);
  mkdirSync(root, { recursive: true });
  assertSkillsMutationRootsSafe(cwd, name);
  if (existsSync(directory)) {
    if (lstatSync(directory).isSymbolicLink())
      throw new SkillUploadError('INVALID_SKILL', '技能来源目录不得是符号链接');
    const existing = join(directory, 'SKILL.md');
    if (existsSync(existing) && readFileSync(existing, 'utf8') === file)
      return {
        name,
        directory,
        relativeDirectory: relative(cwd, directory).split(sep).join('/'),
      };
    throw new SkillUploadError('CONFLICT', `技能来源已存在且内容不同：${name}`);
  }
  const temporary = join(root, `.tmp-${name}-${process.pid}`);
  if (existsSync(temporary)) rmSync(temporary, { recursive: true, force: true });
  mkdirSync(temporary);
  try {
    writeFileSync(join(temporary, 'SKILL.md'), file, { encoding: 'utf8', flag: 'wx' });
    writeFileSync(
      join(temporary, STAGING_METADATA),
      `${JSON.stringify({ kind: 'upload', source: 'local-upload', skillId: name })}\n`,
      { encoding: 'utf8', flag: 'wx' },
    );
    renameSync(temporary, directory);
  } catch (error) {
    rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
  return {
    name,
    directory,
    relativeDirectory: relative(cwd, directory).split(sep).join('/'),
  };
}

export function writeStagingMetadata(directory: string, metadata: StagingMetadata): void {
  writeFileSync(join(directory, STAGING_METADATA), `${JSON.stringify(metadata)}\n`, {
    encoding: 'utf8',
    flag: 'w',
  });
}

/** Removes the durable source of an uploaded skill after Skills CLI removed its repo copy. */
export function removeUploadedSkillSource(
  cwd: string,
  source: string | undefined,
  expectedName: string,
): boolean {
  assertSkillsMutationRootsSafe(cwd, expectedName);
  const metadata = readStagingMetadata(cwd, source);
  if (!metadata || metadata.kind !== 'upload' || metadata.skillId !== expectedName || !source)
    return false;
  const root = resolve(cwd, '.codex', 'skill-sources');
  const target = resolve(cwd, source);
  if (!isWithin(root, target) || target === root) return false;
  const workspaceRoot = realpathSync(cwd);
  const stats = lstatSync(target);
  const realRoot = realpathSync(root);
  const realTarget = realpathSync(target);
  if (
    stats.isSymbolicLink() ||
    !stats.isDirectory() ||
    !isWithin(workspaceRoot, realRoot) ||
    !isWithin(realRoot, realTarget) ||
    realTarget === realRoot
  )
    return false;
  rmSync(target, { recursive: true, force: true });
  return true;
}
