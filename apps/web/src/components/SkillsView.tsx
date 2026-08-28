import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Check } from '@phosphor-icons/react/dist/icons/Check';
import { CircleNotch } from '@phosphor-icons/react/dist/icons/CircleNotch';
import { DownloadSimple } from '@phosphor-icons/react/dist/icons/DownloadSimple';
import { FileText } from '@phosphor-icons/react/dist/icons/FileText';
import { MagnifyingGlass } from '@phosphor-icons/react/dist/icons/MagnifyingGlass';
import { PuzzlePiece } from '@phosphor-icons/react/dist/icons/PuzzlePiece';
import { Trash } from '@phosphor-icons/react/dist/icons/Trash';
import { UploadSimple } from '@phosphor-icons/react/dist/icons/UploadSimple';
import { X } from '@phosphor-icons/react/dist/icons/X';
import type {
  InstalledSkillContent,
  InstalledSkillSummary,
  LibrarySkillDetail,
  LibrarySkillSummary,
  PromptDocument,
  PromptSummary,
} from '@waker/contracts';
import {
  fetchInstalledSkillContent,
  fetchInstalledSkills,
  fetchLibrarySkillDetail,
  fetchPrompt,
  fetchSkillLibrary,
  installSkill,
  removeSkill,
  uploadSkill,
} from '../lib/api.js';
import { formatInstallCount } from '../lib/explore.js';
import { cx } from '../lib/cx.js';
import { useAsyncData } from '../hooks/useAsyncData.js';
import { MOTION_EASE } from '../lib/motion.js';
import { useWorkspace } from '../context/WorkspaceContext.js';

/**
 * Skills 页（2026-08-23 改版）。
 * 方向契约 — THESIS：卡片墙用于浏览与发现，点卡片后右侧滑出详情坞用于阅读与操作，
 *   浏览与操作分层，拒绝「浏览弹窗」打断。OWN-WORLD：Fleet 实测 token（白底 /
 *   #f5f8fb 灰蓝表面 / #006ddd 品牌蓝 / 3–12px 圆角 / 13px 工作字号）。
 *   STORY：网格扫视 → 点卡片 → 右侧 400px 详情坞读完整定义并安装/删除。
 *   FIRST VIEWPORT：页头（标题 + 上传）下是工具栏（tab + 搜索）+ 通栏卡片网格。
 *   FORM：卡片网格 + 右侧滑出详情坞（用户指定，替代上一版左右分栏）。
 *   FINISH：detect + 截图评审 + 文档化后才算完成。
 */

/** 范围 tab：已安装 / 技能库 / 提示词。 */
type SkillScope = 'installed' | 'library' | 'prompts';

/** 当前选中项：三类卡片的并集。 */
type SkillSelection =
  | { kind: 'installed'; item: InstalledSkillSummary }
  | { kind: 'library'; item: LibrarySkillSummary }
  | { kind: 'prompt'; item: PromptSummary };

function selectionKey(selection: SkillSelection): string {
  switch (selection.kind) {
    case 'installed':
      return `installed:${selection.item.path}`;
    case 'library':
      return `library:${selection.item.id}`;
    case 'prompt':
      return `prompt:${selection.item.path}`;
  }
}

/** 从上传文件名推导技能名：去扩展名、小写、非法字符折叠成 -；无法推导时返回 undefined。 */
function skillNameFromFile(fileName: string): string | undefined {
  const slug = fileName
    .replace(/\.md$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 80);
  return /^[a-z0-9-]{1,80}$/.test(slug) ? slug : undefined;
}

/**
 * 动效基调（animate 流程，2026-08-23 修订）：Operate 界面，动效只服务反馈与连续性。
 * FOCAL：选中光环（layoutId spring）+ 详情坞滑入是唯一编排时刻。
 * FEEDBACK：按压 whileTap 回弹。CONTINUITY：tab 切换只做 150ms 透明度交叉淡入。
 * 明确不做：入场错峰/hover 浮起/重排 FLIP——它们让常规浏览变慢变吵，是动效债。
 */

/** 选中光环 / 详情坞共用的 spring 手感：快起稳停，无回弹过冲。 */
const SPRING = { type: 'spring', stiffness: 380, damping: 32 } as const;

/**
 * 卡片：图标 + 名称 + 两行描述 + 底部元信息。
 * 动效只留按压反馈（whileTap）；选中态是共享 layoutId 的光环在卡片间 spring 滑行。
 * hover 变色/阴影走 CSS（自包含效果）；不做浮起与入场编排。
 */
function SkillCard({
  icon,
  name,
  desc,
  meta,
  selected,
  onSelect,
}: {
  icon: React.ReactNode;
  name: string;
  desc?: string;
  meta?: React.ReactNode;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <motion.button
      type="button"
      whileTap={{ scale: 0.98 }}
      className={cx('skill-card', selected && 'selected')}
      onClick={onSelect}
      aria-current={selected || undefined}
    >
      {selected && (
        <motion.span
          layoutId="skill-card-active"
          className="skill-card-active"
          transition={SPRING}
        />
      )}
      <span className="skill-card-head">
        <span className="skill-card-icon" aria-hidden="true">
          {icon}
        </span>
        <span className="skill-card-name">{name}</span>
      </span>
      {desc && <span className="skill-card-desc">{desc}</span>}
      {meta && <span className="skill-card-meta">{meta}</span>}
    </motion.button>
  );
}

/** 右侧详情坞：按选中项类型拉取完整内容（SKILL.md / skills.sh 详情 / 提示词内容）。 */
function SkillDetailPane({
  selection,
  busy,
  onInstall,
  onRemove,
  onClose,
}: {
  selection: SkillSelection;
  /** 正在进行安装/删除/上传的技能标识；非 null 时禁用全部操作。 */
  busy: string | null;
  onInstall: (item: LibrarySkillSummary) => void;
  onRemove: (item: InstalledSkillSummary) => void;
  onClose: () => void;
}) {
  const [content, setContent] = useState<InstalledSkillContent | null>(null);
  const [libraryDetail, setLibraryDetail] = useState<LibrarySkillDetail | null>(null);
  const [promptDoc, setPromptDoc] = useState<PromptDocument | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setContent(null);
    setLibraryDetail(null);
    setPromptDoc(null);
    setError('');
    const fail = (fallback: string) => (cause: unknown) => {
      if (!cancelled) setError(cause instanceof Error ? cause.message : fallback);
    };
    if (selection.kind === 'installed') {
      fetchInstalledSkillContent(selection.item.scope, selection.item.name)
        .then((result) => {
          if (!cancelled) setContent(result);
        })
        .catch(fail('技能内容暂时无法读取'));
    } else if (selection.kind === 'library') {
      const skillId = selection.item.id.split('/').pop() ?? selection.item.name;
      fetchLibrarySkillDetail(selection.item.source, skillId)
        .then((result) => {
          if (!cancelled) setLibraryDetail(result);
        })
        .catch(fail('技能详情暂时无法读取'));
    } else {
      fetchPrompt(selection.item.name)
        .then((result) => {
          if (!cancelled) setPromptDoc(result);
        })
        .catch(fail('提示词内容暂时无法读取'));
    }
    return () => {
      cancelled = true;
    };
  }, [selection]);

  const installed = selection.kind === 'installed' ? selection.item : null;
  const libraryItem = selection.kind === 'library' ? selection.item : null;
  const prompt = selection.kind === 'prompt' ? selection.item : null;
  const name = installed?.name ?? libraryItem?.name ?? prompt?.name ?? '';
  const loading =
    !error &&
    ((installed && content === null) ||
      (libraryItem && libraryDetail === null) ||
      (prompt && promptDoc === null));

  return (
    <motion.div
      key={selectionKey(selection)}
      className="skills-detail"
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18, ease: MOTION_EASE }}
    >
      <div className="skills-detail-head">
        <span className="skills-detail-icon" aria-hidden="true">
          {prompt ? <FileText size={16} /> : <PuzzlePiece size={16} />}
        </span>
        <span className="skills-detail-title">
          <strong>{name}</strong>
          <small>{installed?.path ?? libraryItem?.id ?? prompt?.path}</small>
        </span>
        {installed && (
          <button
            type="button"
            className="header-button danger"
            disabled={busy !== null}
            onClick={() => onRemove(installed)}
          >
            <Trash size={13} />
            删除
          </button>
        )}
        {libraryItem &&
          (libraryItem.installed ? (
            <button type="button" className="header-button" disabled>
              <Check size={12} />
              已安装
            </button>
          ) : (
            <button
              type="button"
              className="header-button primary"
              disabled={busy !== null}
              onClick={() => onInstall(libraryItem)}
            >
              {busy === libraryItem.id ? (
                <CircleNotch size={12} className="spinning" />
              ) : (
                <DownloadSimple size={12} />
              )}
              安装
            </button>
          ))}
        <button type="button" className="icon-button" aria-label="关闭详情" onClick={onClose}>
          <X size={14} />
        </button>
      </div>

      <div className="skills-detail-body">
        {(installed || libraryItem) && (
          <span className="skills-detail-badges">
            {installed && (
              <span className="skill-badge">
                {installed.scope === 'agents' ? '.agents/skills' : '.codex/skills'}
              </span>
            )}
            {(installed?.source ?? libraryItem?.source) && (
              <span className="skill-badge">{installed?.source ?? libraryItem?.source}</span>
            )}
            {libraryItem?.rank !== undefined && (
              <span className="skill-badge">#{libraryItem.rank}</span>
            )}
            {(libraryItem?.installs ?? 0) > 0 && (
              <span className="skill-badge">
                {formatInstallCount(libraryItem!.installs)} 次安装
              </span>
            )}
          </span>
        )}

        {loading && (
          <p className="skills-detail-loading">
            <CircleNotch size={14} className="spinning" />
            正在读取详情…
          </p>
        )}
        {error && (
          <p className="modal-error" role="alert">
            {error}
          </p>
        )}

        {content && (
          <>
            {content.description && <p className="skills-detail-desc">{content.description}</p>}
            <div className="markdown">
              <Markdown remarkPlugins={[remarkGfm]}>{content.content}</Markdown>
            </div>
          </>
        )}
        {libraryDetail && (
          <p className="skills-detail-desc">
            {libraryDetail.description ?? '（skills.sh 未提供描述）'}
          </p>
        )}
        {promptDoc && (
          <div className="markdown">
            <Markdown remarkPlugins={[remarkGfm]}>{promptDoc.content}</Markdown>
          </div>
        )}
      </div>
    </motion.div>
  );
}

export function SkillsView() {
  const { workspace, notify } = useWorkspace();
  const prompts = workspace.prompts;
  const [scope, setScope] = useState<SkillScope>('installed');
  const [query, setQuery] = useState('');
  const [appliedQuery, setAppliedQuery] = useState('');
  const [selection, setSelection] = useState<SkillSelection | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState('');
  const [pendingRemove, setPendingRemove] = useState<InstalledSkillSummary | null>(null);

  /** 技能库搜索 300ms 防抖；本地范围即时过滤。 */
  useEffect(() => {
    const timer = setTimeout(() => setAppliedQuery(query.trim()), 300);
    return () => clearTimeout(timer);
  }, [query]);

  const installed = useAsyncData(fetchInstalledSkills, {
    onError: (cause) => setActionError(cause.message),
  });
  const { reload: reloadInstalled } = installed;
  useEffect(() => {
    void reloadInstalled();
  }, [reloadInstalled]);

  const [libraryError, setLibraryError] = useState('');
  const library = useAsyncData(() => fetchSkillLibrary(appliedQuery), {
    onError: (cause) => setLibraryError(cause.message),
  });
  const { reload: reloadLibrary } = library;
  useEffect(() => {
    if (scope !== 'library') return;
    setLibraryError('');
    void reloadLibrary();
  }, [reloadLibrary, appliedQuery, scope]);

  const keyword = query.trim().toLowerCase();
  const matches = (...fields: Array<string | undefined>) =>
    !keyword || fields.some((field) => field?.toLowerCase().includes(keyword));

  const installedItems = useMemo(
    () =>
      (installed.data?.items ?? []).filter((item) =>
        matches(item.name, item.description, item.preview, item.source),
      ),
    // matches 依赖 keyword，useMemo 语义不变
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [installed.data, keyword],
  );
  const libraryItems = useMemo(() => library.data?.items ?? [], [library.data]);
  const promptItems = useMemo(
    () => prompts.filter((prompt) => matches(prompt.name, prompt.description, prompt.path)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [prompts, keyword],
  );

  /** 选中项被过滤出当前列表或切走范围时收起详情坞。 */
  useEffect(() => {
    if (!selection) return;
    const inList =
      (selection.kind === 'installed' &&
        scope === 'installed' &&
        installedItems.some((item) => item.path === selection.item.path)) ||
      (selection.kind === 'library' &&
        scope === 'library' &&
        libraryItems.some((item) => item.id === selection.item.id)) ||
      (selection.kind === 'prompt' &&
        scope === 'prompts' &&
        promptItems.some((item) => item.path === selection.item.path));
    if (!inList) setSelection(null);
  }, [scope, installedItems, libraryItems, promptItems, selection]);

  const install = async (item: LibrarySkillSummary) => {
    if (busy || item.installed) return;
    setBusy(item.id);
    try {
      const skillId = item.id.split('/').pop() ?? item.name;
      const result = await installSkill({ source: item.source, skillId });
      installed.setData(result);
      // 本地立刻打上已安装标记，不必等技能库重新拉取。
      library.setData(
        library.data && {
          ...library.data,
          items: library.data.items.map((entry) =>
            entry.id === item.id ? { ...entry, installed: true } : entry,
          ),
        },
      );
      setSelection({ kind: 'library', item: { ...item, installed: true } });
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : '技能暂时无法安装');
    } finally {
      setBusy(null);
    }
  };

  const confirmRemove = async () => {
    if (!pendingRemove || busy) return;
    setBusy(pendingRemove.name);
    setActionError('');
    try {
      installed.setData(
        await removeSkill({ name: pendingRemove.name, scope: pendingRemove.scope }),
      );
      if (selection?.kind === 'installed' && selection.item.path === pendingRemove.path) {
        setSelection(null);
      }
      setPendingRemove(null);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : '技能暂时无法删除');
    } finally {
      setBusy(null);
    }
  };

  /** 手工上传：客户端读 .md 文件，文件名 slug 化预填 name；成功后刷新列表并打开详情坞。 */
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const upload = async (file: File) => {
    const name = skillNameFromFile(file.name);
    if (!name) {
      notify(`无法从文件名「${file.name}」推导合法技能名（需 [a-z0-9-]）`);
      return;
    }
    setBusy(name);
    setActionError('');
    try {
      const content = await file.text();
      const summary = await uploadSkill({ name, content });
      await reloadInstalled();
      setScope('installed');
      setSelection({ kind: 'installed', item: summary });
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : '技能暂时无法上传');
    } finally {
      setBusy(null);
    }
  };

  const listLoading =
    (scope === 'installed' && !installed.loaded) || (scope === 'library' && library.loading);
  const listError = scope === 'library' && libraryError && library.data === null;

  return (
    <div className="explore skills-page">
      <header className="explore-header compact skills-header">
        <div>
          <h3>Skills</h3>
          <p>本地已安装的技能与提示词模板，以及 skills.sh 技能库。</p>
        </div>
        <div className="skills-header-actions">
          <button
            type="button"
            className="header-button primary"
            disabled={busy !== null}
            onClick={() => fileInputRef.current?.click()}
          >
            <UploadSimple size={13} />
            上传技能
          </button>
        </div>
      </header>
      <input
        ref={fileInputRef}
        type="file"
        accept=".md"
        hidden
        data-testid="skill-upload-input"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file) void upload(file);
        }}
      />

      {actionError && (
        <p className="modal-error" role="alert">
          {actionError}
        </p>
      )}

      <div className="skills-toolbar">
        <div className="session-tabs" role="tablist" aria-label="技能范围">
          <button
            type="button"
            role="tab"
            aria-selected={scope === 'installed'}
            className={cx('session-tab', scope === 'installed' && 'active')}
            onClick={() => setScope('installed')}
          >
            已安装
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={scope === 'library'}
            className={cx('session-tab', scope === 'library' && 'active')}
            onClick={() => setScope('library')}
          >
            技能库
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={scope === 'prompts'}
            className={cx('session-tab', scope === 'prompts' && 'active')}
            onClick={() => setScope('prompts')}
          >
            提示词
          </button>
        </div>
        <label className="explore-search skills-toolbar-search">
          <MagnifyingGlass size={12} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={scope === 'library' ? '搜索 skills.sh 技能库…' : '搜索名称、描述或路径…'}
            aria-label="搜索技能"
          />
        </label>
      </div>

      <div className="skills-body">
        <div className="skills-grid-scroll">
          {listLoading && <p className="explore-hint skills-grid-hint">正在读取…</p>}
          {listError && (
            <div className="skills-grid-hint">
              <p className="explore-empty-title">技能库暂时不可用</p>
              <p className="explore-hint">{libraryError}</p>
            </div>
          )}
          {!listLoading && !listError && (
            <AnimatePresence mode="wait">
              <motion.div
                key={scope}
                className="skills-grid"
                role="list"
                aria-label={
                  scope === 'installed'
                    ? '已安装技能'
                    : scope === 'library'
                      ? '技能库'
                      : '提示词模板'
                }
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.15, ease: MOTION_EASE }}
              >
                {scope === 'installed' &&
                  (installedItems.length ? (
                    installedItems.map((item) => (
                      <SkillCard
                        key={item.path}
                        icon={<PuzzlePiece size={15} />}
                        name={item.name}
                        desc={item.description ?? item.preview}
                        meta={
                          <>
                            <span className="skill-badge">
                              {item.scope === 'agents' ? '.agents' : '.codex'}
                            </span>
                            {item.source && <span>{item.source}</span>}
                          </>
                        }
                        selected={
                          selection?.kind === 'installed' && selection.item.path === item.path
                        }
                        onSelect={() => setSelection({ kind: 'installed', item })}
                      />
                    ))
                  ) : (
                    <p className="explore-hint skills-grid-hint">
                      {keyword
                        ? `没有匹配「${query.trim()}」的技能`
                        : '暂无已安装技能，去技能库逛逛'}
                    </p>
                  ))}
                {scope === 'library' &&
                  (libraryItems.length ? (
                    libraryItems.map((item) => (
                      <SkillCard
                        key={item.id}
                        icon={<PuzzlePiece size={15} />}
                        name={item.name}
                        desc={item.description}
                        meta={
                          <>
                            {item.installed ? (
                              <span className="skill-card-installed">
                                <Check size={11} />
                                已安装
                              </span>
                            ) : (
                              item.installs > 0 && (
                                <span>{formatInstallCount(item.installs)} 次安装</span>
                              )
                            )}
                            <span>{item.source}</span>
                          </>
                        }
                        selected={selection?.kind === 'library' && selection.item.id === item.id}
                        onSelect={() => setSelection({ kind: 'library', item })}
                      />
                    ))
                  ) : (
                    <p className="explore-hint skills-grid-hint">
                      {appliedQuery.length >= 2
                        ? `没有匹配「${appliedQuery}」的技能`
                        : '榜单暂无数据'}
                    </p>
                  ))}
                {scope === 'prompts' &&
                  (promptItems.length ? (
                    promptItems.map((prompt) => (
                      <SkillCard
                        key={prompt.path}
                        icon={<FileText size={15} />}
                        name={prompt.name}
                        desc={prompt.description ?? prompt.preview}
                        meta={<span>{prompt.path}</span>}
                        selected={
                          selection?.kind === 'prompt' && selection.item.path === prompt.path
                        }
                        onSelect={() => setSelection({ kind: 'prompt', item: prompt })}
                      />
                    ))
                  ) : (
                    <p className="explore-hint skills-grid-hint">
                      {keyword ? `没有匹配「${query.trim()}」的提示词` : '暂无提示词模板'}
                    </p>
                  ))}
              </motion.div>
            </AnimatePresence>
          )}
        </div>

        <AnimatePresence>
          {selection && (
            <motion.aside
              className="skills-dock"
              initial={{ opacity: 0, x: 24 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 24 }}
              transition={SPRING}
            >
              <SkillDetailPane
                selection={selection}
                busy={busy}
                onInstall={(item) => void install(item)}
                onRemove={(item) => setPendingRemove(item)}
                onClose={() => setSelection(null)}
              />
            </motion.aside>
          )}
        </AnimatePresence>
      </div>

      <AnimatePresence>
        {pendingRemove && (
          <motion.div
            className="modal-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            onClick={() => {
              if (!busy) setPendingRemove(null);
            }}
          >
            <motion.div
              className="modal-card"
              role="dialog"
              aria-modal="true"
              aria-label={`删除技能 ${pendingRemove.name}`}
              onKeyDown={(event) => {
                if (event.key === 'Escape' && !busy) setPendingRemove(null);
              }}
              initial={{ opacity: 0, scale: 0.96, y: 8 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.96, y: 8 }}
              transition={{ duration: 0.2, ease: MOTION_EASE }}
              onClick={(event) => event.stopPropagation()}
            >
              <div className="modal-head">
                <strong>删除技能：{pendingRemove.name}</strong>
                <button
                  type="button"
                  className="icon-button"
                  aria-label="关闭"
                  onClick={() => setPendingRemove(null)}
                  disabled={busy !== null}
                >
                  <X size={14} />
                </button>
              </div>
              <p className="modal-hint">
                将从 <code>{pendingRemove.path}</code> 移除该技能（
                {pendingRemove.scope === 'codex' ? '删除目录' : 'skills remove'}）。此操作不可撤销。
              </p>
              <div className="modal-actions">
                <button
                  type="button"
                  className="header-button"
                  autoFocus
                  onClick={() => setPendingRemove(null)}
                  disabled={busy !== null}
                >
                  取消
                </button>
                <button
                  type="button"
                  className="header-button danger"
                  onClick={() => void confirmRemove()}
                  disabled={busy !== null}
                >
                  {busy === pendingRemove.name ? (
                    <CircleNotch size={13} className="spinning" />
                  ) : null}
                  删除
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
