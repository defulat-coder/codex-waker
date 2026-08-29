/**
 * Waker 设定的「三上下文文件」小节约定（复刻 QoderWake 0.4.2 设置页的 01 身份 / 02 人设 / 03 设定集）。
 *
 * 存储契约不变：仍是单文件 .codex/agents/<id>.md 的自由 Markdown body。展示层按 H2 小节三分区：
 *   ## 身份   → 01 身份（IDENTITY）
 *   ## 人设   → 02 人设（PERSONA）
 *   ## 设定集 → 03 设定集（BIBLE）
 * 只有 body 同时含且仅含这三个 H2（各恰好一次，允许任意顺序与前言）才视为「符合约定」；
 * 缺任一、三个都没有或重复出现都回退整段模式——绝不为存量 agent 伪造分段。
 *
 * 拼接往返设计：解析产出有序 chunk 列表（raw 原文 + section 段），section 段保留标题行与正文
 * 原文。rebuildAgentBody 对未编辑的 chunk 逐字节回写，只有被编辑段的正文归一化为 trim + 单个
 * 结尾换行；因此「解析后不编辑直接拼回」是无损的（round-trip identity）。
 */

export type AgentSectionId = 'identity' | 'persona' | 'bible';

/** 卡片元信息：编号、标题、区块标签与旧版 placeholder 文案。 */
export const AGENT_SECTION_META: Record<
  AgentSectionId,
  { index: string; title: string; blockLabel: string; placeholder: string }
> = {
  identity: {
    index: '01',
    title: '身份',
    blockLabel: '身份设定',
    placeholder: '描述该 Waker 的身份、职责与能力范围',
  },
  persona: {
    index: '02',
    title: '人设',
    blockLabel: 'PERSONA',
    placeholder: '描述该 Waker 的人设、沟通风格与工作原则',
  },
  bible: {
    index: '03',
    title: '设定集',
    blockLabel: 'BIBLE',
    placeholder: '维护该 Waker 需要遵循的完整设定集',
  },
};

export const AGENT_SECTION_ORDER: readonly [AgentSectionId, AgentSectionId, AgentSectionId] = [
  'identity',
  'persona',
  'bible',
];

export interface AgentBodyRawChunk {
  kind: 'raw';
  /** 段外原文（前言、段间内容），逐字节保留。 */
  text: string;
}

export interface AgentBodySectionChunk {
  kind: 'section';
  id: AgentSectionId;
  /** H2 标题行原文（含结尾换行；位于文件末尾时可能无换行）。 */
  heading: string;
  /** 标题行之后到下一个约定 H2（或文件末尾）之间的正文原文，未编辑时逐字节回写。 */
  content: string;
}

export type AgentBodyChunk = AgentBodyRawChunk | AgentBodySectionChunk;

export interface AgentBodySectioned {
  mode: 'sectioned';
  chunks: AgentBodyChunk[];
  /** 三段正文（trim 后），供预览渲染与编辑初值。 */
  sections: Record<AgentSectionId, string>;
}

export interface AgentBodyFallback {
  mode: 'fallback';
}

export type AgentBodyParse = AgentBodySectioned | AgentBodyFallback;

const HEADING_PATTERN = /^## (身份|人设|设定集)[ \t]*\r?$/gm;
const ID_BY_TITLE: Record<string, AgentSectionId> = {
  身份: 'identity',
  人设: 'persona',
  设定集: 'bible',
};

/** 按三个约定 H2 切分 body；不符合约定（缺段/无段/重复段）时返回 fallback。 */
export function parseAgentBody(body: string): AgentBodyParse {
  const matches = [...body.matchAll(HEADING_PATTERN)];
  const ids = matches.map((match) => ID_BY_TITLE[match[1] ?? ''] as AgentSectionId);
  if (matches.length !== 3 || new Set(ids).size !== 3) return { mode: 'fallback' };

  const boundaries = matches.map((match, index) => {
    const start = match.index;
    const lineEnd = body.indexOf('\n', start);
    return {
      start,
      contentStart: lineEnd === -1 ? body.length : lineEnd + 1,
      id: ids[index] as AgentSectionId,
    };
  });

  const chunks: AgentBodyChunk[] = [];
  const first = boundaries[0];
  if (first && first.start > 0) chunks.push({ kind: 'raw', text: body.slice(0, first.start) });
  boundaries.forEach((boundary, index) => {
    const next = boundaries[index + 1];
    const end = next ? next.start : body.length;
    chunks.push({
      kind: 'section',
      id: boundary.id,
      heading: body.slice(boundary.start, boundary.contentStart),
      content: body.slice(boundary.contentStart, end),
    });
  });

  const sections: Record<AgentSectionId, string> = { identity: '', persona: '', bible: '' };
  for (const chunk of chunks) {
    if (chunk.kind === 'section') sections[chunk.id] = chunk.content.trim();
  }
  return { mode: 'sectioned', chunks, sections };
}

/**
 * 把分段编辑结果拼回完整 body。edits 之外的 chunk（前言、未触碰的段及其标题行）逐字节保留；
 * 被编辑段正文归一化为 trim + 单个结尾换行（空内容则只保留标题行）。
 */
export function rebuildAgentBody(
  parsed: AgentBodySectioned,
  edits: Partial<Record<AgentSectionId, string>>,
): string {
  return parsed.chunks
    .map((chunk) => {
      if (chunk.kind === 'raw') return chunk.text;
      const edit = edits[chunk.id];
      if (edit === undefined) return chunk.heading + chunk.content;
      const trimmed = edit.trim();
      if (!trimmed) return chunk.heading;
      const heading = chunk.heading.endsWith('\n') ? chunk.heading : `${chunk.heading}\n`;
      return `${heading}${trimmed}\n`;
    })
    .join('');
}
