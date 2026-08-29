import type { ReactNode } from 'react';
import { motion } from 'motion/react';
import { cx } from '../lib/cx.js';

type MotionSpinnerProps = {
  children: ReactNode;
  className?: string;
};

/** Shared Motion-powered rotation for loading and running-state icons. */
export function MotionSpinner({ children, className }: MotionSpinnerProps) {
  return (
    <motion.span
      className={cx('motion-spinner', className)}
      aria-hidden="true"
      animate={{ rotate: 360 }}
      transition={{ duration: 1.2, ease: 'linear', repeat: Infinity }}
    >
      {children}
    </motion.span>
  );
}

type MotionPulseDotProps = {
  active?: boolean;
  className?: string;
};

/** Quiet opacity feedback for streaming and thinking states. */
export function MotionPulseDot({ active = true, className }: MotionPulseDotProps) {
  return (
    <motion.span
      className={className}
      aria-hidden="true"
      animate={{ opacity: active ? [1, 0.15, 1] : 1 }}
      transition={active ? { duration: 0.9, ease: 'easeInOut', repeat: Infinity } : undefined}
    />
  );
}

type MotionLoadingRowsProps = {
  count?: number;
  label?: string;
  role?: 'status';
};

/** Shared skeleton rows; the shimmer moves on the compositor via Motion transforms. */
export function MotionLoadingRows({
  count = 3,
  label = '正在加载',
  role = 'status',
}: MotionLoadingRowsProps) {
  return (
    <div className="loading-rows" role={role} aria-label={label} aria-busy="true">
      {Array.from({ length: count }, (_, index) => (
        <i key={index}>
          <motion.span
            initial={{ x: '-120%' }}
            animate={{ x: '340%' }}
            transition={{ duration: 1.2, ease: 'linear', repeat: Infinity }}
          />
        </i>
      ))}
    </div>
  );
}
