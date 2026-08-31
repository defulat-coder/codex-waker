import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Check } from '@phosphor-icons/react/dist/icons/Check';
import { CircleNotch } from '@phosphor-icons/react/dist/icons/CircleNotch';
import { DownloadSimple } from '@phosphor-icons/react/dist/icons/DownloadSimple';
import { MagnifyingGlass } from '@phosphor-icons/react/dist/icons/MagnifyingGlass';
import { PuzzlePiece } from '@phosphor-icons/react/dist/icons/PuzzlePiece';
import { Trash } from '@phosphor-icons/react/dist/icons/Trash';
import { UploadSimple } from '@phosphor-icons/react/dist/icons/UploadSimple';
import { X } from '@phosphor-icons/react/dist/icons/X';
import type {
  InstalledSkillContent,
  InstalledSkillListResponse,
  InstalledSkillSummary,
  LibrarySkillDetail,
  LibrarySkillSummary,
  SkillLibraryResponse,
} from '@waker/contracts';
import {
  fetchInstalledSkillContent,
  fetchInstalledSkills,
  fetchLibrarySkillDetail,
  fetchSkillLibrary,
  installSkill,
  removeSkill,
  uploadSkill,
} from '../lib/api.js';
import { formatInstallCount } from '../lib/explore.js';
import { cx } from '../lib/cx.js';
import { readableErrorMessage } from '../lib/errors.js';
import { MOTION_DIALOG_BACKDROP, MOTION_DIALOG_SURFACE, MOTION_EASE } from '../lib/motion.js';
import { useDialogFocus } from '../hooks/useDialogFocus.js';
import { useVisiblePolling } from '../hooks/useVisiblePolling.js';
import { MotionSpinner } from './MotionFeedback.js';

type Scope = 'installed' | 'library';
type InstalledFilter = 'all' | 'available' | 'invalid' | 'host';
type Selection =
  | { kind: 'installed'; item: InstalledSkillSummary }
  | { kind: 'library'; item: LibrarySkillSummary };

function parseFrontmatter(text: string) {
  const block = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)?.[1];
  const read = (key: string) =>
    block
      ? new RegExp(`^${key}:\\s*["']?(.+?)["']?\\s*$`, 'm').exec(block)?.[1]?.trim()
      : undefined;
  const name = read('name');
  if (!name || !/^[a-z0-9-]{1,80}$/.test(name))
    return { error: 'frontmatter name 必须使用 1–80 个小写字母、数字或连字符' };
  return { name };
}

const scopeLabel = (item: InstalledSkillSummary) =>
  item.scope === 'agents' ? '仓库 Skills' : 'Waker Host（CODEX_HOME）';
const statusLabel = (item: InstalledSkillSummary) => (item.valid ? '有效' : '定义错误');

export function SkillsView() {
  const [scope, setScope] = useState<Scope>('installed');
  const [query, setQuery] = useState('');
  const [installedFilter, setInstalledFilter] = useState<InstalledFilter>('all');
  const [appliedQuery, setAppliedQuery] = useState('');
  const [installed, setInstalled] = useState<InstalledSkillListResponse | null>(null);
  const [library, setLibrary] = useState<SkillLibraryResponse | null>(null);
  const [installedError, setInstalledError] = useState('');
  const [libraryError, setLibraryError] = useState('');
  const [loading, setLoading] = useState('');
  const [selection, setSelection] = useState<Selection | null>(null);
  const [content, setContent] = useState<InstalledSkillContent | null>(null);
  const [libraryDetail, setLibraryDetail] = useState<LibrarySkillDetail | null>(null);
  const [detailError, setDetailError] = useState('');
  const [detailNonce, setDetailNonce] = useState(0);
  const [pendingInstall, setPendingInstall] = useState<LibrarySkillSummary | null>(null);
  const [pendingRemove, setPendingRemove] = useState<InstalledSkillSummary | null>(null);
  const [busy, setBusy] = useState('');
  const [actionError, setActionError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const detailRef = useRef<HTMLElement>(null);
  const triggers = useRef(new Map<string, HTMLButtonElement>());
  const tabs = useRef<Record<Scope, HTMLButtonElement | null>>({ installed: null, library: null });
  const libraryGeneration = useRef(0);
  const detailGeneration = useRef(0);

  useEffect(() => {
    const timer = setTimeout(() => setAppliedQuery(query.trim()), 300);
    return () => clearTimeout(timer);
  }, [query]);
  const loadInstalled = useCallback(async () => {
    setLoading('installed');
    setInstalledError('');
    try {
      setInstalled(await fetchInstalledSkills());
    } catch (cause) {
      setInstalledError(readableErrorMessage(cause, '我的技能暂时无法读取'));
    } finally {
      setLoading('');
    }
  }, []);
  useEffect(() => void loadInstalled(), [loadInstalled]);
  useVisiblePolling(() => void loadInstalled(), 5_000);
  const loadLibrary = useCallback(async () => {
    const generation = ++libraryGeneration.current;
    setLoading('library');
    setLibraryError('');
    try {
      const result = await fetchSkillLibrary(appliedQuery);
      if (generation === libraryGeneration.current) setLibrary(result);
    } catch (cause) {
      if (generation === libraryGeneration.current)
        setLibraryError(readableErrorMessage(cause, '第三方发现源暂时无法读取'));
    } finally {
      if (generation === libraryGeneration.current) setLoading('');
    }
  }, [appliedQuery]);
  useEffect(() => {
    if (scope === 'library') void loadLibrary();
  }, [loadLibrary, scope]);

  useEffect(() => {
    const generation = ++detailGeneration.current;
    setContent(null);
    setLibraryDetail(null);
    setDetailError('');
    if (!selection) return;
    setLoading('detail');
    const request =
      selection.kind === 'installed'
        ? fetchInstalledSkillContent(
            selection.item.scope,
            selection.item.name,
            selection.item.locator,
          ).then((value) => generation === detailGeneration.current && setContent(value))
        : fetchLibrarySkillDetail(
            selection.item.source,
            selection.item.id.split('/').at(-1) ?? selection.item.name,
          ).then((value) => generation === detailGeneration.current && setLibraryDetail(value));
    void request
      .catch((cause) => {
        if (generation === detailGeneration.current)
          setDetailError(readableErrorMessage(cause, '技能详情暂时无法读取'));
      })
      .finally(() => generation === detailGeneration.current && setLoading(''));
  }, [detailNonce, selection]);

  const keyword = query.trim().toLocaleLowerCase();
  const installedItems = useMemo(
    () =>
      (installed?.items ?? []).filter(
        (item) =>
          (installedFilter === 'all' ||
            (installedFilter === 'available' && item.availability === 'available' && item.valid) ||
            (installedFilter === 'invalid' && !item.valid) ||
            (installedFilter === 'host' && item.scope === 'codex')) &&
          [item.name, item.description, item.source, item.locator].some((value) =>
            value?.toLocaleLowerCase().includes(keyword),
          ),
      ),
    [installed, installedFilter, keyword],
  );
  const libraryItems = library?.items ?? [];
  const select = (next: Selection, trigger: HTMLButtonElement) => {
    triggers.current.set(next.kind === 'installed' ? next.item.locator : next.item.id, trigger);
    setSelection(next);
    requestAnimationFrame(() => detailRef.current?.focus());
  };
  const closeDetail = () => {
    const key = selection?.kind === 'installed' ? selection.item.locator : selection?.item.id;
    setSelection(null);
    if (key) requestAnimationFrame(() => triggers.current.get(key)?.focus());
  };
  const selectTab = (next: Scope) => {
    tabs.current[next]?.focus();
    setScope(next);
    setSelection(null);
  };
  const tabKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    if (event.key === 'Home') selectTab('installed');
    else if (event.key === 'End') selectTab('library');
    else selectTab(scope === 'installed' ? 'library' : 'installed');
  };

  const closeInstall = useCallback(() => !busy && setPendingInstall(null), [busy]);
  const installDialog = useDialogFocus<HTMLDivElement>(Boolean(pendingInstall), closeInstall);
  const closeRemove = useCallback(() => !busy && setPendingRemove(null), [busy]);
  const removeDialog = useDialogFocus<HTMLDivElement>(Boolean(pendingRemove), closeRemove);
  const confirmInstall = async () => {
    if (!pendingInstall || !libraryDetail) return;
    setActionError('');
    setBusy(`install:${pendingInstall.id}`);
    try {
      const skillId = pendingInstall.id.split('/').at(-1) ?? pendingInstall.name;
      setInstalled(await installSkill({ source: pendingInstall.source, skillId }));
      setLibrary((current) =>
        current
          ? {
              ...current,
              items: current.items.map((item) =>
                item.id === pendingInstall.id ? { ...item, installed: true } : item,
              ),
            }
          : current,
      );
      setSelection({ kind: 'library', item: { ...pendingInstall, installed: true } });
      setPendingInstall(null);
    } catch (cause) {
      setActionError(readableErrorMessage(cause, '技能暂时无法安装'));
    } finally {
      setBusy('');
    }
  };
  const confirmRemove = async () => {
    if (!pendingRemove) return;
    setActionError('');
    setBusy(`remove:${pendingRemove.locator}`);
    try {
      setInstalled(
        await removeSkill({
          name: pendingRemove.name,
          locator: pendingRemove.locator,
          scope: pendingRemove.scope,
        }),
      );
      setPendingRemove(null);
      setSelection(null);
    } catch (cause) {
      setActionError(readableErrorMessage(cause, '技能暂时无法删除'));
    } finally {
      setBusy('');
    }
  };
  const upload = async (file: File) => {
    setActionError('');
    try {
      const text = await file.text();
      const parsed = parseFrontmatter(text);
      if (!parsed.name) throw new Error(parsed.error ?? 'frontmatter 无效');
      setBusy(`upload:${parsed.name}`);
      const item = await uploadSkill({
        name: parsed.name,
        content: text,
      });
      await loadInstalled();
      setScope('installed');
      setSelection({ kind: 'installed', item });
    } catch (cause) {
      setActionError(readableErrorMessage(cause, 'SKILL.md 暂时无法上传'));
    } finally {
      setBusy('');
    }
  };

  const items = scope === 'installed' ? installedItems : libraryItems;
  const error = scope === 'installed' ? installedError : libraryError;
  return (
    <section className="legacy-page skills-page" aria-labelledby="skills-title">
      <header className="legacy-page-header skills-header">
        <div>
          <h1 id="skills-title">Skills</h1>
          <p>工作区共享，不是 per-Waker；安装、上传与删除会修改项目 Skills 配置。</p>
        </div>
        <button
          className="legacy-button primary"
          type="button"
          disabled={Boolean(busy)}
          onClick={() => fileRef.current?.click()}
        >
          <UploadSimple size={14} /> 上传 SKILL.md
        </button>
      </header>
      <input
        ref={fileRef}
        type="file"
        accept=".md,text/markdown,text/plain"
        hidden
        data-testid="skill-upload-input"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file) void upload(file);
        }}
      />
      <div className="local-notice skills-scope-notice">
        <PuzzlePiece size={18} />
        <div>
          <strong>仅 instruction-only</strong>
          <p>必须包含 name/description frontmatter；不上传脚本或可执行附件。</p>
        </div>
      </div>
      {actionError && (
        <p className="automation-action-error" role="alert">
          {actionError}
        </p>
      )}
      <div className="skills-toolbar">
        <div className="session-tabs" role="tablist" aria-label="Skills 区域">
          {(['installed', 'library'] as const).map((id) => (
            <button
              key={id}
              ref={(node) => {
                tabs.current[id] = node;
              }}
              id={`skills-tab-${id}`}
              className={cx('session-tab', scope === id && 'active')}
              type="button"
              role="tab"
              aria-selected={scope === id}
              aria-controls={`skills-panel-${id}`}
              tabIndex={scope === id ? 0 : -1}
              onClick={() => selectTab(id)}
              onKeyDown={tabKey}
            >
              {id === 'installed' ? '我的技能' : '第三方发现源'}
            </button>
          ))}
        </div>
        <label className="explore-search skills-toolbar-search">
          <MagnifyingGlass size={13} />
          <input
            aria-label="搜索 Skills"
            value={query}
            placeholder={scope === 'library' ? '搜索 skills.sh…' : '搜索名称、locator 或来源…'}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        {scope === 'installed' && (
          <label className="skills-scope-filter">
            <span>范围</span>
            <select
              aria-label="筛选已安装 Skills"
              value={installedFilter}
              onChange={(event) => setInstalledFilter(event.target.value as InstalledFilter)}
            >
              <option value="all">全部</option>
              <option value="available">运行时可用</option>
              <option value="invalid">定义错误</option>
              <option value="host">Waker Host</option>
            </select>
          </label>
        )}
      </div>
      <div className="skills-body">
        <div
          id={`skills-panel-${scope}`}
          className="skills-grid-scroll"
          role="tabpanel"
          aria-labelledby={`skills-tab-${scope}`}
        >
          {loading === scope && !items.length ? (
            <p role="status" className="skills-grid-hint">
              正在读取 Skills…
            </p>
          ) : error ? (
            <div className="legacy-error" role="alert">
              <p>{error}</p>
              <button
                className="legacy-button"
                type="button"
                onClick={() => void (scope === 'installed' ? loadInstalled() : loadLibrary())}
              >
                重试
              </button>
            </div>
          ) : items.length ? (
            <div
              className="skills-grid"
              role="list"
              aria-label={scope === 'installed' ? '我的技能' : '第三方发现源'}
            >
              {scope === 'installed'
                ? installedItems.map((item) => (
                    <Card
                      key={item.locator}
                      id={`skill-detail-${encodeURIComponent(item.locator)}`}
                      name={item.name}
                      desc={item.description}
                      selected={
                        selection?.kind === 'installed' && selection.item.locator === item.locator
                      }
                      meta={`${scopeLabel(item)} · ${statusLabel(item)} · ${item.integrity}${item.version ? ` · v${item.version}` : ''}`}
                      onSelect={(trigger) => select({ kind: 'installed', item }, trigger)}
                    />
                  ))
                : libraryItems.map((item) => (
                    <Card
                      key={item.id}
                      id={`skill-detail-${encodeURIComponent(item.id)}`}
                      name={item.name}
                      desc={item.description}
                      selected={selection?.kind === 'library' && selection.item.id === item.id}
                      meta={`${item.source}${item.installed ? ' · 已安装' : item.installs ? ` · ${formatInstallCount(item.installs)} 次安装` : ''}`}
                      onSelect={(trigger) => select({ kind: 'library', item }, trigger)}
                    />
                  ))}
            </div>
          ) : (
            <p className="skills-grid-hint">
              {query.trim()
                ? `没有匹配“${query.trim()}”的 Skills`
                : scope === 'installed'
                  ? '工作区尚未安装 Skills'
                  : '第三方发现源暂无数据'}
            </p>
          )}
        </div>
        <AnimatePresence>
          {selection && (
            <motion.aside
              ref={detailRef}
              id={
                selection.kind === 'installed'
                  ? `skill-detail-${encodeURIComponent(selection.item.locator)}`
                  : `skill-detail-${encodeURIComponent(selection.item.id)}`
              }
              className="skills-dock"
              aria-labelledby="skills-detail-title"
              tabIndex={-1}
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 20 }}
              transition={{ duration: 0.18, ease: MOTION_EASE }}
              onKeyDown={(event) => {
                if (event.key !== 'Escape') return;
                event.stopPropagation();
                closeDetail();
              }}
            >
              <Detail
                selection={selection}
                content={content}
                libraryDetail={libraryDetail}
                loading={loading === 'detail'}
                error={detailError}
                busy={busy}
                onClose={closeDetail}
                onInstall={() => {
                  if (selection.kind !== 'library' || !libraryDetail) return;
                  setActionError('');
                  setPendingInstall(selection.item);
                }}
                onRemove={() => {
                  if (selection.kind !== 'installed') return;
                  setActionError('');
                  setPendingRemove(selection.item);
                }}
                onRetry={() => setDetailNonce((value) => value + 1)}
              />
            </motion.aside>
          )}
        </AnimatePresence>
      </div>
      {pendingInstall && libraryDetail && (
        <Dialog
          refValue={installDialog}
          title="安装第三方 Skill？"
          onClose={closeInstall}
          action="确认安装"
          busy={busy}
          onConfirm={() => void confirmInstall()}
          error={actionError}
        >
          <p>{libraryDetail.riskNotice}</p>
          <p>
            来源：{pendingInstall.source} · 内容审查：
            {libraryDetail.contentReviewed ? '已审查' : '未审查'}
          </p>
        </Dialog>
      )}
      {pendingRemove && (
        <Dialog
          refValue={removeDialog}
          title={`删除“${pendingRemove.name}”？`}
          onClose={closeRemove}
          action="确认删除"
          danger
          busy={busy}
          onConfirm={() => void confirmRemove()}
          error={actionError}
        >
          <p>
            {pendingRemove.scope === 'agents'
              ? '将通过 Skills CLI 更新 .agents/skills 与 skills-lock.json。'
              : '将从项目 CODEX_HOME 的 .codex/skills 中删除这个真实生效的 Host Skill。'}
          </p>
          <code>{pendingRemove.locator}</code>
        </Dialog>
      )}
    </section>
  );
}

function Card({
  id,
  name,
  desc,
  meta,
  selected,
  onSelect,
}: {
  id: string;
  name: string;
  desc?: string;
  meta: string;
  selected: boolean;
  onSelect: (trigger: HTMLButtonElement) => void;
}) {
  return (
    <div role="listitem">
      <button
        type="button"
        className={cx('skill-card', selected && 'selected')}
        aria-expanded={selected}
        aria-controls={id}
        onClick={(event) => onSelect(event.currentTarget)}
      >
        <span className="skill-card-head">
          <PuzzlePiece size={15} />
          <strong>{name}</strong>
        </span>
        {desc && <span className="skill-card-desc">{desc}</span>}
        <span className="skill-card-meta">{meta}</span>
      </button>
    </div>
  );
}

function Detail({
  selection,
  content,
  libraryDetail,
  loading,
  error,
  busy,
  onClose,
  onInstall,
  onRemove,
  onRetry,
}: {
  selection: Selection;
  content: InstalledSkillContent | null;
  libraryDetail: LibrarySkillDetail | null;
  loading: boolean;
  error: string;
  busy: string;
  onClose: () => void;
  onInstall: () => void;
  onRemove: () => void;
  onRetry: () => void;
}) {
  const installed = selection.kind === 'installed' ? selection.item : null;
  const library = selection.kind === 'library' ? selection.item : null;
  return (
    <>
      <div className="skills-detail-head">
        <div className="skills-detail-title">
          <h2 id="skills-detail-title">{selection.item.name}</h2>
          <small>{installed?.locator ?? library?.id}</small>
        </div>
        {installed ? (
          <button
            className="legacy-button danger"
            type="button"
            disabled={Boolean(busy)}
            onClick={onRemove}
          >
            <Trash size={13} /> 删除
          </button>
        ) : library?.installed ? (
          <span>
            <Check size={12} /> 已安装
          </span>
        ) : (
          <button
            className="legacy-button primary"
            type="button"
            disabled={Boolean(busy) || !libraryDetail}
            onClick={onInstall}
          >
            <DownloadSimple size={13} /> 安装
          </button>
        )}
        <button className="icon-button" type="button" aria-label="关闭技能详情" onClick={onClose}>
          <X size={15} />
        </button>
      </div>
      <div className="skills-detail-body">
        {loading && <p role="status">正在读取详情…</p>}
        {error && (
          <div className="automation-action-error" role="alert">
            <span>{error}</span>
            <button className="legacy-button" type="button" onClick={onRetry}>
              重试
            </button>
          </div>
        )}
        {installed && content && (
          <>
            <dl className="skill-facts">
              <div>
                <dt>版本</dt>
                <dd>{content.version ?? '未声明'}</dd>
              </div>
              <div>
                <dt>来源</dt>
                <dd>{content.source ?? scopeLabel(installed)}</dd>
              </div>
              <div>
                <dt>完整性</dt>
                <dd>{content.integrity}</dd>
              </div>
              <div>
                <dt>隐式调用</dt>
                <dd>{content.allowImplicitInvocation ? '允许' : '不允许'}</dd>
              </div>
              <div>
                <dt>Lock hash</dt>
                <dd>{installed.lock?.computedHash ?? '未验证'}</dd>
              </div>
              <div>
                <dt>来源 commit</dt>
                <dd>{installed.lock?.commit ?? '未记录'}</dd>
              </div>
              <div>
                <dt>状态</dt>
                <dd>{statusLabel(installed)}</dd>
              </div>
            </dl>
            {!content.valid && (
              <ul className="workflow-validation">
                {content.errors.map((value) => (
                  <li key={value}>{value}</li>
                ))}
              </ul>
            )}
            <section>
              <h3>依赖</h3>
              {content.dependencies.length ? (
                <ul>
                  {content.dependencies.map((value) => (
                    <li key={`${value.type}:${value.value}`}>
                      <code>
                        {value.type}:{value.value}
                      </code>
                    </li>
                  ))}
                </ul>
              ) : (
                <p>无声明依赖</p>
              )}
            </section>
            <section>
              <h3>文件</h3>
              {content.files.length ? (
                <ul>
                  {content.files.map((value) => (
                    <li key={value.path}>
                      <code>{value.path}</code> · {value.size} B
                      {value.executable ? ' · 可执行' : ''}
                      {value.symlink ? ' · 符号链接' : ''}
                    </li>
                  ))}
                </ul>
              ) : (
                <p>仅 SKILL.md</p>
              )}
            </section>
            <section>
              <h3>说明正文</h3>
              <div className="markdown">
                <Markdown
                  remarkPlugins={[remarkGfm]}
                  components={{ img: ({ alt }) => <span>[已阻止图片：{alt ?? '无描述'}]</span> }}
                >
                  {content.content}
                </Markdown>
              </div>
            </section>
          </>
        )}
        {library && libraryDetail && (
          <>
            <p>{libraryDetail.description ?? '第三方发现源未提供描述。'}</p>
            <div className="local-notice">
              <PuzzlePiece size={17} />
              <div>
                <strong>第三方、内容未审查</strong>
                <p>{libraryDetail.riskNotice}</p>
              </div>
            </div>
          </>
        )}
      </div>
    </>
  );
}

function Dialog({
  refValue,
  title,
  children,
  action,
  danger = false,
  busy,
  onClose,
  onConfirm,
  error,
}: {
  refValue: React.RefObject<HTMLDivElement | null>;
  title: string;
  children: React.ReactNode;
  action: string;
  danger?: boolean;
  busy: string;
  onClose: () => void;
  onConfirm: () => void;
  error?: string;
}) {
  return (
    <motion.div className="modal-backdrop" {...MOTION_DIALOG_BACKDROP} onMouseDown={onClose}>
      <motion.div
        ref={refValue}
        className="skill-risk-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        {...MOTION_DIALOG_SURFACE}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h2>{title}</h2>
        {children}
        {error && (
          <p className="automation-action-error" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button className="legacy-button" type="button" onClick={onClose}>
            取消
          </button>
          <button
            className={cx('legacy-button', danger ? 'danger' : 'primary')}
            type="button"
            disabled={Boolean(busy)}
            onClick={onConfirm}
          >
            {busy && (
              <MotionSpinner>
                <CircleNotch size={13} />
              </MotionSpinner>
            )}
            {action}
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}
