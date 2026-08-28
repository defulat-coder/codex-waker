import { parse } from 'yaml';

export interface FrontmatterResult {
  /** Parsed YAML frontmatter as a plain object; {} when absent or malformed. */
  frontmatter: Record<string, unknown>;
  /** Markdown body after the closing `---` fence, verbatim. */
  body: string;
}

/** Leading `---\n<yaml>\n---\n` block; the closing fence may end the file. */
const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

/**
 * Splits a Markdown document into YAML frontmatter and body. A missing or
 * unparsable frontmatter block yields an empty object instead of throwing, so
 * third-party content (skills, prompts) never fails the whole listing.
 */
export function parseFrontmatter(raw: string): FrontmatterResult {
  const match = FRONTMATTER_PATTERN.exec(raw);
  if (!match) return { frontmatter: {}, body: raw };
  let parsed: unknown;
  try {
    parsed = parse(match[1]!);
  } catch {
    parsed = undefined;
  }
  const frontmatter =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  return { frontmatter, body: raw.slice(match[0].length) };
}

export function stripFrontmatter(raw: string): string {
  return parseFrontmatter(raw).body;
}
