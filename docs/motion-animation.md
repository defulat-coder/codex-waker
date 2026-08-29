# Motion 动效最佳实践

项目动效统一使用 `motion`（motiondivision/motion，原 Framer Motion），已安装在 `apps/web`。不要引入其他 JS 动画库（GSAP、react-spring 等），除非用户明确要求。

- 官方文档：[Motion for React](https://motion.dev/docs/react)
- 安装版本以 `apps/web/package.json` 为准；API 以所装版本为准，新特性先查官方文档再使用。

## 导入方式

- React 中统一从 `motion/react` 导入：`import { motion } from 'motion/react'`。
- 不要使用旧的 `framer-motion` 包名。

## 性能

- 只动画合成层属性：`transform`（`x` / `y` / `scale` / `rotate`）和 `opacity`；避免直接动画 `width` / `height` / `top` / `left` 等触发重排的属性。
- 布局变化（尺寸、位置、重排）用 `layout` prop；跨元素共享过渡用 `layoutId`（FLIP，自动修正 scale 变形）。
- 滚动联动用 `useScroll` + `useTransform` / `useSpring` 的 MotionValue 链直接驱动 `style`，不要 setState 触发 React 重渲染。
- 手势统一用 `whileHover` / `whileTap` / `whileFocus` / `whileInView`，不要手写 mouse/touch 事件。
- 物理属性（`x`、`scale` 等）默认 spring 缓动，视觉属性（`opacity` 等）默认 tween；需要覆盖时用 `transition` prop。
- 入场用 `initial` + `animate`（`initial={false}` 可跳过首次动画）；退场必须包 `AnimatePresence` + `exit`，子元素保持稳定的 `key`。
- 编排多个子元素用 variants（`staggerChildren` 等），不要手写延时链。
- 包体积敏感场景：改用 `m` 组件（`motion/react-m`）+ `LazyMotion` 按需加载 `domAnimation` / `domMax`；混用 `motion` 组件会失去瘦身效果，可加 `strict` 强制约束。参考 [Reduce bundle size](https://motion.dev/docs/react-reduce-bundle-size)。

## 可访问性

- 全局用 `MotionConfig reducedMotion="user"` 尊重系统"减弱动态效果"设置；开启后 transform/layout 动画自动禁用，opacity 类动画保留。参考 [MotionConfig](https://motion.dev/docs/react-motion-config)。

## CSS 边界

- CSS transition 只用于简单的颜色、边框和阴影反馈，例如 hover 变色。
- 不使用 CSS `animation` 或 `@keyframes`。持续状态、旋转、脉冲、骨架屏、手势、布局、滚动联动、进退场和编排一律使用 Motion。
