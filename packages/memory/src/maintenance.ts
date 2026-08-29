import { MemoryError, type MemoryDocument, type MemoryScope, type MemoryStore } from './store.js';

/** 维护触发方式：cron = 每日周期作业（对齐旧版 trigger='cron'），manual = 手动端点。 */
export type MemoryMaintenanceTrigger = 'cron' | 'manual';

export interface MemoryMaintenanceAction {
  documentId: string;
  title: string;
  action: 'deleted' | 'skipped';
  reason: string;
  /** 删除前留下的检查点快照 id（可用 store.rollback 恢复）。 */
  snapshotId?: string;
}

export interface MemoryMaintenanceReport {
  scope: MemoryScope;
  trigger: MemoryMaintenanceTrigger;
  startedAt: string;
  finishedAt: string;
  checked: number;
  deleted: number;
  snapshotted: number;
  skipped: number;
  actions: MemoryMaintenanceAction[];
}

export interface MemoryMaintenanceOptions {
  scope: MemoryScope;
  trigger?: MemoryMaintenanceTrigger;
  /** 超过该天数未更新且创建后从未修订的 memory 视为陈旧并归档（软删除）。默认 90 天。 */
  staleAfterDays?: number;
  now?: () => Date;
}

export const DEFAULT_MEMORY_STALE_AFTER_DAYS = 90;
/** 删除前的检查点快照 operation；与手动快照区分，时间线/快照列表里可溯源。 */
export const MEMORY_MAINTENANCE_SNAPSHOT_OPERATION = 'maintenance';

const DAY_MS = 24 * 60 * 60 * 1000;

function normalizeTitle(title: string): string {
  return title.trim().toLowerCase();
}

/**
 * 记忆每日维护（复刻旧版 QoderWake MemoryDailyMaintenance 的本地语义，trigger='cron'）：
 * 只执行确定性的真实动作，全部通过 MemoryStore 正式 API，产生真实的版本/快照/时间线记录。
 * - 空内容 memory 清理（防御性：canonicalizeMarkdown 正常不允许空内容）。
 * - 同 scope 同 title 的重复文档压实：保留最新一条，其余先打检查点快照再软删除（版本历史保留，可回滚）。
 * - 陈旧 memory 归档：超过 staleAfterDays 未更新、且创建后从未修订（updatedAt === createdAt，
 *   本地没有引用计数，以此为「从未被触达」代理）的文档，快照后软删除。
 * 不调用模型；需要模型润色的步骤（如摘要）不在此实现，dream 链路已覆盖提取。
 */
export function runMemoryMaintenance(
  store: MemoryStore,
  options: MemoryMaintenanceOptions,
): MemoryMaintenanceReport {
  const scope = options.scope;
  const trigger = options.trigger ?? 'manual';
  const now = options.now ?? (() => new Date());
  const staleAfterDays = options.staleAfterDays ?? DEFAULT_MEMORY_STALE_AFTER_DAYS;
  if (!Number.isInteger(staleAfterDays) || staleAfterDays < 1) {
    throw new MemoryError('INVALID_INPUT', 'staleAfterDays must be a positive integer');
  }
  const startedAt = now().toISOString();
  const staleBeforeMs = now().getTime() - staleAfterDays * DAY_MS;

  const documents = store.list({ scope });

  // 同 title 重复文档：保留最新（updatedAt 新 → version 高 → id 字典序大），其余标记为待压实。
  const duplicateIds = new Map<string, string>(); // loserId -> keeperId
  const byTitle = new Map<string, MemoryDocument[]>();
  for (const document of documents) {
    const key = normalizeTitle(document.title);
    const group = byTitle.get(key) ?? [];
    group.push(document);
    byTitle.set(key, group);
  }
  for (const group of byTitle.values()) {
    if (group.length < 2) continue;
    const sorted = [...group].sort(
      (left, right) =>
        right.updatedAt.localeCompare(left.updatedAt) ||
        right.version - left.version ||
        right.id.localeCompare(left.id),
    );
    const keeper = sorted[0]!;
    for (const loser of sorted.slice(1)) duplicateIds.set(loser.id, keeper.id);
  }

  const actions: MemoryMaintenanceAction[] = [];
  let snapshotted = 0;

  const remove = (document: MemoryDocument, reason: string): void => {
    // 删除前打检查点快照：版本历史完整保留，之后可以 rollback 恢复。
    const snapshot = store.snapshot(document.id, MEMORY_MAINTENANCE_SNAPSHOT_OPERATION);
    snapshotted += 1;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const expectedVersion =
        attempt === 0 ? document.version : store.get(document.id, scope).version;
      try {
        store.delete(document.id, { expectedVersion, scope });
        actions.push({
          documentId: document.id,
          title: document.title,
          action: 'deleted',
          reason,
          snapshotId: snapshot.id,
        });
        return;
      } catch (error) {
        if (error instanceof MemoryError && error.code === 'VERSION_CONFLICT' && attempt === 0)
          continue;
        throw error;
      }
    }
  };

  for (const document of documents) {
    if (!document.content.trim()) {
      remove(document, '内容为空，清理');
      continue;
    }
    const keeperId = duplicateIds.get(document.id);
    if (keeperId) {
      remove(document, `与 ${keeperId} 标题重复，压实保留最新版本`);
      continue;
    }
    const stale =
      document.updatedAt === document.createdAt &&
      Date.parse(document.updatedAt) <= staleBeforeMs;
    if (stale) {
      remove(document, `超过 ${staleAfterDays} 天未更新且从未修订，归档`);
      continue;
    }
    actions.push({
      documentId: document.id,
      title: document.title,
      action: 'skipped',
      reason: '健康，无需处理',
    });
  }

  const deleted = actions.filter((entry) => entry.action === 'deleted').length;
  return {
    scope,
    trigger,
    startedAt,
    finishedAt: now().toISOString(),
    checked: documents.length,
    deleted,
    snapshotted,
    skipped: actions.length - deleted,
    actions,
  };
}
