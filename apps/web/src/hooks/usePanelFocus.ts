import { useLayoutEffect, useRef, type RefObject } from 'react';

/** Non-modal side panels receive focus, close on Escape, and return focus to their trigger. */
export function usePanelFocus<T extends HTMLElement>(onClose: () => void): RefObject<T | null> {
  const panelRef = useRef<T>(null);
  const closeRef = useRef(onClose);
  const previousRef = useRef<HTMLElement | null>(
    typeof document !== 'undefined' && document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null,
  );
  closeRef.current = onClose;

  useLayoutEffect(() => {
    const panel = panelRef.current;
    const close = panel?.querySelector<HTMLElement>('[data-panel-close]:not([disabled])');
    if (close) close.focus();
    else panel?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      const panel = panelRef.current;
      if (event.key !== 'Escape' || !panel?.contains(event.target as Node)) return;
      if (event.target instanceof Element && event.target.closest('[role="dialog"]')) return;
      event.preventDefault();
      event.stopPropagation();
      closeRef.current();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      const previous = previousRef.current;
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  return panelRef;
}
