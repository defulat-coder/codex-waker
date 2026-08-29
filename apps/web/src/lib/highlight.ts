/**
 * Shiki 语法高亮：github-light / github-dark 双主题，以 --shiki-light / --shiki-dark
 * CSS 变量输出（defaultColor: false），明暗切换由 styles.css 的
 * prefers-color-scheme 媒体查询完成，与项目现有 dark 实现一致。
 */

type ShikiHighlighter = Awaited<ReturnType<(typeof import('shiki'))['createHighlighter']>>;

const SHIKI_THEMES = { light: 'github-light', dark: 'github-dark' } as const;

let highlighterPromise: Promise<ShikiHighlighter> | null = null;
const loadedLanguages = new Set<string>();

function getHighlighter(): Promise<ShikiHighlighter> {
  highlighterPromise ??= import('shiki').then(({ createHighlighter }) =>
    createHighlighter({ themes: [SHIKI_THEMES.light, SHIKI_THEMES.dark], langs: [] }),
  );
  return highlighterPromise;
}

/**
 * 语言按需动态加载，返回带双主题 CSS 变量的 html。
 * 语言不存在或高亮失败时抛错，由调用方回退到纯文本。
 */
export async function highlightCode(code: string, language: string): Promise<string> {
  const highlighter = await getHighlighter();
  if (!loadedLanguages.has(language)) {
    await highlighter.loadLanguage(language as never);
    loadedLanguages.add(language);
  }
  return highlighter.codeToHtml(code, {
    lang: language as never,
    themes: SHIKI_THEMES,
    defaultColor: false,
  });
}
