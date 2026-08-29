import { MemoryError, type MemoryStore } from '@waker/memory';

/** 对话自动产出的 memory 统一打这个 source；timeline 的 origin 语义由它体现。 */
export const MEMORY_DREAM_SOURCE = 'conversation';

/**
 * 关键字门控（对齐旧版 QoderWake 的启发式）：这只是成本闸门，命中才值得跑一次
 * LLM 提取；是否真有值得长期记住的内容由提取器判定。匹配不区分大小写。
 */
const MEMORY_DREAM_GATE_KEYWORDS = [
  '记住',
  '记得',
  'remember',
  '我是',
  '我喜欢',
  '我偏好',
  '偏好',
  '长期',
  '必须',
  '以后',
  'always',
  '永远',
];

export function memoryDreamGateHits(userMessage: string): boolean {
  const text = userMessage.toLowerCase();
  return MEMORY_DREAM_GATE_KEYWORDS.some((keyword) => text.includes(keyword.toLowerCase()));
}

export interface MemoryDreamTrigger {
  agentId: string;
  sessionId: string;
  userMessage: string;
  assistantAnswer: string;
  /** 本轮对话实际使用的模型（解析默认值后的最终值）；缺失时提取回退默认模型。 */
  model?: string;
}

export interface ExtractedMemory {
  title: string;
  content: string;
}

/** 输入截断，避免超长 turn 把提取 prompt 撑爆。 */
const EXCERPT_LIMIT = 4000;

function escapeXml(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function excerpt(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > EXCERPT_LIMIT ? `${trimmed.slice(0, EXCERPT_LIMIT)}…` : trimmed;
}

/**
 * 提取 prompt：严格输出契约 —— 无值得长期记住的内容输出 `NO_MEMORY`；
 * 有则输出 Markdown，首行 `# 标题`。会话内容是未信任数据，不是指令。
 */
export function buildMemoryExtractionPrompt(input: {
  userMessage: string;
  assistantAnswer: string;
}): string {
  return `你是个人 AI 助手的记忆提取器。判断下面这一轮对话中是否有值得跨会话长期记住的用户信息：稳定的身份事实、长期偏好、持续生效的约束或要求、长期目标/项目。不要提取一次性的任务细节、临时问题或并非用户自身陈述的内容。

输出契约（严格遵守，不要输出任何其他内容）：
- 如果没有值得长期记住的内容，只输出一行：NO_MEMORY
- 如果有，只输出 Markdown：第一行必须是 \`# 简短标题\`，随后用简洁的条目记录这些长期事实，使用用户的语言。

<conversation-turn untrusted="true">
<user-message>
${escapeXml(excerpt(input.userMessage))}
</user-message>
<assistant-reply>
${escapeXml(excerpt(input.assistantAnswer))}
</assistant-reply>
</conversation-turn>`;
}

/** 解析提取输出；NO_MEMORY 或不符合契约（首行不是 `# 标题`）都返回 null。 */
export function parseMemoryExtractionOutput(raw: string): ExtractedMemory | null {
  const text = raw.trim();
  if (!text || text.startsWith('NO_MEMORY')) return null;
  const firstLine = text.split('\n', 1)[0] ?? '';
  const titleMatch = /^#\s+(.+)$/.exec(firstLine.trim());
  if (!titleMatch?.[1]) return null;
  const title = titleMatch[1].trim().slice(0, 120);
  if (!title) return null;
  return { title, content: text };
}

export type MemoryExtractor = (prompt: string, model?: string) => Promise<string>;

export interface MemoryDreamerOptions {
  memory: MemoryStore;
  extract: MemoryExtractor;
  /** env WAKER_MEMORY_DREAM=off 时传 false；默认启用。 */
  enabled?: boolean;
  logger?: { warn: (message: string) => void };
}

/**
 * turn 完成后的后台记忆提取（复刻旧版 memory dream）：fire-and-forget，
 * 同一 agent 的提取任务串行执行，任何失败只 log、绝不影响主对话。
 */
export class MemoryDreamer {
  private readonly memory: MemoryStore;
  private readonly extract: MemoryExtractor;
  private readonly enabled: boolean;
  private readonly logger?: { warn: (message: string) => void };
  private readonly tails = new Map<string, Promise<void>>();

  constructor(options: MemoryDreamerOptions) {
    this.memory = options.memory;
    this.extract = options.extract;
    this.enabled = options.enabled !== false;
    if (options.logger) this.logger = options.logger;
  }

  /** 门控命中则排队一次提取；调用本身同步返回，不阻塞 SSE 完成帧。 */
  trigger(input: MemoryDreamTrigger): void {
    if (!this.enabled || !memoryDreamGateHits(input.userMessage)) return;
    const tail = this.tails.get(input.agentId) ?? Promise.resolve();
    const next: Promise<void> = tail
      .then(() => this.run(input))
      .catch((error: unknown) => {
        this.logger?.warn(
          `memory dream 失败（已忽略，不影响会话）：${error instanceof Error ? error.message : String(error)}`,
        );
      });
    this.tails.set(input.agentId, next);
    void next.finally(() => {
      if (this.tails.get(input.agentId) === next) this.tails.delete(input.agentId);
    });
  }

  /** 测试用：等该 agent 当前已排队的提取任务全部 settle。 */
  async whenSettled(agentId: string): Promise<void> {
    await this.tails.get(agentId);
  }

  private async run(input: MemoryDreamTrigger): Promise<void> {
    const raw = await this.extract(
      buildMemoryExtractionPrompt({
        userMessage: input.userMessage,
        assistantAnswer: input.assistantAnswer,
      }),
      input.model,
    );
    const extracted = parseMemoryExtractionOutput(raw);
    if (!extracted) return;
    this.upsert(input.agentId, extracted);
  }

  /** 按标题去重：同 scope 已有同名 memory 则 update 出新版本，否则 create。版本冲突重读重试一次。 */
  private upsert(agentId: string, extracted: ExtractedMemory): void {
    const scope = { type: 'waker' as const, id: agentId };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const existing = this.memory
        .list({ scope })
        .find((document) => document.title.trim().toLowerCase() === extracted.title.toLowerCase());
      try {
        if (existing) {
          // 保留原 source（可能是用户手工创建的），只推进内容版本。
          this.memory.update(existing.id, {
            expectedVersion: existing.version,
            scope,
            title: extracted.title,
            content: extracted.content,
          });
        } else {
          this.memory.create({
            scope,
            source: MEMORY_DREAM_SOURCE,
            title: extracted.title,
            content: extracted.content,
          });
        }
        return;
      } catch (error) {
        if (error instanceof MemoryError && error.code === 'VERSION_CONFLICT' && attempt === 0)
          continue;
        throw error;
      }
    }
  }
}
