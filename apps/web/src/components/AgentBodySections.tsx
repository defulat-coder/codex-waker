import { useMemo, useState, type ReactNode } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { motion } from 'motion/react';
import { CircleNotch } from '@phosphor-icons/react/dist/icons/CircleNotch';
import { PencilSimple } from '@phosphor-icons/react/dist/icons/PencilSimple';
import {
  AGENT_SECTION_META,
  AGENT_SECTION_ORDER,
  parseAgentBody,
  rebuildAgentBody,
  type AgentSectionId,
} from '../lib/agentSections.js';
import { MOTION_EASE } from '../lib/motion.js';
import { MotionSpinner } from './MotionFeedback.js';

/**
 * Waker 设定的三上下文卡片（01 身份 / 02 人设 / 03 设定集），复刻 QoderWake 0.4.2 设置页。
 * body 符合「## 身份 / ## 人设 / ## 设定集」小节约定时按段展示与编辑（保存只重写目标段，
 * 其余段逐字节保留，见 lib/agentSections.ts）；不符合约定时回退整段模式：说明条 + 整段
 * Markdown 预览 + 整段编辑入口。
 */
export function AgentBodySections({
  body,
  saving,
  onSaveBody,
  onStartFullEdit,
  identityHeader,
}: {
  body: string;
  /** 与整表编辑共用的保存中标记；保存期间禁用所有编辑入口。 */
  saving: boolean;
  /** 分段保存：把拼回后的完整 body 交给父组件 PATCH；返回是否成功（成功才退出编辑态）。 */
  onSaveBody: (nextBody: string) => Promise<boolean>;
  /** 整表编辑入口（修改基本信息 / 回退模式的整段编辑）。 */
  onStartFullEdit: () => void;
  /** 卡 01 顶部的只读 profile 区（头像/称谓/简介）与「修改基本信息」入口。 */
  identityHeader: ReactNode;
}) {
  const parsed = useMemo(() => parseAgentBody(body), [body]);
  /** 非 null 即某一分段的编辑态；同一时间只允许编辑一段。 */
  const [edit, setEdit] = useState<{ id: AgentSectionId; text: string } | null>(null);

  const saveEdit = async () => {
    if (!edit || saving || parsed.mode !== 'sectioned') return;
    const ok = await onSaveBody(rebuildAgentBody(parsed, { [edit.id]: edit.text }));
    if (ok) setEdit(null);
  };

  if (parsed.mode === 'fallback') {
    return (
      <div className="config-card">
        <p className="config-card-title">01 身份</p>
        {identityHeader}
        <div className="config-card-head">
          <p className="config-card-title">人设文档</p>
          <button
            type="button"
            className="icon-button"
            aria-label="修改人设文档"
            onClick={onStartFullEdit}
            disabled={saving}
          >
            <PencilSimple size={13} />
          </button>
        </div>
        <p className="config-card-desc">
          该 Waker 的人设文档未按 身份/人设/设定集 分段，编辑将对整个文档生效。
        </p>
        {body.trim() ? (
          <div className="markdown config-body-preview">
            <Markdown remarkPlugins={[remarkGfm]}>{body.trim()}</Markdown>
          </div>
        ) : (
          <p>暂未设置</p>
        )}
      </div>
    );
  }

  const renderSection = (id: AgentSectionId) => {
    const meta = AGENT_SECTION_META[id];
    if (edit?.id === id) {
      return (
        <motion.div
          className="config-edit"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.15, ease: MOTION_EASE }}
        >
          <label className="config-edit-field">
            <span>{meta.blockLabel}</span>
            <textarea
              value={edit.text}
              rows={8}
              placeholder={meta.placeholder}
              aria-label={`${meta.title}内容`}
              onChange={(event) => setEdit((prev) => (prev ? { ...prev, text: event.target.value } : prev))}
              disabled={saving}
            />
          </label>
          <div className="config-edit-actions">
            <button
              type="button"
              className="header-button"
              onClick={() => setEdit(null)}
              disabled={saving}
            >
              取消
            </button>
            <button
              type="button"
              className="header-button primary"
              onClick={() => void saveEdit()}
              disabled={saving}
            >
              {saving ? (
                <MotionSpinner>
                  <CircleNotch size={13} />
                </MotionSpinner>
              ) : null}
              保存
            </button>
          </div>
        </motion.div>
      );
    }
    return (
      <>
        <div className="config-card-head">
          <p className="config-card-title">{meta.blockLabel}</p>
          <button
            type="button"
            className="icon-button"
            aria-label={`修改${meta.title}`}
            onClick={() => setEdit({ id, text: parsed.sections[id] })}
            disabled={saving || edit !== null}
          >
            <PencilSimple size={13} />
          </button>
        </div>
        {parsed.sections[id] ? (
          <div className="markdown config-body-preview">
            <Markdown remarkPlugins={[remarkGfm]}>{parsed.sections[id]}</Markdown>
          </div>
        ) : (
          <p>暂未设置</p>
        )}
      </>
    );
  };

  const [first, ...rest] = AGENT_SECTION_ORDER;
  return (
    <>
      <div className="config-card">
        <p className="config-card-title">
          {AGENT_SECTION_META[first].index} {AGENT_SECTION_META[first].title}
        </p>
        {identityHeader}
        {renderSection(first)}
      </div>
      {rest.map((id) => (
        <div className="config-card" key={id}>
          <p className="config-card-title">
            {AGENT_SECTION_META[id].index} {AGENT_SECTION_META[id].title}
          </p>
          {renderSection(id)}
        </div>
      ))}
    </>
  );
}
