import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  AGENT_ID_PATTERN,
  type AgentDetail,
  type AgentProfileSectionItem,
  type AgentResources,
  type AgentSummary,
  type CreateAgentRequest,
  type ImportAgentRequest,
  type PromptDocument,
  type PromptSummary,
  type SkillSummary,
  type UpdateAgentRequest,
  type UpdatePromptRequest,
} from '@waker/contracts';
import { parseFrontmatter, stripFrontmatter } from './frontmatter.js';
import { listInstalledSkills } from './skills.js';

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
  /** Optional avatar file name (.codex/agents/<id>.avatar.<ext>); written only by writeAgentAvatar. */
  avatar?: string;
  suggestions: string[];
  body: string;
  /** Optional 关于我 sections (我最擅长 / 工作风格); round-tripped through the frontmatter. */
  strengths?: AgentProfileSectionItem[];
  workStyles?: AgentProfileSectionItem[];
}

/** Validates one optional profile section: every item must carry non-empty single-line title/text. */
function validateProfileSection(
  value: AgentProfileSectionItem[] | undefined,
  field: string,
): AgentProfileSectionItem[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value))
    throw new AgentCreateError('INVALID_FIELD', `Agent 字段 ${field} 必须是条目数组`);
  return value.map((item) => ({
    title: assertSingleLine(item?.title, `${field}.title`),
    text: assertSingleLine(item?.text, `${field}.text`),
  }));
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
  const strengths = validateProfileSection(input.strengths, 'strengths');
  const workStyles = validateProfileSection(input.workStyles, 'workStyles');
  return {
    name,
    mark,
    tagline,
    description,
    suggestions,
    body,
    ...(input.avatar ? { avatar: input.avatar } : {}),
    ...(strengths?.length ? { strengths } : {}),
    ...(workStyles?.length ? { workStyles } : {}),
  };
}

/** Serializes one optional profile section as a YAML list of {title, text} maps. */
function serializeProfileSection(field: string, items: AgentProfileSectionItem[]): string[] {
  return [
    `${field}:`,
    ...items.flatMap((item) => [
      `  - title: ${yamlScalar(item.title)}`,
      `    text: ${yamlScalar(item.text)}`,
    ]),
  ];
}

/** Serializes validated fields to the .codex/agents/<id>.md file content. */
function serializeAgentFile(fields: AgentFieldValues): string {
  return [
    '---',
    `name: ${yamlScalar(fields.name)}`,
    `mark: ${yamlScalar(fields.mark)}`,
    `tagline: ${yamlScalar(fields.tagline)}`,
    `description: ${yamlScalar(fields.description)}`,
    ...(fields.avatar ? [`avatar: ${yamlScalar(fields.avatar)}`] : []),
    'suggestions:',
    ...fields.suggestions.map((item) => `  - ${yamlScalar(item)}`),
    ...(fields.strengths?.length ? serializeProfileSection('strengths', fields.strengths) : []),
    ...(fields.workStyles?.length ? serializeProfileSection('workStyles', fields.workStyles) : []),
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
    // 头像文件由 writeAgentAvatar 单独管理；普通 PATCH 不改动但必须保留该字段。
    ...(current.avatar ? { avatar: current.avatar } : {}),
    suggestions: patch.suggestions ?? current.suggestions,
    body: patch.body ?? current.body,
    // 关于我区块不由配置面板编辑；PATCH 时必须原样保留。
    ...(current.strengths ? { strengths: current.strengths } : {}),
    ...(current.workStyles ? { workStyles: current.workStyles } : {}),
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
  const agent = parseAgentContent(id, path, readFileSync(path, 'utf8'));
  // 头像引用指向缺失文件时按无头像处理（定义文件保持原样，不重写）。
  if (agent.avatar && !existsSync(join(directory, agent.avatar))) {
    const { avatar: _dropped, ...rest } = agent;
    return rest;
  }
  return agent;
}

const AGENT_AVATAR_FILE = /^[a-z][a-z0-9-]{1,63}\.avatar\.(png|jpg)$/;

/** Parses one optional frontmatter profile section; malformed entries drop the whole section. */
function parseProfileSection(value: unknown): AgentProfileSectionItem[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items: AgentProfileSectionItem[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') return undefined;
    const { title, text } = entry as Record<string, unknown>;
    if (typeof title !== 'string' || !title.trim()) return undefined;
    if (typeof text !== 'string' || !text.trim()) return undefined;
    items.push({ title: title.trim(), text: text.trim() });
  }
  return items.length ? items : undefined;
}

function parseAgentContent(id: string, path: string, raw: string): AgentDefinition {
  if (!AGENT_ID_REGEX.test(id)) throw new Error(`Agent 文件名不是合法 id：${id}.md`);
  const { frontmatter, body } = parseFrontmatter(raw);
  const name = requiredString(frontmatter.name, 'name', path);
  const mark = requiredString(frontmatter.mark, 'mark', path);
  const tagline = requiredString(frontmatter.tagline, 'tagline', path);
  const description = requiredString(frontmatter.description, 'description', path);
  // avatar 是可选字段；只接受约定形状 <id>.avatar.(png|jpg)，其他取值按无头像处理。
  const avatarValue = typeof frontmatter.avatar === 'string' ? frontmatter.avatar.trim() : '';
  const avatar =
    AGENT_AVATAR_FILE.test(avatarValue) && avatarValue.startsWith(`${id}.`) ? avatarValue : undefined;
  const strengths = parseProfileSection(frontmatter.strengths);
  const workStyles = parseProfileSection(frontmatter.workStyles);
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
    ...(avatar ? { avatar } : {}),
    suggestions: suggestions.map((item) => item.trim()),
    body: systemPrompt,
    ...(strengths ? { strengths } : {}),
    ...(workStyles ? { workStyles } : {}),
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
    ...(parsed.strengths ? { strengths: parsed.strengths } : {}),
    ...(parsed.workStyles ? { workStyles: parsed.workStyles } : {}),
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

/** 入职时间：定义文件的 birthtime；文件缺失或文件系统不提供 birthtime 时返回 null。 */
export function agentCreatedAt(cwd: string, id: string): string | null {
  if (!AGENT_ID_REGEX.test(id)) return null;
  const target = join(cwd, '.codex', 'agents', `${id}.md`);
  try {
    const { birthtimeMs } = statSync(target);
    // 部分文件系统 birthtime 为 0（不支持），按不可用处理。
    return birthtimeMs > 0 ? new Date(birthtimeMs).toISOString() : null;
  } catch {
    return null;
  }
}

/** Removes one definition file and its avatar. Session cleanup is coordinated by the API before this call. */
export function deleteAgent(cwd: string, id: string): void {
  if (!AGENT_ID_REGEX.test(id))
    throw new AgentCreateError('INVALID_ID', 'Agent id 需匹配 [a-z][a-z0-9-]{1,63}');
  const directory = join(cwd, '.codex', 'agents');
  const target = join(directory, `${id}.md`);
  if (!existsSync(target)) throw new AgentCreateError('NOT_FOUND', `Agent 不存在：${id}`);
  rmSync(target);
  for (const ext of ['png', 'jpg']) rmSync(join(directory, `${id}.avatar.${ext}`), { force: true });
}

/**
 * Rewrites only the 关于我 profile sections (strengths/workStyles) of .codex/agents/<id>.md:
 * every other frontmatter field and the persona body keep their current values. Sections
 * passed as undefined are removed; omitted keys are left untouched. Atomic (temp + rename).
 * Used by the summarize-profile endpoint when apply=true persists model-derived sections.
 */
export function writeAgentProfileSections(
  cwd: string,
  id: string,
  sections: { strengths?: AgentProfileSectionItem[]; workStyles?: AgentProfileSectionItem[] },
): AgentDefinition {
  if (!AGENT_ID_REGEX.test(id))
    throw new AgentCreateError('INVALID_ID', 'Agent id 需匹配 [a-z][a-z0-9-]{1,63}');
  const directory = join(cwd, '.codex', 'agents');
  const target = join(directory, `${id}.md`);
  if (!existsSync(target)) throw new AgentCreateError('NOT_FOUND', `Agent 不存在：${id}`);
  const current = parseAgentFile(directory, `${id}.md`);
  const strengths =
    'strengths' in sections ? validateProfileSection(sections.strengths, 'strengths') : current.strengths;
  const workStyles =
    'workStyles' in sections
      ? validateProfileSection(sections.workStyles, 'workStyles')
      : current.workStyles;
  const file = serializeAgentFile(
    validateAgentFields({
      ...current,
      ...(strengths?.length ? { strengths } : {}),
      ...(workStyles?.length ? { workStyles } : {}),
    }),
  );
  const temporary = join(directory, `.${id}.md.tmp-${process.pid}`);
  writeFileSync(temporary, file, 'utf8');
  renameSync(temporary, target);
  // Roundtrip through the real parser so a serialization bug can never persist a broken file.
  return parseAgentFile(directory, `${id}.md`);
}

/** 头像上限与 legacy 一致：PNG / JPG，不超过 2 MB。 */
export const AGENT_AVATAR_MAX_BYTES = 2 * 1024 * 1024;
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * Detects the avatar extension from the declared mime type plus magic bytes;
 * returns undefined when the bytes do not match a real PNG/JPG.
 */
function avatarExtensionFor(mimeType: string, data: Buffer): 'png' | 'jpg' | undefined {
  if (mimeType === 'image/png')
    return PNG_MAGIC.every((byte, index) => data[index] === byte) ? 'png' : undefined;
  if (mimeType === 'image/jpeg')
    return data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff ? 'jpg' : undefined;
  return undefined;
}

/**
 * Writes .codex/agents/<id>.avatar.<ext> and records it in the definition's
 * frontmatter. Both writes are atomic (temp file + rename), and the frontmatter
 * update goes through the shared serializer/validator.
 */
export function writeAgentAvatar(
  cwd: string,
  id: string,
  input: { mimeType: string; data: Buffer },
): AgentDefinition {
  if (!AGENT_ID_REGEX.test(id))
    throw new AgentCreateError('INVALID_ID', 'Agent id 需匹配 [a-z][a-z0-9-]{1,63}');
  const directory = join(cwd, '.codex', 'agents');
  if (!existsSync(join(directory, `${id}.md`)))
    throw new AgentCreateError('NOT_FOUND', `Agent 不存在：${id}`);
  if (!input.data.length || input.data.length > AGENT_AVATAR_MAX_BYTES)
    throw new AgentCreateError('TOO_LARGE', `头像文件不能超过 ${AGENT_AVATAR_MAX_BYTES / 1024 / 1024} MB`);
  const ext = avatarExtensionFor(input.mimeType, input.data);
  if (!ext) throw new AgentCreateError('INVALID_FIELD', '头像仅支持 PNG / JPG 图片');

  const current = parseAgentFile(directory, `${id}.md`);
  const fileName = `${id}.avatar.${ext}`;
  const temporary = join(directory, `.${fileName}.tmp-${process.pid}`);
  writeFileSync(temporary, input.data);
  renameSync(temporary, join(directory, fileName));
  if (current.avatar && current.avatar !== fileName)
    rmSync(join(directory, current.avatar), { force: true });

  const file = serializeAgentFile(validateAgentFields({ ...current, avatar: fileName }));
  const temporaryMd = join(directory, `.${id}.md.tmp-${process.pid}`);
  writeFileSync(temporaryMd, file, 'utf8');
  renameSync(temporaryMd, join(directory, `${id}.md`));
  return parseAgentFile(directory, `${id}.md`);
}

function readDefinitionAvatar(
  directory: string,
  id: string,
): { data: Buffer; mimeType: string } | undefined {
  if (!AGENT_ID_REGEX.test(id)) return undefined;
  if (!existsSync(join(directory, `${id}.md`))) return undefined;
  const { avatar } = parseAgentFile(directory, `${id}.md`);
  if (!avatar) return undefined;
  const target = join(directory, avatar);
  if (!existsSync(target)) return undefined;
  return {
    data: readFileSync(target),
    mimeType: avatar.endsWith('.png') ? 'image/png' : 'image/jpeg',
  };
}

/** Reads the avatar bytes and mime type; undefined when the agent has no avatar. */
export function readAgentAvatar(
  cwd: string,
  id: string,
): { data: Buffer; mimeType: string } | undefined {
  return readDefinitionAvatar(join(cwd, '.codex', 'agents'), id);
}

/** Reads a read-only role-template avatar from its sidecar file. */
export function readAgentTemplateAvatar(
  cwd: string,
  id: string,
): { data: Buffer; mimeType: string } | undefined {
  return readDefinitionAvatar(join(cwd, '.codex', 'agent-templates'), id);
}

/**
 * File-first definition loader shared by agents (.codex/agents) and role
 * templates (.codex/agent-templates): every <id>.md is parsed, bad files are
 * skipped instead of failing the whole list.
 */
export function loadAgentDefinitions(directory: string): AgentDefinition[] {
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

/**
 * File-first agent registry: every .codex/agents/<id>.md is an agent.
 * Adding a file adds an agent; no registry or capability profile is involved.
 */
export function loadAgents(cwd: string): AgentDefinition[] {
  return loadAgentDefinitions(join(cwd, '.codex', 'agents'));
}

export function getAgent(cwd: string, agentId: string): AgentDefinition {
  const agent = loadAgents(cwd).find((item) => item.id === agentId);
  if (!agent) throw new Error(`Agent 不存在：${agentId}`);
  return agent;
}

export function agentSummary(agent: AgentDefinition): AgentSummary {
  const { id, name, mark, tagline, description, suggestions } = agent;
  return {
    id,
    name,
    mark,
    tagline,
    description,
    suggestions,
    ...(agent.avatar ? { hasAvatar: true } : {}),
  };
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
 * Lists runtime-available repo skills. The richer inventory is exposed by
 * listInstalledSkills; this projection keeps AgentResources compact.
 */
export function listSkills(cwd: string): SkillSummary[] {
  return listInstalledSkills(cwd)
    .filter((skill) => skill.availability === 'available' && skill.valid)
    .map(({ name, path, description, preview }) => ({
      name,
      path,
      ...(description ? { description } : {}),
      ...(preview ? { preview } : {}),
    }));
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
