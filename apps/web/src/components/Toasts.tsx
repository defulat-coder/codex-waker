import { AnimatePresence, motion } from 'motion/react';
import { WarningCircle } from '@phosphor-icons/react/dist/icons/WarningCircle';
import { MOTION_EASE } from '../lib/motion.js';

export type Toast = { id: number; text: string };

/** 用户可见的错误通知：写操作失败时从底部弹出，4 秒后自动消失（由调用方移除）。 */
export function Toasts({ toasts }: { toasts: Toast[] }) {
  return (
    <div className="toast-stack" role="status" aria-live="polite">
      <AnimatePresence>
        {toasts.map((toast) => (
          <motion.div
            key={toast.id}
            className="toast"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            transition={{ duration: 0.18, ease: MOTION_EASE }}
          >
            <WarningCircle size={14} weight="fill" aria-hidden="true" />
            {toast.text}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
