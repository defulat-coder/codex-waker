import { resolve } from 'node:path';
import type { CodexOptions } from '@openai/codex-sdk';
import { listInstalledSkills } from './skills.js';

/** 会话级技能挂载列表的长度上限（与 API schema 的 maxItems 对齐）。 */
export const SESSION_SKILLS_MAX = 32;

/**
 * 规范化挂载列表：trim、去空、去重（保持首次出现顺序）。
 * 合法性格式（[a-z0-9-] 等）由 API schema 保证，这里只做形状收敛。
 */
export function normalizeSessionSkillNames(skills: string[]): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const raw of skills) {
    const name = raw.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

/**
 * 对照项目技能目录（.agents/skills + .codex/skills，不含 .system）校验挂载列表，
 * 返回不在目录里的名字；空数组 = 全部可挂载。
 */
export function unknownSessionSkillNames(cwd: string, skills: string[]): string[] {
  const catalog = new Set(listInstalledSkills(cwd).map((skill) => skill.name));
  return normalizeSessionSkillNames(skills).filter((name) => !catalog.has(name));
}

/**
 * 会话级 skill 挂载的 CLI 注入口：codex CLI 0.149 的 `skills.config` 配置项支持按
 * SKILL.md 绝对路径 enable/disable 单个技能（config-schema.json 的 SkillConfig），
 * SDK CodexOptions.config 会把它序列化成 `-c skills.config=[{path=...,enabled=false}]`。
 *
 * 挂载语义是白名单：skills 未定义 → 不注入任何覆盖（CLI 默认全量发现）；
 * 定义（含空数组）→ 目录里未挂载的技能逐条 path 级禁用，该会话只看到挂载的子集。
 * 已挂载的技能本来就在发现路径上（ambient），无需额外的 enable 条目；
 * CLI 自带的 .system 技能不在目录里，不受挂载影响。
 */
export function sessionSkillConfigOverrides(
  cwd: string,
  skills: string[] | undefined,
): CodexOptions['config'] | undefined {
  if (skills === undefined) return undefined;
  const mounted = new Set(normalizeSessionSkillNames(skills));
  const disabled = listInstalledSkills(cwd)
    .filter((skill) => !mounted.has(skill.name))
    .map((skill) => ({ path: resolve(cwd, skill.path), enabled: false }));
  return { skills: { config: disabled } };
}
