// 插件/解析器的解析锚点：本文件位于 tools/eslint/，因此这里的裸导入
// （typescript-eslint 等）解析到本包的 node_modules，typescript-eslint
// 使用 .pnpmfile.cjs 固定下来的 typescript@6（TS7 Go 版尚无 JS API 支持）。
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export { js, reactHooks, tseslint };
