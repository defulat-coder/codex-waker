import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const styles = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
const app = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');
const feedback = readFileSync(new URL('../components/MotionFeedback.tsx', import.meta.url), 'utf8');

describe('Motion 样式边界', () => {
  it('不使用 CSS keyframes 或 animation', () => {
    assert.doesNotMatch(styles, /@keyframes|\banimation(?:-name)?\s*:/);
  });

  it('CSS transition 只负责颜色、边框与阴影反馈', () => {
    const transitions = styles.match(/\btransition(?:-property)?\s*:[^;]+;/g) ?? [];
    for (const declaration of transitions) {
      assert.doesNotMatch(
        declaration,
        /\b(?:all|opacity|transform|translate|rotate|scale|width|height|filter|clip-path)\b/,
        declaration,
      );
    }
  });

  it('应用与共享持续动画都遵守用户的 reduced-motion 偏好', () => {
    assert.match(app, /<MotionConfig\s+reducedMotion="user">/);
    assert.match(feedback, /useReducedMotion\(\)/);
  });
});
