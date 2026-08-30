import { useEffect, useRef, type RefObject } from 'react';

const FOCUSABLE =
  'button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

export function useDialogFocus<T extends HTMLElement>(
  open: boolean,
  onClose: () => void,
): RefObject<T | null> {
  const dialogRef = useRef<T>(null);
  const closeRef = useRef(onClose);
  const previousRef = useRef<HTMLElement | null>(null);
  closeRef.current = onClose;

  useEffect(() => {
    if (open) return;
    const remember = (event: FocusEvent) => {
      if (event.target instanceof HTMLElement && !event.target.closest('[role="dialog"]'))
        previousRef.current = event.target;
    };
    const rememberPointer = (event: PointerEvent) => {
      const target =
        event.target instanceof Element ? event.target.closest<HTMLElement>(FOCUSABLE) : null;
      if (target && !target.closest('[role="dialog"]')) previousRef.current = target;
    };
    if (document.activeElement instanceof HTMLElement && document.activeElement !== document.body)
      previousRef.current = document.activeElement;
    document.addEventListener('focusin', remember);
    document.addEventListener('pointerdown', rememberPointer, true);
    return () => {
      document.removeEventListener('focusin', remember);
      document.removeEventListener('pointerdown', rememberPointer, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      const dialog = dialogRef.current;
      const active = document.activeElement;
      const target =
        active instanceof HTMLElement && dialog?.contains(active)
          ? active
          : (dialog?.querySelector<HTMLElement>('[autofocus]') ??
            dialog?.querySelector<HTMLElement>(FOCUSABLE) ??
            dialog);
      target?.focus();
    });
    const onKeyDown = (event: KeyboardEvent) => {
      const dialog = dialogRef.current;
      if (!dialog) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (!focusable.length) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0]!;
      const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('keydown', onKeyDown);
      const previous = previousRef.current;
      requestAnimationFrame(() => {
        if (previous?.isConnected) previous.focus();
      });
    };
  }, [open]);

  return dialogRef;
}
