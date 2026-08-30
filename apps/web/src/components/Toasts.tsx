import { motion, useReducedMotion } from 'motion/react';
import { CheckCircle } from '@phosphor-icons/react/dist/icons/CheckCircle';
import { Info } from '@phosphor-icons/react/dist/icons/Info';
import { WarningCircle } from '@phosphor-icons/react/dist/icons/WarningCircle';
import { X } from '@phosphor-icons/react/dist/icons/X';
import { cx } from '../lib/cx.js';
import { MOTION_TRANSITION } from '../lib/motion.js';

export type ToastTone = 'info' | 'success' | 'error';
export type Toast = { id: number; text: string; tone: ToastTone };

/** 用户可见的操作通知；tone 决定播报语义，生命周期和移除由调用方管理。 */
export function Toasts({
  toasts,
  onDismiss,
}: {
  toasts: Toast[];
  onDismiss: (id: number) => void;
}) {
  const reducedMotion = useReducedMotion();

  return (
    <div className="toast-stack">
      {toasts.map((toast) => (
        <motion.div
          key={toast.id}
          layout={reducedMotion ? false : 'position'}
          className={cx('toast', `toast-${toast.tone}`)}
          role={toast.tone === 'error' ? 'alert' : 'status'}
          aria-live={toast.tone === 'error' ? 'assertive' : 'polite'}
          aria-atomic="true"
          initial={reducedMotion ? { opacity: 0 } : { opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={MOTION_TRANSITION.routine}
        >
          {toast.tone === 'success' ? (
            <CheckCircle size={15} weight="fill" aria-hidden="true" />
          ) : toast.tone === 'error' ? (
            <WarningCircle size={15} weight="fill" aria-hidden="true" />
          ) : (
            <Info size={15} weight="fill" aria-hidden="true" />
          )}
          <span className="toast-message">{toast.text}</span>
          <motion.button
            type="button"
            aria-label={`关闭通知：${toast.text}`}
            onClick={() => onDismiss(toast.id)}
            whileTap={reducedMotion ? undefined : { scale: 0.92 }}
            transition={MOTION_TRANSITION.feedback}
          >
            <X size={13} aria-hidden="true" />
          </motion.button>
        </motion.div>
      ))}
    </div>
  );
}
