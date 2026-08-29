import { join } from 'node:path';
import type { AgentTemplate } from '@waker/contracts';
import { loadAgentDefinitions } from './agents.js';

/**
 * File-first role template registry: every .codex/agent-templates/<id>.md is a
 * template, in the same Markdown + frontmatter format as agent definitions.
 * 「使用模板」在 .codex/agents/ 下创建真实的 agent 文件；模板本身只读。
 */
export function listAgentTemplates(cwd: string): AgentTemplate[] {
  return loadAgentDefinitions(join(cwd, '.codex', 'agent-templates')).map(
    ({ id, name, mark, tagline, description, suggestions, body, strengths, workStyles }) => ({
      id,
      name,
      mark,
      tagline,
      description,
      suggestions,
      body,
      ...(strengths ? { strengths } : {}),
      ...(workStyles ? { workStyles } : {}),
    }),
  );
}
