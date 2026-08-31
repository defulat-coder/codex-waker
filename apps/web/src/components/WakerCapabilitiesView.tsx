import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import type { HumanActionRecord, WakerConnector } from '@waker/contracts';
import {
  createConnector,
  connectorAction,
  deleteConnector,
  fetchConnectors,
  fetchHumanActions,
  fetchPermissions,
  updatePermissions,
  type PermissionEnvelope,
} from '../lib/api.js';
import { cx } from '../lib/cx.js';
import { readableErrorMessage } from '../lib/errors.js';
import { MotionLoadingRows } from './MotionFeedback.js';
import type { Notify } from './Toasts.js';

type Tab = 'connectors' | 'permissions' | 'actions';
const TABS: Tab[] = ['connectors', 'permissions', 'actions'];
const CONNECTOR_STATUS: Record<WakerConnector['status'], string> = {
  disabled: '已禁用',
  ready: '就绪',
  error: '异常',
};
const ACTION_STATUS: Record<HumanActionRecord['status'], string> = {
  pending: '待处理',
  handled: '已处理',
  ignored: '已忽略',
};

function tabLabel(tab: Tab, actionCount = 0): string {
  if (tab === 'connectors') return '连接器';
  if (tab === 'permissions') return '权限';
  return `人工操作${actionCount ? ` (${actionCount})` : ''}`;
}

export function WakerCapabilitiesView({
  wakerId,
  initialTab,
  onClose,
  notify,
}: {
  wakerId: string;
  /** 详情导航「连接器/权限」深链的目标页签；不传保持默认 connectors。 */
  initialTab?: 'connectors' | 'permissions';
  onClose: () => void;
  notify: Notify;
}) {
  const [tab, setTab] = useState<Tab>(initialTab ?? 'connectors');
  const [connectors, setConnectors] = useState<WakerConnector[] | null>(null);
  const [permissions, setPermissions] = useState<PermissionEnvelope | null>(null);
  const [actions, setActions] = useState<HumanActionRecord[] | null>(null);
  const [error, setError] = useState('');
  const [form, setForm] = useState<{ name: string; transport: 'stdio' | 'http'; endpoint: string }>(
    { name: '', transport: 'stdio', endpoint: '' },
  );
  const [busy, setBusy] = useState('');
  const busyRef = useRef(false);
  const beginAction = (key: string) => {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusy(key);
    return true;
  };
  const finishAction = () => {
    busyRef.current = false;
    setBusy('');
  };
  const navigateTabs = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    const current = TABS.indexOf(tab);
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? TABS.length - 1
          : (current + (event.key === 'ArrowLeft' ? -1 : 1) + TABS.length) % TABS.length;
    event.preventDefault();
    setTab(TABS[next]!);
    buttons[next]?.focus();
  };
  const load = useCallback(async () => {
    try {
      setError('');
      const [c, p, a] = await Promise.all([
        fetchConnectors(wakerId),
        fetchPermissions(wakerId),
        fetchHumanActions(wakerId),
      ]);
      setConnectors(c);
      setPermissions(p);
      setActions(a);
    } catch (cause) {
      setError(readableErrorMessage(cause, '能力暂时无法读取'));
    }
  }, [wakerId]);
  useEffect(() => {
    void load();
  }, [load]);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!form.name.trim() || !form.endpoint.trim()) return;
    if (!beginAction('create')) return;
    try {
      await createConnector({
        wakerId,
        name: form.name.trim(),
        transport: form.transport,
        ...(form.transport === 'stdio'
          ? { command: form.endpoint.trim() }
          : { url: form.endpoint.trim() }),
      });
      setForm({ name: '', transport: 'stdio', endpoint: '' });
      await load();
      notify('连接器已创建，默认保持禁用', 'success');
    } catch (cause) {
      notify(readableErrorMessage(cause, '连接器暂时无法创建'), 'error');
    } finally {
      finishAction();
    }
  };
  const mutateConnector = async (
    key: string,
    action: () => Promise<unknown>,
    success: string,
    failure: string,
  ) => {
    if (!beginAction(key)) return;
    try {
      await action();
      await load();
      notify(success, 'success');
    } catch (cause) {
      notify(readableErrorMessage(cause, failure), 'error');
    } finally {
      finishAction();
    }
  };
  const tighten = async () => {
    if (!permissions || !beginAction('permissions')) return;
    const base = permissions.policy ?? permissions.host;
    try {
      await updatePermissions(wakerId, {
        ...base,
        sandboxMode: 'read-only',
        toolGuard: 'deny',
        fileGuard: 'deny',
        builtinTools: [],
      });
      await load();
      notify('权限已收紧，由 codex-host 执行', 'success');
    } catch (cause) {
      notify(readableErrorMessage(cause, '权限暂时无法保存'), 'error');
    } finally {
      finishAction();
    }
  };
  return (
    <section className="legacy-page capabilities-page">
      <header className="legacy-page-header">
        <div>
          <h1>Waker 能力</h1>
          <p>连接器、运行权限与需要人工处理的本地动作。</p>
        </div>
        <button className="legacy-button" onClick={onClose}>
          返回 Waker
        </button>
      </header>
      <div
        className="capability-tabs"
        role="tablist"
        aria-label="Waker 能力分类"
        onKeyDown={navigateTabs}
      >
        {TABS.map((item) => (
          <button
            id={`capability-tab-${item}`}
            role="tab"
            aria-selected={tab === item}
            aria-controls={`capability-panel-${item}`}
            tabIndex={tab === item ? 0 : -1}
            className={cx(tab === item && 'active')}
            key={item}
            onClick={() => setTab(item)}
          >
            {tabLabel(item, actions?.length)}
          </button>
        ))}
      </div>
      <div
        id={`capability-panel-${tab}`}
        role="tabpanel"
        aria-labelledby={`capability-tab-${tab}`}
        tabIndex={0}
      >
        {error ? (
          <div className="legacy-error" role="alert">
            <p>{error}</p>
            <button className="legacy-button" onClick={() => void load()}>
              重试
            </button>
          </div>
        ) : !connectors || !permissions || !actions ? (
          <MotionLoadingRows count={2} label="正在加载能力配置" />
        ) : tab === 'connectors' ? (
          <div>
          <div className="local-notice">
            <strong>不接收 Secret</strong>
            <p>这里只保存公开的启动命令或 HTTP 地址。认证信息应留在 API 进程环境中。</p>
          </div>
          <form className="connector-form" onSubmit={submit}>
            <input
              aria-label="连接器名称"
              placeholder="连接器名称"
              value={form.name}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
            />
            <select
              aria-label="传输方式"
              value={form.transport}
              onChange={(event) =>
                setForm({ ...form, transport: event.target.value as 'stdio' | 'http' })
              }
            >
              <option value="stdio">stdio</option>
              <option value="http">http</option>
            </select>
            <input
              aria-label={form.transport === 'stdio' ? '启动命令' : 'HTTP 地址'}
              placeholder={
                form.transport === 'stdio' ? '例如 npx my-mcp-server' : 'https://localhost:3000/mcp'
              }
              value={form.endpoint}
              onChange={(event) => setForm({ ...form, endpoint: event.target.value })}
            />
            <button
              className="legacy-button primary"
              disabled={Boolean(busy) || !form.name.trim() || !form.endpoint.trim()}
            >
              {busy === 'create' ? '正在创建…' : '创建（默认禁用）'}
            </button>
          </form>
          {connectors.length ? (
            <div className="resource-table">
              {connectors.map((item) => (
                <div className="resource-row" key={item.id}>
                  <div>
                    <strong>{item.name}</strong>
                    <small>
                      {item.transport} · {item.command ?? item.url} · {item.tools.length} 个工具
                      {item.tools.length
                        ? `：${item.tools.map((tool) => tool.name).join('、')}`
                        : ''}
                    </small>
                    {item.error ? <small className="connector-error">{item.error}</small> : null}
                  </div>
                  <span className={cx('resource-status', item.status)}>
                    {CONNECTOR_STATUS[item.status]}
                  </span>
                  <button
                    className="legacy-button"
                    disabled={Boolean(busy)}
                    onClick={() => {
                      const nextAction = item.status === 'disabled' ? 'enable' : 'disable';
                      void mutateConnector(
                        `connector:${item.id}`,
                        () => connectorAction(item.id, nextAction, wakerId),
                        nextAction === 'enable' ? '连接器已启用' : '连接器已禁用',
                        '连接器状态更新失败',
                      );
                    }}
                  >
                    {busy === `connector:${item.id}`
                      ? '正在更新…'
                      : item.status === 'disabled'
                        ? '启用'
                        : '禁用'}
                  </button>
                  <button
                    className="legacy-text-button"
                    disabled={Boolean(busy)}
                    onClick={() => {
                      void mutateConnector(
                        `delete:${item.id}`,
                        () => deleteConnector(item.id, wakerId),
                        '连接器已删除',
                        '连接器删除失败',
                      );
                    }}
                  >
                    {busy === `delete:${item.id}` ? '正在删除…' : '删除'}
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <p className="outputs-empty">还没有连接器。</p>
          )}
          </div>
        ) : tab === 'permissions' ? (
          <div className="permission-grid">
          <article>
            <h2>Host 上限</h2>
            <Policy policy={permissions.host} />
          </article>
          <article>
            <h2>Waker 策略</h2>
            <Policy policy={permissions.policy ?? permissions.host} />
            <button
              className="legacy-button primary"
              disabled={Boolean(busy)}
              onClick={() => void tighten()}
            >
              {busy === 'permissions' ? '正在保存…' : '收紧为只读并禁用工具'}
            </button>
          </article>
          <div className="local-notice">
            <strong>由 codex-host 执行</strong>
            <p>这里的策略只能比 Host 更严格，浏览器不能扩大沙箱、文件或工具权限。</p>
          </div>
          </div>
        ) : (
          <HumanActionsList actions={actions} />
        )}
      </div>
    </section>
  );
}
function Policy({ policy }: { policy: PermissionEnvelope['host'] }) {
  return (
    <dl className="policy-list">
      <dt>Sandbox</dt>
      <dd>{policy.sandboxMode}</dd>
      <dt>Approvals</dt>
      <dd>{policy.approvalPolicy}</dd>
      <dt>Tools</dt>
      <dd>{policy.toolGuard}</dd>
      <dt>Files</dt>
      <dd>{policy.fileGuard}</dd>
      <dt>Built-ins</dt>
      <dd>{policy.builtinTools.join(', ') || 'none'}</dd>
    </dl>
  );
}
export function HumanActionsList({ actions }: { actions: HumanActionRecord[] }) {
  return (
    <section className="human-actions">
      <div className="section-heading">
        <div>
          <h2>待处理操作</h2>
          <p>{actions.length} 项需要人工决定。</p>
        </div>
        <p>处理与忽略统一在任务看板的“人工操作”中完成。</p>
      </div>
      {actions.length ? (
        <div className="resource-table">
          {actions.map((item) => (
            <div className="resource-row" key={item.id}>
              <div>
                <strong>{item.title}</strong>
                <small>
                  {item.prompt} · {item.source}:{item.sourceId}
                </small>
              </div>
              <span className={cx('resource-status', item.status)}>
                {ACTION_STATUS[item.status]}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <p className="outputs-empty">没有待处理操作。</p>
      )}
    </section>
  );
}
