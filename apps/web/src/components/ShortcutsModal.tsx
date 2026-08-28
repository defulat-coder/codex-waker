import { useEffect } from 'react';
import { motion } from 'motion/react';
import { X } from '@phosphor-icons/react/dist/icons/X';
import { MOTION_EASE } from '../lib/motion.js';

const SHORTCUTS: Array<{ keys: string[]; description: string }> = [
  { keys: ['⌘', 'K'], description: '打开搜索与命令面板' },
  { keys: ['⌘', 'B'], description: '收起 / 展开侧边栏' },
  { keys: ['/'], description: '在空输入框中打开提示词面板' },
  { keys: ['Enter'], description: '发送消息' },
  { keys: ['Shift', 'Enter'], description: '消息内换行' },
  { keys: ['Esc'], description: '关闭面板 / 弹窗' },
];

/** Fleet 的 Keyboard Shortcuts 面板：列出本应用真实可用的快捷键。 */
export function ShortcutsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  // 渲染不以 open 为门槛：挂载/退场由 App 的 AnimatePresence 条件挂载驱动，open 只用于 Esc 监听。
  return (
    <motion.div
      className="modal-backdrop"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.15 }}
      onClick={onClose}
    >
      <motion.div
        className="modal-card shortcuts-card"
        role="dialog"
        aria-label="键盘快捷键"
        initial={{ opacity: 0, scale: 0.96, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.96, y: 8 }}
        transition={{ duration: 0.2, ease: MOTION_EASE }}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-head">
          <strong>键盘快捷键</strong>
          <button type="button" className="icon-button" onClick={onClose} aria-label="关闭">
            <X size={14} />
          </button>
        </div>
        <div className="shortcuts-list">
          {SHORTCUTS.map((shortcut) => (
            <div className="shortcut-row" key={shortcut.description}>
              <span>{shortcut.description}</span>
              <span className="search-kbd-group">
                {shortcut.keys.map((key) => (
                  <kbd key={key}>{key}</kbd>
                ))}
              </span>
            </div>
          ))}
        </div>
      </motion.div>
    </motion.div>
  );
}
