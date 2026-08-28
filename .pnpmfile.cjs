// typescript-eslint 尚不支持 TypeScript 7（Go 版）的 API。
// 仓库构建用 typescript@7，这里把 typescript-eslint 及其子包的 typescript peer
// 改写为固定到 ~6.0.3 的普通依赖（官方推荐的 TS6 side-by-side 方案），
// 使 lint 使用 TS 6 的 JS API，与构建用的 TS 7 互不干扰。
const TS_LINT = '~6.0.3';

function pinLintTypescript(pkg) {
  if (pkg.peerDependencies && pkg.peerDependencies.typescript) {
    pkg.dependencies = { ...pkg.dependencies, typescript: TS_LINT };
    delete pkg.peerDependencies.typescript;
    if (pkg.peerDependenciesMeta) delete pkg.peerDependenciesMeta.typescript;
  }
  return pkg;
}

module.exports = {
  hooks: {
    readPackage(pkg) {
      if (pkg.name === 'typescript-eslint' || pkg.name.startsWith('@typescript-eslint/')) {
        return pinLintTypescript(pkg);
      }
      return pkg;
    },
  },
};
