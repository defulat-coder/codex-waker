import { useEffect, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react';

const COMPOSITE_ITEMS = '[role="menuitem"], [role="menuitemradio"], [role="option"]';

/** Arrow/Home/End navigation shared by menu and listbox popovers. */
export function handleCompositeKeyDown(
  event: ReactKeyboardEvent<HTMLElement>,
  onEscape: () => void,
): void {
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    onEscape();
    return;
  }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  const items = [...event.currentTarget.querySelectorAll<HTMLElement>(COMPOSITE_ITEMS)].filter(
    (item) => !item.hasAttribute('disabled') && item.getAttribute('aria-disabled') !== 'true',
  );
  if (!items.length) return;
  event.preventDefault();
  const current = items.indexOf(document.activeElement as HTMLElement);
  const next =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? items.length - 1
        : current < 0
          ? event.key === 'ArrowUp'
            ? items.length - 1
            : 0
          : (current + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length;
  items[next]?.focus();
}

/** 点击 ref 外部或按 Escape 时触发 onDismiss；active 为 false 时不监听。 */
export function useDismissable(
  ref: RefObject<HTMLElement | null>,
  onDismiss: () => void,
  active = true,
): void {
  useEffect(() => {
    if (!active) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) onDismiss();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onDismiss();
    };
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [ref, onDismiss, active]);
}
