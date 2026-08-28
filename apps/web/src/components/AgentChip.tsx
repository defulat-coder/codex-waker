import { cx } from '../lib/cx.js';

/** Agent 头像 chip：取 mark 前两个字符，尺寸由 large/medium 修饰类控制。 */
export function AgentChip({ mark, className }: { mark: string; className?: string }) {
  return (
    <span className={cx('agent-chip', className)} aria-hidden="true">
      {mark.slice(0, 2)}
    </span>
  );
}
