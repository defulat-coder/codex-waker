/** Calm, confident deceleration for the local operations desk. */
export const MOTION_EASE = [0.16, 1, 0.3, 1] as const;

export const MOTION_TRANSITION = {
  feedback: { duration: 0.12, ease: MOTION_EASE },
  routine: { duration: 0.18, ease: MOTION_EASE },
  panel: { duration: 0.24, ease: MOTION_EASE },
  exit: { duration: 0.14, ease: MOTION_EASE },
} as const;

export const MOTION_LAYOUT_TRANSITION = {
  duration: 0.24,
  ease: MOTION_EASE,
} as const;

export const MOTION_DIALOG_BACKDROP = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0 },
  transition: MOTION_TRANSITION.exit,
} as const;

export const MOTION_DIALOG_SURFACE = {
  initial: { opacity: 0, scale: 0.985, y: 8 },
  animate: { opacity: 1, scale: 1, y: 0 },
  exit: { opacity: 0, scale: 0.985, y: 6 },
  transition: MOTION_TRANSITION.panel,
} as const;
