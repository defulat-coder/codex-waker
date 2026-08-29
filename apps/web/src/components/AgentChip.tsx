import { cx } from '../lib/cx.js';
import { agentAvatarUrl } from '../lib/api.js';

/**
 * Agent 头像 chip：有上传头像时渲染图片，否则取 mark 前两个字符，
 * 尺寸由 large/medium 修饰类控制。
 */
export function AgentChip({
  mark,
  className,
  agentId,
  hasAvatar,
}: {
  mark: string;
  className?: string;
  /** 与 hasAvatar 一起启用头像图片（src 指向 /api/v1/agents/<id>/avatar）。 */
  agentId?: string;
  hasAvatar?: boolean;
}) {
  if (agentId && hasAvatar) {
    return (
      <span className={cx('agent-chip', className)} aria-hidden="true">
        <img src={agentAvatarUrl(agentId)} alt="" />
      </span>
    );
  }
  return (
    <span className={cx('agent-chip', className)} aria-hidden="true">
      {mark.slice(0, 2)}
    </span>
  );
}
