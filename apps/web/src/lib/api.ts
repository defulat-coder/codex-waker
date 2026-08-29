import type {
  AgentDetail,
  AgentDeleteImpact,
  AgentHomeResponse,
  AgentResources,
  AgentTemplate,
  AgentTemplatesResponse,
  AgentThinkingLevel,
  AppendSystemResponse,
  ChatErrorKind,
  ChatRequest,
  ChatStreamEvent,
  CreateAgentRequest,
  FileContentResponse,
  FileListResponse,
  InboxItem,
  InboxReadAllResponse,
  InboxResponse,
  InboxTab,
  ImportAgentRequest,
  InstalledSkillContent,
  InstalledSkillListResponse,
  InstalledSkillSummary,
  LibrarySkillDetail,
  LocalResourcesResponse,
  MemoryDocument,
  MemoryMaintenanceReport,
  MemoryScope,
  MemorySnapshot,
  MemoryTimelineEntry,
  MemoryVersion,
  AutomationRunRecord,
  SessionAttachment,
  SessionArtifact,
  SessionFileChange,
  SessionOutputsResponse,
  SummarizeAgentProfileRequest,
  SummarizeAgentProfileResponse,
  WakerConnector,
  WakerPermissionPolicy,
  HumanActionRecord,
  KnowledgeBinding,
  KnowledgeDocument,
  KnowledgeNotebook,
  KnowledgeSearchRequest,
  KnowledgeSearchResponse,
  KnowledgeScope,
  CreateKnowledgeNotebookRequest,
  ImportKnowledgeUrlsRequest,
  ImportKnowledgeUrlsResponse,
  UpsertKnowledgeDocumentRequest,
  PreferencesResponse,
  PromptDocument,
  SessionListResponse,
  SessionContextRecord,
  SessionMessage,
  SessionMessagesResponse,
  SessionSummary,
  SettingsResponse,
  SkillInstallRequest,
  SkillLibraryResponse,
  SkillListResponse,
  SkillRemoveRequest,
  SkillSummary,
  UpdateAgentRequest,
  UpdateInboxStateRequest,
  UpdatePromptRequest,
  UploadSkillRequest,
  UsageResponse,
  WorkspaceResponse,
  WakerAutomation,
  WakerChannel,
  WakerProject,
  WakerTask,
  WakerWorkflow,
} from '@waker/contracts';
import { decodeStreamEvent, extractSseBlocks, flushSseBlocks } from './stream.js';
import { readFileBase64 } from './composerAttachments.js';

async function readJson<T>(response: Response, fallback: string): Promise<T> {
  if (!response.ok) {
    let message = fallback;
    try {
      const body = (await response.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // Keep the fallback message when the error body is not JSON.
    }
    throw new Error(message);
  }
  return response.json() as Promise<T>;
}

export async function fetchWorkspace(signal?: AbortSignal): Promise<WorkspaceResponse> {
  return readJson(await fetch('/api/v1/workspace', { signal }), '工作区信息暂时无法读取');
}

export async function fetchLocalResources(
  wakerId: string,
  signal?: AbortSignal,
): Promise<LocalResourcesResponse> {
  const query = new URLSearchParams({ wakerId });
  return readJson(
    await fetch(`/api/v1/local-resources?${query}`, { signal }),
    '本地资源暂时无法读取',
  );
}

type LocalResource = WakerProject | WakerAutomation | WakerWorkflow | WakerChannel | WakerTask;
type LocalResourceKind = 'projects' | 'automations' | 'workflows' | 'channels' | 'tasks';

export async function createLocalResource<T extends LocalResource>(
  kind: LocalResourceKind,
  input: Partial<T>,
): Promise<T> {
  return readJson(
    await fetch(`/api/v1/${kind}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    }),
    '本地资源暂时无法创建',
  );
}

export async function runAutomation(id: string, wakerId: string): Promise<AutomationRunRecord> {
  return readJson(
    await fetch(`/api/v1/automations/${encodeURIComponent(id)}/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ wakerId }),
    }),
    '自动任务暂时无法运行',
  );
}

export async function updateAutomation(
  id: string,
  wakerId: string,
  patch: Pick<
    Partial<WakerAutomation>,
    'name' | 'schedule' | 'prompt' | 'enabled' | 'timezone' | 'misfirePolicy'
  > & {
    startAt?: string | null;
    endAt?: string | null;
    maxRuns?: number | null;
    projectId?: string | null;
    model?: string | null;
    thinking?: AgentThinkingLevel | null;
  },
): Promise<WakerAutomation> {
  return readJson(
    await fetch(`/api/v1/automations/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ wakerId, ...patch }),
    }),
    '自动任务暂时无法保存',
  );
}

export interface AutomationDeleteImpact {
  automationId: string;
  runs: number;
  tasks: number;
  sessions: number;
}

export async function fetchAutomationDeleteImpact(
  id: string,
  wakerId: string,
): Promise<AutomationDeleteImpact> {
  const query = new URLSearchParams({ wakerId });
  return readJson(
    await fetch(`/api/v1/automations/${encodeURIComponent(id)}/delete-impact?${query}`),
    '删除影响暂时无法读取',
  );
}

export async function deleteAutomation(id: string, wakerId: string): Promise<void> {
  const query = new URLSearchParams({ wakerId });
  const response = await fetch(`/api/v1/automations/${encodeURIComponent(id)}?${query}`, {
    method: 'DELETE',
  });
  if (!response.ok) await readJson(response, '自动任务暂时无法删除');
}

export async function fetchKnowledgeNotebooks(
  scope?: KnowledgeScope,
): Promise<KnowledgeNotebook[]> {
  const query = scope
    ? `?${new URLSearchParams({ scopeKind: scope.kind, scopeId: scope.id })}`
    : '';
  const payload = await readJson<{ items: KnowledgeNotebook[] } | KnowledgeNotebook[]>(
    await fetch(`/api/v1/knowledge/notebooks${query}`),
    '知识库暂时无法读取',
  );
  return Array.isArray(payload) ? payload : payload.items;
}

export async function createKnowledgeNotebook(
  input: CreateKnowledgeNotebookRequest,
): Promise<KnowledgeNotebook> {
  return readJson(
    await fetch('/api/v1/knowledge/notebooks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    }),
    '知识库暂时无法创建',
  );
}

export async function fetchKnowledgeDocuments(
  notebookId?: string,
  scope?: KnowledgeScope,
): Promise<KnowledgeDocument[]> {
  const params = new URLSearchParams();
  if (notebookId) params.set('notebookId', notebookId);
  if (scope) {
    params.set('scopeKind', scope.kind);
    params.set('scopeId', scope.id);
  }
  const query = params.size ? `?${params}` : '';
  const payload = await readJson<{ items: KnowledgeDocument[] } | KnowledgeDocument[]>(
    await fetch(`/api/v1/knowledge/documents${query}`),
    '知识文档暂时无法读取',
  );
  return Array.isArray(payload) ? payload : payload.items;
}

export async function upsertKnowledgeDocument(
  input: UpsertKnowledgeDocumentRequest & { scope?: KnowledgeScope },
): Promise<KnowledgeDocument> {
  return readJson(
    await fetch('/api/v1/knowledge/documents', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    }),
    '知识文档暂时无法保存',
  );
}
export async function importKnowledgeUrls(
  input: ImportKnowledgeUrlsRequest,
): Promise<ImportKnowledgeUrlsResponse> {
  const response = await fetch('/api/v1/knowledge/documents/import-url', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  // 全部失败时 API 返回 400/502，但 body 里仍有逐条结果，优先透出逐条反馈。
  const payload = (await response.json().catch(() => null)) as ImportKnowledgeUrlsResponse | null;
  if (!payload || !Array.isArray(payload.results)) {
    if (!response.ok) throw new Error('无法导入网页链接，请稍后重试。');
    throw new Error('导入结果格式异常');
  }
  return payload;
}

export async function updateKnowledgeDocument(
  id: string,
  input: { expectedVersion: number; content: string; title?: string; scope?: KnowledgeScope },
): Promise<KnowledgeDocument> {
  return readJson(
    await fetch(`/api/v1/knowledge/documents/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    }),
    '知识文档暂时无法更新',
  );
}
export async function deleteKnowledgeDocument(id: string, scope?: KnowledgeScope): Promise<void> {
  const query = scope
    ? `?${new URLSearchParams({ scopeKind: scope.kind, scopeId: scope.id })}`
    : '';
  const response = await fetch(`/api/v1/knowledge/documents/${encodeURIComponent(id)}${query}`, {
    method: 'DELETE',
  });
  if (!response.ok && response.status !== 404) throw new Error('知识文档暂时无法删除');
}
export async function rebuildKnowledge(input: {
  notebookId?: string;
  documentId?: string;
  force?: boolean;
}): Promise<number> {
  return (
    await readJson<{ indexedChunks: number }>(
      await fetch('/api/v1/knowledge/rebuild', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      }),
      '知识索引暂时无法重建',
    )
  ).indexedChunks;
}
export async function fetchKnowledgeAudits(
  notebookId?: string,
): Promise<Array<Record<string, unknown>>> {
  const query = notebookId ? `?${new URLSearchParams({ notebookId })}` : '';
  return (
    await readJson<{ items: Array<Record<string, unknown>> }>(
      await fetch(`/api/v1/knowledge/audits${query}`),
      '知识审计暂时无法读取',
    )
  ).items;
}
export async function deleteKnowledgeBinding(binding: KnowledgeBinding): Promise<void> {
  const query = new URLSearchParams({ scopeKind: binding.scope.kind, scopeId: binding.scope.id });
  const response = await fetch(
    `/api/v1/knowledge/bindings/${encodeURIComponent(binding.notebookId)}?${query}`,
    { method: 'DELETE' },
  );
  if (!response.ok && response.status !== 404) throw new Error('知识库绑定暂时无法解除');
}

export async function createKnowledgeBinding(
  binding: Omit<KnowledgeBinding, 'createdAt'>,
): Promise<KnowledgeBinding> {
  return readJson(
    await fetch('/api/v1/knowledge/bindings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(binding),
    }),
    '知识库绑定暂时无法创建',
  );
}

export async function fetchKnowledgeBindings(): Promise<KnowledgeBinding[]> {
  const payload = await readJson<{ items: KnowledgeBinding[] } | KnowledgeBinding[]>(
    await fetch('/api/v1/knowledge/bindings'),
    '知识库绑定暂时无法读取',
  );
  return Array.isArray(payload) ? payload : payload.items;
}

export async function searchKnowledge(
  input: KnowledgeSearchRequest,
): Promise<KnowledgeSearchResponse> {
  return readJson(
    await fetch('/api/v1/knowledge/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    }),
    '知识检索暂时无法完成',
  );
}

export async function fetchMemories(scope: MemoryScope): Promise<MemoryDocument[]> {
  const query = new URLSearchParams({ scopeType: scope.type, scopeId: scope.id });
  return (
    await readJson<{ items: MemoryDocument[] }>(
      await fetch(`/api/v1/memories?${query}`),
      '记忆暂时无法读取',
    )
  ).items;
}
export async function createMemory(input: {
  scope: MemoryScope;
  source: string;
  title: string;
  content: string;
}): Promise<MemoryDocument> {
  return readJson(
    await fetch('/api/v1/memories', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    }),
    '记忆暂时无法创建',
  );
}
export async function updateMemory(
  id: string,
  input: {
    expectedVersion: number;
    scope?: MemoryScope;
    source?: string;
    title?: string;
    content?: string;
  },
): Promise<MemoryDocument> {
  return readJson(
    await fetch(`/api/v1/memories/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    }),
    '记忆暂时无法保存',
  );
}
export async function fetchMemoryHistory(
  id: string,
): Promise<{ versions: MemoryVersion[]; snapshots: MemorySnapshot[] }> {
  const [versions, snapshots] = await Promise.all([
    readJson<{ items: MemoryVersion[] }>(
      await fetch(`/api/v1/memories/${encodeURIComponent(id)}/versions`),
      '版本暂时无法读取',
    ),
    readJson<{ items: MemorySnapshot[] }>(
      await fetch(`/api/v1/memories/${encodeURIComponent(id)}/snapshots`),
      '快照暂时无法读取',
    ),
  ]);
  return { versions: versions.items, snapshots: snapshots.items };
}
export async function createMemorySnapshot(id: string): Promise<MemorySnapshot> {
  return readJson(
    await fetch(`/api/v1/memories/${encodeURIComponent(id)}/snapshots`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }),
    '快照暂时无法创建',
  );
}
export async function fetchMemoryTimeline(scope: MemoryScope): Promise<MemoryTimelineEntry[]> {
  const query = new URLSearchParams({ scopeType: scope.type, scopeId: scope.id });
  return (
    await readJson<{ items: MemoryTimelineEntry[] }>(
      await fetch(`/api/v1/memory/timeline?${query}`),
      '时间线暂时无法读取',
    )
  ).items;
}
export async function runMemoryMaintenance(scope: MemoryScope): Promise<MemoryMaintenanceReport> {
  return readJson(
    await fetch('/api/v1/memory/maintenance/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scope }),
    }),
    '记忆维护暂时无法执行',
  );
}
export async function fetchMemoryDiff(from: string, to: string): Promise<string> {
  const query = new URLSearchParams({ from, to });
  return (
    await readJson<{ diff: string }>(
      await fetch(`/api/v1/memory/diff?${query}`),
      '差异暂时无法读取',
    )
  ).diff;
}
export async function rollbackMemory(input: {
  snapshotId: string;
  expectedVersion: number;
  scope: MemoryScope;
  apply: boolean;
}): Promise<unknown> {
  return readJson(
    await fetch('/api/v1/memory/rollback', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    }),
    '回滚暂时无法完成',
  );
}
export async function exportMemory(
  format: 'json' | 'markdown',
  scope: MemoryScope,
  documentId?: string,
): Promise<string> {
  const query = new URLSearchParams({ format, scopeType: scope.type, scopeId: scope.id });
  if (documentId) query.set('documentId', documentId);
  return (
    await readJson<{ content: string }>(
      await fetch(`/api/v1/memory/export?${query}`),
      '记忆暂时无法导出',
    )
  ).content;
}
export async function importMemory(input: {
  format: 'json' | 'markdown';
  content: string;
  scope?: MemoryScope;
  source?: string;
  title?: string;
}): Promise<MemoryDocument[]> {
  return (
    await readJson<{ items: MemoryDocument[] }>(
      await fetch('/api/v1/memory/import', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      }),
      '记忆暂时无法导入',
    )
  ).items;
}

export async function automationAction(
  id: string,
  action: 'pause' | 'resume' | 'rotate-trigger-key',
  wakerId: string,
): Promise<WakerAutomation> {
  return readJson(
    await fetch(`/api/v1/automations/${encodeURIComponent(id)}/${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ wakerId }),
    }),
    '自动任务状态暂时无法更新',
  );
}
export async function fetchAutomationRuns(
  wakerId: string,
  automationId?: string,
  limit = 50,
  signal?: AbortSignal,
): Promise<{ items: AutomationRunRecord[]; total: number }> {
  const query = new URLSearchParams({ wakerId });
  if (automationId) query.set('automationId', automationId);
  query.set('limit', String(limit));
  return readJson(
    await fetch(`/api/v1/automation-runs?${query}`, { signal }),
    '运行历史暂时无法读取',
  );
}
export async function automationRunAction(
  runId: string,
  action: 'cancel' | 'retry',
  wakerId: string,
): Promise<AutomationRunRecord> {
  return readJson(
    await fetch(`/api/v1/automation-runs/${encodeURIComponent(runId)}/${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ wakerId }),
    }),
    '运行状态暂时无法更新',
  );
}
export async function fetchSessionOutputs(
  agentId: string,
  sessionId: string,
): Promise<SessionOutputsResponse> {
  return readJson(
    await fetch(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/outputs?${new URLSearchParams({ agentId })}`,
    ),
    '附件与结果暂时无法读取',
  );
}
export async function uploadSessionAttachment(
  agentId: string,
  sessionId: string,
  file: File,
): Promise<SessionAttachment> {
  const dataBase64 = await readFileBase64(file);
  return readJson(
    await fetch(`/api/v1/sessions/${encodeURIComponent(sessionId)}/attachments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agentId,
        originalName: file.name,
        mimeType: file.type || 'application/octet-stream',
        dataBase64,
      }),
    }),
    '附件暂时无法上传',
  );
}
export function sessionAttachmentUrl(
  agentId: string,
  sessionId: string,
  attachmentId: string,
): string {
  return `/api/v1/sessions/${encodeURIComponent(sessionId)}/attachments/${encodeURIComponent(attachmentId)}?${new URLSearchParams({ agentId })}`;
}
export async function fetchSessionAttachmentBlob(
  agentId: string,
  sessionId: string,
  attachmentId: string,
  signal?: AbortSignal,
): Promise<Blob> {
  const response = await fetch(sessionAttachmentUrl(agentId, sessionId, attachmentId), { signal });
  if (!response.ok) {
    await readJson<never>(response, '附件预览暂时无法读取');
  }
  return response.blob();
}
export async function deleteSessionAttachment(
  agentId: string,
  sessionId: string,
  attachmentId: string,
): Promise<void> {
  const response = await fetch(sessionAttachmentUrl(agentId, sessionId, attachmentId), {
    method: 'DELETE',
  });
  if (!response.ok) await readJson<never>(response, '附件暂时无法删除');
}
export async function createSessionArtifact(
  agentId: string,
  sessionId: string,
  attachmentId: string,
  title: string,
): Promise<SessionArtifact> {
  return readJson(
    await fetch(`/api/v1/sessions/${encodeURIComponent(sessionId)}/artifacts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentId, attachmentId, title, kind: 'attachment' }),
    }),
    '结果暂时无法登记',
  );
}
export async function createSessionFileChange(
  agentId: string,
  sessionId: string,
  input: Pick<SessionFileChange, 'path' | 'kind' | 'summary'>,
): Promise<SessionFileChange> {
  return readJson(
    await fetch(`/api/v1/sessions/${encodeURIComponent(sessionId)}/file-changes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentId, ...input }),
    }),
    '文件变更暂时无法登记',
  );
}

export async function fetchConnectors(wakerId: string): Promise<WakerConnector[]> {
  return (
    await readJson<{ items: WakerConnector[] }>(
      await fetch(`/api/v1/connectors?${new URLSearchParams({ wakerId })}`),
      '连接器暂时无法读取',
    )
  ).items;
}
export async function createConnector(input: {
  wakerId: string;
  name: string;
  transport: 'stdio' | 'http';
  command?: string;
  url?: string;
}): Promise<WakerConnector> {
  return readJson(
    await fetch('/api/v1/connectors', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    }),
    '连接器暂时无法创建',
  );
}
export async function connectorAction(
  id: string,
  action: 'enable' | 'disable',
  wakerId: string,
): Promise<WakerConnector> {
  return readJson(
    await fetch(`/api/v1/connectors/${encodeURIComponent(id)}/${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ wakerId }),
    }),
    '连接器状态暂时无法更新',
  );
}
export async function deleteConnector(id: string, wakerId: string): Promise<void> {
  const response = await fetch(
    `/api/v1/connectors/${encodeURIComponent(id)}?${new URLSearchParams({ wakerId })}`,
    { method: 'DELETE' },
  );
  if (!response.ok && response.status !== 404) throw new Error('连接器暂时无法删除');
}
export type PermissionEnvelope = {
  host: Omit<WakerPermissionPolicy, 'wakerId' | 'updatedAt'>;
  policy: WakerPermissionPolicy | null;
  enforcedBy: 'codex-host';
};
export async function fetchPermissions(wakerId: string): Promise<PermissionEnvelope> {
  return readJson(
    await fetch(`/api/v1/permissions/${encodeURIComponent(wakerId)}`),
    '权限策略暂时无法读取',
  );
}
export async function updatePermissions(
  wakerId: string,
  policy: Omit<WakerPermissionPolicy, 'wakerId' | 'updatedAt'>,
): Promise<WakerPermissionPolicy> {
  return readJson(
    await fetch(`/api/v1/permissions/${encodeURIComponent(wakerId)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(policy),
    }),
    '权限策略暂时无法保存',
  );
}
export async function fetchHumanActions(
  wakerId: string,
  status: HumanActionRecord['status'] = 'pending',
): Promise<HumanActionRecord[]> {
  const query = new URLSearchParams({ wakerId, status });
  return (
    await readJson<{ items: HumanActionRecord[] }>(
      await fetch(`/api/v1/human-actions?${query}`),
      '人工操作暂时无法读取',
    )
  ).items;
}
export async function fetchAgent(agentId: string): Promise<AgentDetail> {
  return readJson(
    await fetch(`/api/v1/agents/${encodeURIComponent(agentId)}`),
    'Agent 详情暂时无法读取',
  );
}

export async function fetchAgentResources(agentId: string): Promise<AgentResources> {
  return readJson(
    await fetch(`/api/v1/agents/${encodeURIComponent(agentId)}/resources`),
    'Agent 资源信息暂时无法读取',
  );
}

export async function fetchSessions(agentId: string): Promise<SessionSummary[]> {
  const payload = await readJson<SessionListResponse>(
    await fetch(`/api/v1/agents/${encodeURIComponent(agentId)}/sessions`),
    '会话列表暂时无法读取',
  );
  return payload.items;
}

/** Replays the persisted messages of one session (the JSONL file is the source of truth). */
export async function fetchSessionMessages(
  agentId: string,
  sessionId: string,
): Promise<SessionMessage[]> {
  const payload = await readJson<SessionMessagesResponse>(
    await fetch(
      `/api/v1/agents/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(sessionId)}/messages`,
    ),
    '历史消息暂时无法读取',
  );
  return payload.items;
}

export async function fetchSessionContext(
  agentId: string,
  sessionId: string,
): Promise<SessionContextRecord> {
  const query = new URLSearchParams({ agentId });
  return readJson(
    await fetch(`/api/v1/sessions/${encodeURIComponent(sessionId)}/context?${query}`),
    '会话项目上下文暂时无法读取',
  );
}

export async function fetchInbox(tab: InboxTab = 'attention', q?: string): Promise<InboxResponse> {
  const params = new URLSearchParams({ tab });
  if (q) params.set('q', q);
  return readJson(await fetch(`/api/v1/inbox?${params.toString()}`), '收件箱暂时无法读取');
}

/** Marks every unread attention session as read; resolves with the number updated. */
export async function markAllInboxRead(): Promise<InboxReadAllResponse> {
  return readJson(await fetch('/api/v1/inbox/read-all', { method: 'POST' }), '全部标为已读失败');
}

/** PATCHes one session's inbox read/completed state; resolves with the latest InboxItem. */
export async function updateInboxState(
  agentId: string,
  sessionId: string,
  patch: UpdateInboxStateRequest,
): Promise<InboxItem> {
  return readJson(
    await fetch(
      `/api/v1/agents/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(sessionId)}/inbox`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      },
    ),
    '收件箱状态暂时无法保存',
  );
}

export async function renameSession(
  agentId: string,
  sessionId: string,
  title: string,
): Promise<SessionSummary> {
  return readJson(
    await fetch(
      `/api/v1/agents/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(sessionId)}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title }),
      },
    ),
    '会话名称暂时无法保存',
  );
}

export async function deleteSession(agentId: string, sessionId: string): Promise<void> {
  const response = await fetch(
    `/api/v1/agents/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(sessionId)}`,
    { method: 'DELETE' },
  );
  if (!response.ok && response.status !== 404) throw new Error('会话暂时无法删除');
}

export async function fetchPrompt(name: string): Promise<PromptDocument> {
  return readJson(await fetch(`/api/v1/prompts/${encodeURIComponent(name)}`), '提示词暂时无法读取');
}

/** PUTs one prompt template rewrite; server errors (400/404) surface their message. */
export async function updatePrompt(
  name: string,
  request: UpdatePromptRequest,
): Promise<PromptDocument> {
  return readJson(
    await fetch(`/api/v1/prompts/${encodeURIComponent(name)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    }),
    '提示词暂时无法保存',
  );
}

export async function fetchAppendSystem(): Promise<AppendSystemResponse> {
  return readJson(await fetch('/api/v1/append-system'), '追加系统提示暂时无法读取');
}

/** PUTs .codex/APPEND_SYSTEM.md; empty content removes the file and the response content is null. */
export async function updateAppendSystem(content: string): Promise<AppendSystemResponse> {
  return readJson(
    await fetch('/api/v1/append-system', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content }),
    }),
    '追加系统提示暂时无法保存',
  );
}

export async function fetchSkills(): Promise<SkillSummary[]> {
  const payload = await readJson<SkillListResponse>(
    await fetch('/api/v1/skills'),
    '技能列表暂时无法读取',
  );
  return payload.items;
}

export async function fetchInstalledSkills(): Promise<InstalledSkillListResponse> {
  return readJson(await fetch('/api/v1/skills/installed'), '已安装技能暂时无法读取');
}

/** 读取一个已安装技能的完整 SKILL.md（正文去 frontmatter）。 */
export async function fetchInstalledSkillContent(
  scope: 'codex' | 'agents',
  name: string,
  locator?: string,
): Promise<InstalledSkillContent> {
  const params = new URLSearchParams({ scope, name });
  if (locator) params.set('locator', locator);
  return readJson(
    await fetch(`/api/v1/skills/installed/content?${params.toString()}`),
    '技能内容暂时无法读取',
  );
}

/** skills.sh 详情页解析结果（og:description + 安装量），服务端有 1h 缓存。 */
export async function fetchLibrarySkillDetail(
  source: string,
  skillId: string,
): Promise<LibrarySkillDetail> {
  const params = new URLSearchParams({ source, skillId });
  return readJson(
    await fetch(`/api/v1/skills/library/detail?${params.toString()}`),
    '技能详情暂时无法读取',
  );
}

/** query ≥2 字符走搜索模式，否则返回 skills.sh 榜单。 */
export async function fetchSkillLibrary(query = '', limit = 50): Promise<SkillLibraryResponse> {
  const params = new URLSearchParams();
  if (query) params.set('query', query);
  params.set('limit', String(limit));
  return readJson(await fetch(`/api/v1/skills/library?${params.toString()}`), '技能库暂时无法读取');
}

/** 安装成功/失败后都返回最新的已安装列表；失败抛出服务端消息。 */
export async function installSkill(
  request: SkillInstallRequest,
): Promise<InstalledSkillListResponse> {
  return readJson(
    await fetch('/api/v1/skills/install', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    }),
    '技能暂时无法安装',
  );
}

export async function removeSkill(
  request: SkillRemoveRequest,
): Promise<InstalledSkillListResponse> {
  return readJson(
    await fetch('/api/v1/skills/remove', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    }),
    '技能暂时无法删除',
  );
}

/** 手工上传一个 SKILL.md 到 .codex/skills/<name>/；409（重名）等服务端消息原样抛出。 */
export async function uploadSkill(request: UploadSkillRequest): Promise<InstalledSkillSummary> {
  return readJson(
    await fetch('/api/v1/skills/upload', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    }),
    '技能暂时无法上传',
  );
}

export async function fetchAgentTemplates(): Promise<AgentTemplate[]> {
  const payload = await readJson<AgentTemplatesResponse>(
    await fetch('/api/v1/templates'),
    '模板列表暂时无法读取',
  );
  return payload.items;
}

/** 新建 Waker 对话框的角色库：.codex/agent-templates/ 下的文件即模板。 */
export async function fetchAgentRoleTemplates(): Promise<AgentTemplate[]> {
  const payload = await readJson<AgentTemplatesResponse>(
    await fetch('/api/v1/agent-templates'),
    '角色模板暂时无法读取',
  );
  return payload.items;
}

/** Agent 头像地址（无头像时服务端返回 404，调用方按 hasAvatar 决定是否渲染）。 */
export function agentAvatarUrl(agentId: string): string {
  return `/api/v1/agents/${encodeURIComponent(agentId)}/avatar`;
}

/** PUTs the agent avatar (PNG/JPG ≤2MB); server errors (400/413) surface their message. */
export async function uploadAgentAvatar(agentId: string, file: File): Promise<AgentDetail> {
  const dataBase64 = await readFileBase64(file);
  return readJson(
    await fetch(agentAvatarUrl(agentId), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mimeType: file.type, dataBase64 }),
    }),
    '头像暂时无法上传',
  );
}

export async function fetchUsage(): Promise<UsageResponse> {
  return readJson(await fetch('/api/v1/usage'), '用量数据暂时无法读取');
}

/** 列出仓库内一个目录的内容（目录排前）；path 为空串表示仓库根。 */
export async function fetchFiles(path = ''): Promise<FileListResponse> {
  const params = new URLSearchParams();
  if (path) params.set('path', path);
  const query = params.toString();
  return readJson(await fetch(`/api/v1/files${query ? `?${query}` : ''}`), '文件列表暂时无法读取');
}

/** 读取一个文本文件的内容（上限 256KB，超出时 truncated 为 true）。 */
export async function fetchFileContent(path: string): Promise<FileContentResponse> {
  const params = new URLSearchParams({ path });
  return readJson(
    await fetch(`/api/v1/files/content?${params.toString()}`),
    '文件内容暂时无法读取',
  );
}

export async function fetchSettings(): Promise<SettingsResponse> {
  return readJson(await fetch('/api/v1/settings'), '设置信息暂时无法读取');
}

export async function fetchPreferences(): Promise<Record<string, unknown>> {
  const payload = await readJson<PreferencesResponse>(
    await fetch('/api/v1/preferences'),
    '偏好设置暂时无法读取',
  );
  return payload.items;
}

/** Fire-and-forget preference write-through; the local cache stays authoritative on failure. */
export async function savePreference(key: string, value: unknown): Promise<void> {
  const response = await fetch('/api/v1/preferences', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key, value }),
  });
  if (!response.ok) throw new Error('偏好暂时无法保存');
}

/** Creates .codex/agents/<id>.md via the API; server errors (400/409) surface their message. */
export async function createAgent(request: CreateAgentRequest): Promise<AgentDetail> {
  return readJson(
    await fetch('/api/v1/agents', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    }),
    'Agent 暂时无法创建',
  );
}

/** Imports a complete .codex/agents-compatible Markdown definition. */
export async function importAgentDefinition(request: ImportAgentRequest): Promise<AgentDetail> {
  return readJson(
    await fetch('/api/v1/agents/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    }),
    'Agent 定义暂时无法导入',
  );
}

/** Deletes the definition and its bound sessions. */
export async function deleteAgent(agentId: string): Promise<void> {
  const response = await fetch(`/api/v1/agents/${encodeURIComponent(agentId)}`, {
    method: 'DELETE',
  });
  if (!response.ok && response.status !== 404) throw new Error('Agent 暂时无法删除');
}

export async function fetchAgentDeleteImpact(agentId: string): Promise<AgentDeleteImpact> {
  return readJson(
    await fetch(`/api/v1/agents/${encodeURIComponent(agentId)}/delete-impact`),
    'Waker 删除影响暂时无法读取',
  );
}

/** Waker Home 的真实统计：入职时间、资源计数与按日活跃度。 */
export async function fetchAgentHome(agentId: string): Promise<AgentHomeResponse> {
  return readJson(
    await fetch(`/api/v1/agents/${encodeURIComponent(agentId)}/home`),
    'Waker 主页数据暂时无法读取',
  );
}

/** PATCHes one agent definition file; server errors (400/404) surface their message. */
export async function updateAgent(
  agentId: string,
  request: UpdateAgentRequest,
): Promise<AgentDetail> {
  return readJson(
    await fetch(`/api/v1/agents/${encodeURIComponent(agentId)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    }),
    'Agent 暂时无法保存',
  );
}

/** 画像派生：apply=true 时服务端把派生的 strengths/workStyles 回写进定义文件。 */
export async function summarizeAgentProfile(
  agentId: string,
  request: SummarizeAgentProfileRequest = {},
): Promise<SummarizeAgentProfileResponse> {
  return readJson(
    await fetch(`/api/v1/agents/${encodeURIComponent(agentId)}/summarize-profile`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    }),
    '画像派生暂时不可用',
  );
}

/** SSE error 帧抛出的失败：携带服务端错误分类，useChatController 据此渲染分类红卡。 */
export class ChatStreamError extends Error {
  constructor(
    message: string,
    readonly kind?: ChatErrorKind,
    readonly resetAt?: string,
  ) {
    super(message);
    this.name = 'ChatStreamError';
  }
}

/** POSTs a chat turn and streams typed events to `onEvent`; resolves with the final `done` event. */
export async function streamChat(
  request: ChatRequest & { thinking?: AgentThinkingLevel },
  onEvent: (event: ChatStreamEvent) => void,
  signal?: AbortSignal,
): Promise<ChatStreamEvent & { type: 'done' }> {
  const response = await fetch('/api/v1/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
    signal,
  });
  if (!response.ok) await readJson(response, '发送消息失败');
  if (!response.body) throw new Error('服务没有返回可读流');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let final: (ChatStreamEvent & { type: 'done' }) | undefined;
  let failure: Error | undefined;

  const dispatch = (data: string, event: string) => {
    const parsed = decodeStreamEvent({ event, data });
    onEvent(parsed);
    if (parsed.type === 'done') final = parsed;
    if (parsed.type === 'error')
      failure = new ChatStreamError(parsed.error, parsed.kind, parsed.resetAt);
  };

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const { blocks, rest } = extractSseBlocks(buffer);
    buffer = rest;
    for (const block of blocks) dispatch(block.data, block.event);
    if (done) break;
  }
  for (const block of flushSseBlocks(buffer)) dispatch(block.data, block.event);

  if (failure) throw failure;
  if (!final) throw new Error('响应流在完成事件前结束');
  return final;
}
