import { useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { MagnifyingGlass } from '@phosphor-icons/react/dist/icons/MagnifyingGlass';
import {
  buildPaletteItems,
  filterPaletteItems,
  PALETTE_GROUP_LABELS,
  PALETTE_GROUP_ORDER,
  type PaletteAction,
  type PaletteGroup,
  type PaletteItem,
} from '../lib/palette.js';
import { cx } from '../lib/cx.js';
import { MOTION_EASE } from '../lib/motion.js';
import { useWorkspace } from '../context/WorkspaceContext.js';

export type CommandPaletteProps = {
  open: boolean;
  onAction: (action: PaletteAction) => void;
  onClose: () => void;
};

/** ⌘K 命令面板（Fleet Search 的真实行为）：跨页面 / Agent / 会话过滤跳转，↑↓ 选择、Enter 执行、Esc 关闭。 */
export function CommandPalette({ open, onAction, onClose }: CommandPaletteProps) {
  const { workspace, sessionsByAgent } = useWorkspace();
  const agents = workspace.agents;
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const items = useMemo(
    () => buildPaletteItems({ agents, sessionsByAgent }),
    [agents, sessionsByAgent],
  );
  const filtered = useMemo(() => filterPaletteItems(items, query), [items, query]);

  useEffect(() => {
    if (open) {
      setQuery('');
      setActiveIndex(0);
      inputRef.current?.focus();
    }
  }, [open]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  useEffect(() => {
    if (!open) return;
    const active = listRef.current?.querySelector('[data-active="true"]');
    active?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, open]);

  // 渲染不再以 open 为门槛：挂载/退场由 App 的 AnimatePresence 条件挂载驱动，
  // open 只用于聚焦、键盘滚动等副作用。
  const run = (item: PaletteItem | undefined) => {
    if (!item) return;
    onAction(item.action);
    onClose();
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((index) => Math.min(index + 1, filtered.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((index) => Math.max(index - 1, 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      run(filtered[activeIndex]);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    }
  };

  let flatIndex = -1;
  const groups = PALETTE_GROUP_ORDER.map((group) => ({
    group,
    items: filtered.filter((item) => item.group === group),
  })).filter((entry) => entry.items.length > 0);

  return (
    <motion.div
      className="modal-backdrop palette-backdrop"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.15 }}
      onClick={onClose}
    >
      <motion.div
        className="palette"
        role="dialog"
        aria-label="搜索与跳转"
        initial={{ opacity: 0, scale: 0.96, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.96, y: 8 }}
        transition={{ duration: 0.2, ease: MOTION_EASE }}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="palette-input-row">
          <MagnifyingGlass size={14} />
          <input
            ref={inputRef}
            className="palette-input"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder="搜索页面、Agent、会话…"
            aria-label="搜索页面、Agent、会话"
          />
          <span className="search-kbd-group" aria-hidden="true">
            <kbd>esc</kbd>
          </span>
        </div>
        <div className="palette-list" ref={listRef} role="listbox">
          {groups.map(({ group, items: groupItems }) => (
            <div key={group}>
              <p className="palette-group-label">{PALETTE_GROUP_LABELS[group as PaletteGroup]}</p>
              {groupItems.map((item) => {
                flatIndex += 1;
                const index = flatIndex;
                const active = index === activeIndex;
                return (
                  <button
                    key={item.id}
                    type="button"
                    role="option"
                    aria-selected={active}
                    data-active={active}
                    className={cx('palette-row', active && 'active')}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => run(item)}
                  >
                    <span className="palette-row-label">{item.label}</span>
                    {item.hint && <span className="palette-row-hint">{item.hint}</span>}
                  </button>
                );
              })}
            </div>
          ))}
          {!filtered.length && <p className="palette-empty">没有匹配的结果</p>}
        </div>
      </motion.div>
    </motion.div>
  );
}
