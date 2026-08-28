// 仓库 ESLint flat config。
// 插件经由 tools/eslint/plugins.js 引入（解析锚点在 tools/eslint 内，配合 .pnpmfile.cjs
// 让 typescript-eslint 使用旁路的 TypeScript 6；构建用的 TypeScript 7 Go 版尚无 JS API 支持）。
// ESLint v10 以 cwd 为 basePath：从仓库根运行时做全量扫描，从单个包目录运行时只扫该包 src。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { js, reactHooks, tseslint } from './tools/eslint/plugins.js';

const repoRoot = path.dirname(fileURLToPath(import.meta.url));
const cwd = process.cwd();
const inRoot = cwd === repoRoot;

const srcDirs = inRoot
  ? [
      'apps/web/src',
      'apps/api/src',
      'packages/contracts/src',
      'packages/codex-runtime/src',
      'packages/knowledge/src',
      'packages/memory/src',
      'packages/artifacts/src',
      'packages/workspace-data/src',
    ]
  : ['src'];
const webSrcDirs = inRoot
  ? ['apps/web/src']
  : cwd === path.join(repoRoot, 'apps/web')
    ? ['src']
    : [];

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/.turbo/**'],
  },
  {
    files: srcDirs.flatMap((dir) => [`${dir}/**/*.ts`, `${dir}/**/*.tsx`]),
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    rules: {
      // 存量代码大量使用 any，先关闭；目标是一次性全绿，不做大扫除。
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  ...(webSrcDirs.length > 0
    ? [
        {
          files: webSrcDirs.map((dir) => `${dir}/**/*.tsx`),
          plugins: { 'react-hooks': reactHooks },
          rules: {
            // 只用经典两条核心规则；v7 recommended 里的 React Compiler 规则（set-state-in-effect 等）
            // 对存量代码大面积报错，属大扫除范畴，不在本批次引入。
            'react-hooks/rules-of-hooks': 'error',
            'react-hooks/exhaustive-deps': 'warn',
          },
        },
      ]
    : []),
);
