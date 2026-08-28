import type { PromptSummary } from '@waker/contracts';

/**
 * Filters the "/" prompt panel list. Empty query returns everything;
 * otherwise case-insensitive substring match on name and description,
 * prefix matches on name rank first.
 */
export function filterPrompts(prompts: PromptSummary[], query: string): PromptSummary[] {
  const q = query.trim().toLowerCase();
  if (!q) return prompts;
  const prefix: PromptSummary[] = [];
  const rest: PromptSummary[] = [];
  for (const prompt of prompts) {
    const name = prompt.name.toLowerCase();
    const description = (prompt.description ?? '').toLowerCase();
    if (name.startsWith(q)) prefix.push(prompt);
    else if (name.includes(q) || description.includes(q)) rest.push(prompt);
  }
  return [...prefix, ...rest];
}

/** Extracts the panel query from composer text: "/exp" → "exp"; non-"/" input → null. */
export function promptQueryFromInput(text: string): string | null {
  if (!text.startsWith('/')) return null;
  const body = text.slice(1);
  if (body.includes(' ') || body.includes('\n')) return null;
  return body;
}

/** Clamps/wraps the keyboard-active index for the prompt panel. */
export function movePromptSelection(current: number, delta: 1 | -1, count: number): number {
  if (count <= 0) return -1;
  return (current + delta + count) % count;
}
