import type {
  AgentSummary,
  AgentTemplate,
  CreateAgentRequest,
  LibrarySkillSummary,
} from '@waker/contracts';

/** EXPLORE 组的三个视图；同一时间至多打开一个。 */
export type ExploreView = 'agents' | 'templates' | 'skills';

/** 内置 agent 模板常量由后端 GET /api/v1/templates 提供；这里只保留组装逻辑。 */
export type { AgentTemplate };

/** 用模板字段组装创建请求；id 可被用户覆盖。 */
export function templateToCreateRequest(template: AgentTemplate, id?: string): CreateAgentRequest {
  return {
    id: (id ?? template.id).trim(),
    name: template.name,
    mark: template.mark,
    tagline: template.tagline,
    description: template.description,
    suggestions: [...template.suggestions],
    body: template.body,
    // 关于我区块随模板带入新 Agent；没有则不传（不造数据）。
    ...(template.strengths
      ? { strengths: template.strengths.map((item) => ({ ...item })) }
      : {}),
    ...(template.workStyles
      ? { workStyles: template.workStyles.map((item) => ({ ...item })) }
      : {}),
  };
}

/** 旧实现 blank-create defaults projected onto the required local Markdown fields. */
export function blankAgentRequest(
  name: string,
  description: string,
  id?: string,
  mark?: string,
): CreateAgentRequest {
  const cleanName = name.trim();
  const cleanDescription = description.trim();
  const words = cleanName.split(/\s+/).filter(Boolean);
  const derivedMark =
    words.length > 1
      ? words
          .slice(0, 2)
          .map((word) => [...word][0])
          .join('')
          .toUpperCase()
      : [...cleanName].slice(0, 2).join('').toUpperCase();
  const summary = cleanDescription || `${cleanName} 的自定义工作区 Agent。`;
  return {
    ...(id?.trim() ? { id: id.trim() } : {}),
    name: cleanName,
    mark: mark?.trim() || derivedMark,
    tagline: cleanDescription || '自定义 Agent',
    description: summary,
    suggestions: ['介绍一下你能做什么', '从哪里开始最合适？'],
    body: `你是 ${cleanName}。${cleanDescription || '请根据用户目标提供清晰、可靠且可执行的帮助。'}`,
  };
}

/** 创建工作区 Agent 卡片上的统计数字：建议问题数 + 会话数（缺省按 0）。 */
export function agentCardStats(agent: AgentSummary): {
  suggestionCount: number;
  sessionCount: number;
} {
  return { suggestionCount: agent.suggestions.length, sessionCount: agent.sessionCount ?? 0 };
}

/** 技能库卡片的紧凑安装量：3100000 → "3.1M"，653000 → "653K"。 */
export function formatInstallCount(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (count >= 1_000)
    return `${(count / 1_000).toFixed(count >= 100_000 ? 0 : 1).replace(/\.0$/, '')}K`;
  return String(count);
}

/** 技能库条目的来源 owner：source 为 "owner/repo"，取斜杠前一段（无斜杠时整段即 owner）。 */
export function librarySkillOwner(source: string): string {
  return source.split('/')[0] || source;
}

/**
 * skills.sh 没有分类数据：技能库弹窗的「来源」分组改用当前结果集的 owner
 * （旧实现 的 CATEGORIES 在本地无语义，此为记录在案的偏差）。按数量降序、同名按字典序。
 */
export function groupLibraryOwners(
  items: LibrarySkillSummary[],
): Array<{ owner: string; count: number }> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const owner = librarySkillOwner(item.source);
    counts.set(owner, (counts.get(owner) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([owner, count]) => ({ owner, count }))
    .sort((a, b) => b.count - a.count || a.owner.localeCompare(b.owner));
}
