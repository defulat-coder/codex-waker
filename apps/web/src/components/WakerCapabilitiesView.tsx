import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { HumanActionRecord, WakerConnector } from '@waker/contracts';
import {
  createConnector,
  createDemoHumanAction,
  connectorAction,
  deleteConnector,
  fetchConnectors,
  fetchHumanActions,
  fetchPermissions,
  ignoreHumanAction,
  resolveHumanAction,
  updatePermissions,
  type PermissionEnvelope,
} from '../lib/api.js';
import { cx } from '../lib/cx.js';

type Tab = 'connectors' | 'permissions' | 'actions';
export function WakerCapabilitiesView({
  wakerId,
  onClose,
  notify,
}: {
  wakerId: string;
  onClose: () => void;
  notify: (text: string) => void;
}) {
  const [tab, setTab] = useState<Tab>('connectors');
  const [connectors, setConnectors] = useState<WakerConnector[] | null>(null);
  const [permissions, setPermissions] = useState<PermissionEnvelope | null>(null);
  const [actions, setActions] = useState<HumanActionRecord[] | null>(null);
  const [error, setError] = useState('');
  const [form, setForm] = useState<{ name: string; transport: 'stdio' | 'http'; endpoint: string }>(
    { name: '', transport: 'stdio', endpoint: '' },
  );
  const [busy, setBusy] = useState(false);
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
      setError(cause instanceof Error ? cause.message : '能力暂时无法读取');
    }
  }, [wakerId]);
  useEffect(() => {
    void load();
  }, [load]);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!form.name.trim() || !form.endpoint.trim()) return;
    setBusy(true);
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
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : '创建失败');
    } finally {
      setBusy(false);
    }
  };
  const tighten = async () => {
    if (!permissions) return;
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
      notify('权限已收紧，由 codex-host 执行');
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : '保存失败');
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
      <div className="capability-tabs" role="tablist">
        {(['connectors', 'permissions', 'actions'] as const).map((item) => (
          <button
            role="tab"
            aria-selected={tab === item}
            className={cx(tab === item && 'active')}
            key={item}
            onClick={() => setTab(item)}
          >
            {item === 'connectors'
              ? 'Connectors'
              : item === 'permissions'
                ? 'Permissions'
                : `Human Actions${actions?.length ? ` (${actions.length})` : ''}`}
          </button>
        ))}
      </div>
      {error ? (
        <div className="legacy-error" role="alert">
          <p>{error}</p>
          <button className="legacy-button" onClick={() => void load()}>
            重试
          </button>
        </div>
      ) : !connectors || !permissions || !actions ? (
        <div className="loading-rows">
          <i />
          <i />
        </div>
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
              disabled={busy || !form.name.trim() || !form.endpoint.trim()}
            >
              创建（默认禁用）
            </button>
          </form>
          {connectors.length ? (
            <div className="resource-table">
              {connectors.map((item) => (
                <div className="resource-row" key={item.id}>
                  <div>
                    <strong>{item.name}</strong>
                    <small>
                      {item.transport} · {item.command ?? item.url} · {item.tools.length} tools
                    </small>
                  </div>
                  <span className={cx('resource-status', item.status)}>{item.status}</span>
                  <button
                    className="legacy-button"
                    onClick={async () => {
                      await connectorAction(
                        item.id,
                        item.status === 'disabled' ? 'enable' : 'disable',
                        wakerId,
                      );
                      await load();
                    }}
                  >
                    {item.status === 'disabled' ? '启用' : '禁用'}
                  </button>
                  <button
                    className="legacy-text-button"
                    onClick={async () => {
                      await deleteConnector(item.id, wakerId);
                      await load();
                    }}
                  >
                    删除
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
            <button className="legacy-button primary" onClick={() => void tighten()}>
              收紧为只读并禁用工具
            </button>
          </article>
          <div className="local-notice">
            <strong>由 codex-host 执行</strong>
            <p>这里的策略只能比 Host 更严格，浏览器不能扩大沙箱、文件或工具权限。</p>
          </div>
        </div>
      ) : (
        <HumanActionsList
          wakerId={wakerId}
          actions={actions}
          onChanged={() => void load()}
          notify={notify}
          allowDemo
        />
      )}
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
export function HumanActionsList({
  wakerId,
  actions,
  onChanged,
  notify,
  allowDemo = false,
}: {
  wakerId: string;
  actions: HumanActionRecord[];
  onChanged: () => void;
  notify: (text: string) => void;
  allowDemo?: boolean;
}) {
  return (
    <section className="human-actions">
      <div className="section-heading">
        <div>
          <h2>待处理操作</h2>
          <p>{actions.length} 项需要人工决定。</p>
        </div>
        {allowDemo && (
          <button
            className="legacy-button"
            onClick={async () => {
              try {
                await createDemoHumanAction(wakerId);
                onChanged();
              } catch (cause) {
                notify(cause instanceof Error ? cause.message : '创建失败');
              }
            }}
          >
            创建本地演示 Action
          </button>
        )}
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
              <button
                className="legacy-button primary"
                onClick={async () => {
                  await resolveHumanAction(item.id, wakerId, { accepted: true });
                  onChanged();
                }}
              >
                处理
              </button>
              <button
                className="legacy-button"
                onClick={async () => {
                  await ignoreHumanAction(item.id, wakerId);
                  onChanged();
                }}
              >
                忽略
              </button>
            </div>
          ))}
        </div>
      ) : (
        <p className="outputs-empty">没有待处理操作。</p>
      )}
    </section>
  );
}

export function TaskHumanActions({
  wakerId,
  notify,
}: {
  wakerId: string;
  notify: (text: string) => void;
}) {
  const [actions, setActions] = useState<HumanActionRecord[] | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(
    () =>
      fetchHumanActions(wakerId)
        .then(setActions)
        .catch((cause) => setError(cause instanceof Error ? cause.message : '人工操作加载失败')),
    [wakerId],
  );
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <div className="legacy-subsection">
      {error ? (
        <div className="legacy-error">
          <p>{error}</p>
          <button className="legacy-button" onClick={() => void load()}>
            重试
          </button>
        </div>
      ) : actions ? (
        <HumanActionsList
          wakerId={wakerId}
          actions={actions}
          onChanged={() => void load()}
          notify={notify}
        />
      ) : (
        <div className="loading-rows">
          <i />
          <i />
        </div>
      )}
    </div>
  );
}
