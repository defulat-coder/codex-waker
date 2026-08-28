import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import {
  AGENT_ID_PATTERN,
  type AgentDetail,
  type AgentResources,
  type AgentSummary,
  type CreateAgentRequest,
  type InstalledSkillContent,
  type InstalledSkillSummary,
  type ImportAgentRequest,
  type PromptDocument,
  type PromptSummary,
  type SkillSummary,
  type UpdateAgentRequest,
  type UpdatePromptRequest,
  type UploadSkillRequest,
} from '@waker/contracts';
import { parseFrontmatter, stripFrontmatter } from './frontmatter.js';

const AGENT_ID_REGEX = new RegExp(AGENT_ID_PATTERN);
const PROMPT_NAME_REGEX = /^[a-z0-9-]{1,80}$/;
/** Hard cap for a generated agent file; enforced again at the API schema. */
export const AGENT_BODY_MAX_BYTES = 32 * 1024;
const PREVIEW_LENGTH = 200;

export type AgentCreateErrorCode =
  'INVALID_ID' | 'INVALID_FIELD' | 'CONFLICT' | 'TOO_LARGE' | 'NOT_FOUND';

/** Validation failure while creating or updating an agent file; the API maps `code` onto HTTP statuses. */
export class AgentCreateError extends Error {
  readonly code: AgentCreateErrorCode;
  constructor(code: AgentCreateErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** Lowercases to an ascii slug; returns undefined when nothing usable remains (e.g. pure Chinese names). */
export function deriveAgentId(name: string): string | undefined {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 64);
  return AGENT_ID_REGEX.test(slug) ? slug : undefined;
}

function assertSingleLine(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed || /[\r\n]/.test(trimmed))
    throw new AgentCreateError('INVALID_FIELD', `Agent 字段 ${field} 必须是非空单行字符串`);
  return trimmed;
}

/** JSON double-quoted scalars are valid YAML scalars, so arbitrary text survives the roundtrip. */
function yamlScalar(value: string): string {
  return JSON.stringify(value);
}

/** Fully validated field values ready to serialize; shared by createAgent and updateAgent. */
interface AgentFieldValues {
  name: string;
  mark: string;
  tagline: string;
  description: string;
  suggestions: string[];
  body: string;
}

/** Applies the create-time validation rules (non-empty single-line fields, 32KB body cap). */
function validateAgentFields(input: AgentFieldValues): AgentFieldValues {
  const name = assertSingleLine(input.name, 'name');
  const mark = assertSingleLine(input.mark, 'mark');
  const tagline = assertSingleLine(input.tagline, 'tagline');
  const description = assertSingleLine(input.description, 'description');
  if (!Array.isArray(input.suggestions) || !input.suggestions.length)
    throw new AgentCreateError('INVALID_FIELD', 'Agent 字段 suggestions 必须是非空字符串数组');
  const suggestions = input.suggestions.map((item) => assertSingleLine(item, 'suggestions'));
  const body = input.body.trim();
  if (!body) throw new AgentCreateError('INVALID_FIELD', 'Agent 定义缺少系统提示词正文');
  if (Buffer.byteLength(body, 'utf8') > AGENT_BODY_MAX_BYTES)
    throw new AgentCreateError('TOO_LARGE', `系统提示词正文超过 ${AGENT_BODY_MAX_BYTES} 字节上限`);
  return { name, mark, tagline, description, suggestions, body };
}

/** Serializes validated fields to the .codex/agents/<id>.md file content. */
function serializeAgentFile(fields: AgentFieldValues): string {
  return [
    '---',
    `name: ${yamlScalar(fields.name)}`,
    `mark: ${yamlScalar(fields.mark)}`,
    `tagline: ${yamlScalar(fields.tagline)}`,
    `description: ${yamlScalar(fields.description)}`,
    'suggestions:',
    ...fields.suggestions.map((item) => `  - ${yamlScalar(item)}`),
    '---',
    '',
    fields.body,
    '',
  ].join('\n');
}

/**
 * Writes .codex/agents/<id>.md for a new agent. The id regex keeps the path inside
 * the agents directory by construction; 'wx' makes the write fail on conflicts.
 */
export function createAgent(cwd: string, input: CreateAgentRequest): AgentDefinition {
  const id = input.id?.trim() || deriveAgentId(input.name);
  if (!id || !AGENT_ID_REGEX.test(id))
    throw new AgentCreateError(
      'INVALID_ID',
      'Agent id 需匹配 [a-z][a-z0-9-]{1,63}；中文名称请显式提供 id',
    );

  const file = serializeAgentFile(validateAgentFields(input));

  const directory = join(cwd, '.codex', 'agents');
  const target = join(directory, `${id}.md`);
  if (existsSync(target)) throw new AgentCreateError('CONFLICT', `Agent 已存在：${id}`);
  mkdirSync(directory, { recursive: true });
  try {
    writeFileSync(target, file, { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST')
      throw new AgentCreateError('CONFLICT', `Agent 已存在：${id}`);
    throw error;
  }
  // Roundtrip through the real parser so a serialization bug can never persist a broken file.
  return parseAgentFile(directory, `${id}.md`);
}

/**
 * Rewrites .codex/agents/<id>.md in place: the patch fields replace the parsed
 * values, everything else keeps the file's current content. The id is immutable.
 * The write is atomic (temp file + rename), so a crash never leaves a half file.
 */
export function updateAgent(cwd: string, id: string, patch: UpdateAgentRequest): AgentDefinition {
  if (!AGENT_ID_REGEX.test(id))
    throw new AgentCreateError('INVALID_ID', 'Agent id 需匹配 [a-z][a-z0-9-]{1,63}');
  const directory = join(cwd, '.codex', 'agents');
  const target = join(directory, `${id}.md`);
  if (!existsSync(target)) throw new AgentCreateError('NOT_FOUND', `Agent 不存在：${id}`);
  const current = parseAgentFile(directory, `${id}.md`);
  const merged: AgentFieldValues = {
    name: patch.name ?? current.name,
    mark: patch.mark ?? current.mark,
    tagline: patch.tagline ?? current.tagline,
    description: patch.description ?? current.description,
    suggestions: patch.suggestions ?? current.suggestions,
    body: patch.body ?? current.body,
  };
  const file = serializeAgentFile(validateAgentFields(merged));
  const temporary = join(directory, `.${id}.md.tmp-${process.pid}`);
  writeFileSync(temporary, file, 'utf8');
  renameSync(temporary, target);
  // Roundtrip through the real parser so a serialization bug can never persist a broken file.
  return parseAgentFile(directory, `${id}.md`);
}

export type AgentDefinition = AgentDetail;

function requiredString(value: unknown, field: string, path: string): string {
  if (typeof value !== 'string' || !value.trim())
    throw new Error(`Agent 定义字段 ${field} 必须是非空字符串：${path}`);
  return value.trim();
}

function parseAgentFile(directory: string, fileName: string): AgentDefinition {
  const id = fileName.replace(/\.md$/i, '');
  const path = join(directory, fileName);
  return parseAgentContent(id, path, readFileSync(path, 'utf8'));
}

function parseAgentContent(id: string, path: string, raw: string): AgentDefinition {
  if (!AGENT_ID_REGEX.test(id)) throw new Error(`Agent 文件名不是合法 id：${id}.md`);
  const { frontmatter, body } = parseFrontmatter(raw);
  const name = requiredString(frontmatter.name, 'name', path);
  const mark = requiredString(frontmatter.mark, 'mark', path);
  const tagline = requiredString(frontmatter.tagline, 'tagline', path);
  const description = requiredString(frontmatter.description, 'description', path);
  const suggestions = frontmatter.suggestions;
  if (
    !Array.isArray(suggestions) ||
    !suggestions.length ||
    suggestions.some((item) => typeof item !== 'string' || !item.trim())
  ) {
    throw new Error(`Agent 定义字段 suggestions 必须是非空字符串数组：${path}`);
  }
  const systemPrompt = body.trim();
  if (!systemPrompt) throw new Error(`Agent 定义缺少系统提示词正文：${path}`);
  return {
    id,
    name,
    mark,
    tagline,
    description,
    suggestions: suggestions.map((item) => item.trim()),
    body: systemPrompt,
    path: `.codex/agents/${id}.md`,
  };
}

/** Imports one complete Markdown definition through the same validation and serializer as create. */
export function importAgent(cwd: string, input: ImportAgentRequest): AgentDefinition {
  const id = input.id.trim();
  if (!AGENT_ID_REGEX.test(id))
    throw new AgentCreateError('INVALID_ID', 'Agent id 需匹配 [a-z][a-z0-9-]{1,63}');
  let parsed: AgentDefinition;
  try {
    parsed = parseAgentContent(id, `${id}.md`, input.content);
  } catch (error) {
    throw new AgentCreateError(
      'INVALID_FIELD',
      error instanceof Error ? error.message : 'Agent Markdown 定义不合法',
    );
  }
  return createAgent(cwd, {
    id,
    name: parsed.name,
    mark: parsed.mark,
    tagline: parsed.tagline,
    description: parsed.description,
    suggestions: parsed.suggestions,
    body: parsed.body,
  });
}

/** Returns the exact on-disk definition source for download/export. */
export function readAgentSource(cwd: string, id: string): string {
  if (!AGENT_ID_REGEX.test(id))
    throw new AgentCreateError('INVALID_ID', 'Agent id 需匹配 [a-z][a-z0-9-]{1,63}');
  const target = join(cwd, '.codex', 'agents', `${id}.md`);
  if (!existsSync(target)) throw new AgentCreateError('NOT_FOUND', `Agent 不存在：${id}`);
  return readFileSync(target, 'utf8');
}

/** Removes one definition file. Session cleanup is coordinated by the API before this call. */
export function deleteAgent(cwd: string, id: string): void {
  if (!AGENT_ID_REGEX.test(id))
    throw new AgentCreateError('INVALID_ID', 'Agent id 需匹配 [a-z][a-z0-9-]{1,63}');
  const target = join(cwd, '.codex', 'agents', `${id}.md`);
  if (!existsSync(target)) throw new AgentCreateError('NOT_FOUND', `Agent 不存在：${id}`);
  rmSync(target);
}

/**
 * File-first agent registry: every .codex/agents/<id>.md is an agent.
 * Adding a file adds an agent; no registry or capability profile is involved.
 */
export function loadAgents(cwd: string): AgentDefinition[] {
  const directory = join(cwd, '.codex', 'agents');
  if (!existsSync(directory)) return [];
  const agents: AgentDefinition[] = [];
  for (const fileName of readdirSync(directory)
    .filter((fileName) => fileName.toLowerCase().endsWith('.md'))
    .sort((left, right) => left.localeCompare(right))) {
    try {
      agents.push(parseAgentFile(directory, fileName));
    } catch {
      // 单个坏文件跳过即可，不应拖垮整个 Agent 列表（与 skills lockfile 的容错一致）。
    }
  }
  return agents;
}

export function getAgent(cwd: string, agentId: string): AgentDefinition {
  const agent = loadAgents(cwd).find((item) => item.id === agentId);
  if (!agent) throw new Error(`Agent 不存在：${agentId}`);
  return agent;
}

export function agentSummary(agent: AgentDefinition): AgentSummary {
  const { id, name, mark, tagline, description, suggestions } = agent;
  return { id, name, mark, tagline, description, suggestions };
}

function previewOf(raw: string): string | undefined {
  const text = stripFrontmatter(raw).trim().replace(/\s+/g, ' ');
  return text ? text.slice(0, PREVIEW_LENGTH) : undefined;
}

/** Lists .codex/prompts/*.md as prompt templates; the name is the filename without extension. */
export function listPrompts(cwd: string): PromptSummary[] {
  const directory = join(cwd, '.codex', 'prompts');
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((fileName) => fileName.toLowerCase().endsWith('.md'))
    .sort((left, right) => left.localeCompare(right))
    .map((fileName) => {
      const name = fileName.replace(/\.md$/i, '');
      const raw = readFileSync(join(directory, fileName), 'utf8');
      const { frontmatter } = parseFrontmatter(raw);
      const description =
        typeof frontmatter.description === 'string' && frontmatter.description.trim()
          ? frontmatter.description.trim()
          : undefined;
      const preview = previewOf(raw);
      return {
        name,
        path: `.codex/prompts/${fileName}`,
        ...(description ? { description } : {}),
        ...(preview ? { preview } : {}),
      };
    });
}

/**
 * Lists .codex/skills/<dir>/SKILL.md entries; an absent or empty directory yields [].
 * Skills are third-party content: entries without readable frontmatter fall back
 * to the directory name instead of failing the whole list.
 */
export function listSkills(cwd: string): SkillSummary[] {
  const directory = join(cwd, '.codex', 'skills');
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(directory, entry.name, 'SKILL.md')))
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => {
      const path = `.codex/skills/${entry.name}/SKILL.md`;
      const raw = readFileSync(join(cwd, path), 'utf8');
      const { frontmatter } = parseFrontmatter(raw);
      const name =
        typeof frontmatter.name === 'string' && frontmatter.name.trim()
          ? frontmatter.name.trim()
          : entry.name;
      const description =
        typeof frontmatter.description === 'string' && frontmatter.description.trim()
          ? frontmatter.description.trim()
          : undefined;
      const preview = previewOf(raw);
      return {
        name,
        path,
        ...(description ? { description } : {}),
        ...(preview ? { preview } : {}),
      };
    });
}

/**
 * Reads the skills CLI lockfile (skills-lock.json, version 1) as name → "owner/repo".
 * A missing or malformed lockfile yields an empty map — sources are informational only.
 */
function readSkillsLockSources(cwd: string): Map<string, string> {
  const target = join(cwd, 'skills-lock.json');
  const sources = new Map<string, string>();
  if (!existsSync(target)) return sources;
  try {
    const parsed = JSON.parse(readFileSync(target, 'utf8')) as {
      skills?: Record<string, { source?: unknown }>;
    };
    for (const [name, entry] of Object.entries(parsed.skills ?? {})) {
      if (typeof entry?.source === 'string' && entry.source.trim())
        sources.set(name, entry.source.trim());
    }
  } catch {
    // 坏 lockfile 不应拖垮技能列表。
  }
  return sources;
}

/**
 * Lists every locally installed skill: .agents/skills (skills CLI, scope 'agents')
 * plus .codex/skills (project-provided or manually uploaded, scope 'codex').
 * Sources come from skills-lock.json by directory name. Absent directories yield [].
 */
export function listInstalledSkills(cwd: string): InstalledSkillSummary[] {
  const sources = readSkillsLockSources(cwd);
  const items: InstalledSkillSummary[] = [];
  for (const scope of ['agents', 'codex'] as const) {
    const base = scope === 'agents' ? '.agents/skills' : '.codex/skills';
    const directory = join(cwd, base);
    if (!existsSync(directory)) continue;
    for (const entry of readdirSync(directory, { withFileTypes: true })
      .filter((item) => item.isDirectory() && existsSync(join(directory, item.name, 'SKILL.md')))
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const path = `${base}/${entry.name}/SKILL.md`;
      const raw = readFileSync(join(cwd, path), 'utf8');
      const { frontmatter } = parseFrontmatter(raw);
      const name =
        typeof frontmatter.name === 'string' && frontmatter.name.trim()
          ? frontmatter.name.trim()
          : entry.name;
      const description =
        typeof frontmatter.description === 'string' && frontmatter.description.trim()
          ? frontmatter.description.trim()
          : undefined;
      const preview = previewOf(raw);
      const source = scope === 'agents' ? sources.get(entry.name) : undefined;
      items.push({
        name,
        path,
        scope,
        ...(description ? { description } : {}),
        ...(preview ? { preview } : {}),
        ...(source ? { source } : {}),
      });
    }
  }
  return items;
}

/** 匹配 SKILL.md 顶部的 YAML frontmatter 块（捕获组为不含 --- 的原文）。 */
const FRONTMATTER_BLOCK = /^---\r?\n([\s\S]*?)\r?\n---/;

/**
 * Reads one installed skill's full SKILL.md. The entry is located through the same
 * scan as listInstalledSkills (name = frontmatter name or directory name), and the
 * path it yields is built from directory entries only — no traversal is possible.
 * Returns undefined when no entry matches scope + name.
 */
export function readInstalledSkillContent(
  cwd: string,
  scope: 'codex' | 'agents',
  name: string,
): InstalledSkillContent | undefined {
  const item = listInstalledSkills(cwd).find(
    (entry) => entry.scope === scope && entry.name === name,
  );
  if (!item) return undefined;
  const raw = readFileSync(join(cwd, item.path), 'utf8');
  const frontmatter = FRONTMATTER_BLOCK.exec(raw)?.[1]?.trim();
  return {
    name: item.name,
    scope: item.scope,
    ...(item.description ? { description: item.description } : {}),
    ...(item.source ? { source: item.source } : {}),
    content: stripFrontmatter(raw).trim(),
    ...(frontmatter ? { frontmatter } : {}),
  };
}

/**
 * Removes one project skill (.codex/skills/<dir>) installed by hand or by uploadSkill.
 * Skills CLI entries (.agents/skills) must go through `npx skills remove` instead.
 * Returns false when no .codex/skills entry matches the name.
 */
export function removeProjectSkill(cwd: string, name: string): boolean {
  const item = listInstalledSkills(cwd).find(
    (entry) => entry.scope === 'codex' && entry.name === name,
  );
  if (!item) return false;
  rmSync(join(cwd, dirname(item.path)), { recursive: true, force: true });
  return true;
}

export type SkillUploadErrorCode = 'INVALID_NAME' | 'CONFLICT' | 'TOO_LARGE';

/** Validation failure while uploading a SKILL.md; the API maps `code` onto HTTP statuses. */
export class SkillUploadError extends Error {
  readonly code: SkillUploadErrorCode;
  constructor(code: SkillUploadErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** Hard cap for one uploaded SKILL.md; enforced again at the API schema. */
export const SKILL_CONTENT_MAX_BYTES = 128 * 1024;
const SKILL_NAME_REGEX = /^[a-z0-9-]{1,80}$/;

/**
 * Writes .codex/skills/<name>/SKILL.md from a manual upload. When the content has no
 * YAML frontmatter block, one is synthesized from name/description (JSON-quoted
 * scalars are valid YAML). 'wx' makes the write fail on conflicts, mirroring createAgent.
 */
export function uploadSkill(cwd: string, input: UploadSkillRequest): InstalledSkillSummary {
  const name = input.name.trim();
  if (!SKILL_NAME_REGEX.test(name))
    throw new SkillUploadError('INVALID_NAME', '技能名称需匹配 [a-z0-9-]{1,80}');
  const content = input.content.trim();
  if (!content) throw new SkillUploadError('INVALID_NAME', '技能内容不能为空');
  if (Buffer.byteLength(content, 'utf8') > SKILL_CONTENT_MAX_BYTES)
    throw new SkillUploadError('TOO_LARGE', `技能内容超过 ${SKILL_CONTENT_MAX_BYTES} 字节上限`);

  const file = FRONTMATTER_BLOCK.test(content)
    ? `${content}\n`
    : [
        '---',
        `name: ${yamlScalar(name)}`,
        ...(input.description?.trim()
          ? [`description: ${yamlScalar(input.description.trim())}`]
          : []),
        '---',
        '',
        content,
        '',
      ].join('\n');

  const directory = join(cwd, '.codex', 'skills', name);
  const target = join(directory, 'SKILL.md');
  if (existsSync(target)) throw new SkillUploadError('CONFLICT', `技能已存在：${name}`);
  mkdirSync(directory, { recursive: true });
  try {
    writeFileSync(target, file, { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST')
      throw new SkillUploadError('CONFLICT', `技能已存在：${name}`);
    throw error;
  }
  // Roundtrip through the real scanner so the response matches the installed list.
  const summary = listInstalledSkills(cwd).find(
    (entry) => entry.scope === 'codex' && entry.path === `.codex/skills/${name}/SKILL.md`,
  );
  if (!summary) throw new Error(`技能写入后无法回读：${name}`);
  return summary;
}

/** Reads one prompt template body; the name pattern blocks path traversal by construction. */
export function readPrompt(cwd: string, name: string): PromptDocument | undefined {
  if (!PROMPT_NAME_REGEX.test(name)) return undefined;
  const summary = listPrompts(cwd).find((prompt) => prompt.name === name);
  if (!summary) return undefined;
  const content = stripFrontmatter(readFileSync(join(cwd, summary.path), 'utf8')).trim();
  return { ...summary, content };
}

/**
 * Rewrites .codex/prompts/<name>.md in place: the new content becomes the body,
 * `description` (when provided) replaces the frontmatter field, and every other
 * frontmatter entry keeps its current value. The write is atomic (temp + rename),
 * same as updateAgent.
 */
export function writePrompt(cwd: string, name: string, input: UpdatePromptRequest): PromptDocument {
  if (!PROMPT_NAME_REGEX.test(name))
    throw new AgentCreateError('INVALID_ID', `提示词名称不合法：${name}`);
  const summary = listPrompts(cwd).find((prompt) => prompt.name === name);
  if (!summary) throw new AgentCreateError('NOT_FOUND', `提示词不存在：${name}`);
  const content = input.content.trim();
  if (!content) throw new AgentCreateError('INVALID_FIELD', '提示词正文不能为空');

  const directory = join(cwd, '.codex', 'prompts');
  const fileName = `${name}.md`;
  const { frontmatter } = parseFrontmatter(readFileSync(join(directory, fileName), 'utf8'));
  const description = input.description?.trim();
  const entries: Record<string, unknown> = { ...frontmatter };
  if (description) entries.description = description;

  const lines: string[] = [];
  for (const [key, value] of Object.entries(entries)) {
    if (typeof value === 'string') lines.push(`${key}: ${yamlScalar(value)}`);
    else if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
      lines.push(`${key}:`, ...value.map((item) => `  - ${yamlScalar(item)}`));
    }
    // 非标量 frontmatter 字段（少见）直接丢弃，避免序列化出坏 YAML。
  }
  const file = ['---', ...lines, '---', '', content, ''].join('\n');
  const temporary = join(directory, `.${fileName}.tmp-${process.pid}`);
  writeFileSync(temporary, file, 'utf8');
  renameSync(temporary, join(directory, fileName));
  // Roundtrip through the reader so a serialization bug can never persist a broken file.
  const document = readPrompt(cwd, name);
  if (!document) throw new Error(`提示词写入后无法回读：${name}`);
  return document;
}

/** Reads .codex/APPEND_SYSTEM.md trimmed; null when the file is absent. */
export function readAppendSystem(cwd: string): string | null {
  const target = join(cwd, '.codex', 'APPEND_SYSTEM.md');
  if (!existsSync(target)) return null;
  return readFileSync(target, 'utf8').trim();
}

/**
 * Writes .codex/APPEND_SYSTEM.md atomically; empty (trimmed) content deletes the
 * file —「未配置」语义. Returns the normalized content, or null after a delete.
 */
export function writeAppendSystem(cwd: string, content: string): string | null {
  const target = join(cwd, '.codex', 'APPEND_SYSTEM.md');
  const normalized = content.trim();
  if (!normalized) {
    rmSync(target, { force: true });
    return null;
  }
  const directory = join(cwd, '.codex');
  mkdirSync(directory, { recursive: true });
  const temporary = join(directory, `.APPEND_SYSTEM.md.tmp-${process.pid}`);
  writeFileSync(temporary, `${normalized}\n`, 'utf8');
  renameSync(temporary, target);
  return normalized;
}

/**
 * Lists the project resources every agent sees: .codex/prompts, .codex/skills and
 * whether .codex/APPEND_SYSTEM.md exists. Resources are project-wide, so the
 * result is identical for all agents; the API exposes it per agent to match
 * the configure panel's shape.
 */
export function listAgentResources(cwd: string): Omit<AgentResources, 'stats'> {
  return {
    prompts: listPrompts(cwd),
    skills: listSkills(cwd),
    appendSystem: existsSync(join(cwd, '.codex', 'APPEND_SYSTEM.md')),
  };
}
