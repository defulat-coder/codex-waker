import type { MemoryStore } from '@waker/memory';
import { runMemoryMaintenance, type MemoryMaintenanceReport } from '@waker/memory';

/** 对齐旧版 qoderwake-memory-daily-maintenance 的本地作业名。 */
export const MEMORY_MAINTENANCE_JOB_NAME = 'waker-memory-daily-maintenance';

const DEFAULT_CHECK_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_RUN_EVERY_MS = 24 * 60 * 60 * 1000;

export interface MemoryMaintenanceJobOptions {
  memory: MemoryStore;
  /** 每次检查时要维护的 waker scope id 列表（通常是当前全部 Agent id）。 */
  scopeIds: () => string[];
  enabled?: boolean;
  /** 到期检查间隔，默认 1 小时。 */
  checkIntervalMs?: number;
  /** 同一 scope 两次维护的最小间隔，默认 24 小时。 */
  runEveryMs?: number;
  now?: () => number;
  logger?: { info: (message: string) => void; warn: (message: string) => void };
}

/**
 * 每日 memory 维护周期作业（复刻旧版 MemoryDailyMaintenance 的 trigger='cron' 路径）。
 * 到期判定保存在进程内存里：首次 tick 立即执行一次（catch-up），之后每个 scope 至多
 * 每 runEveryMs 跑一次；某个 scope 失败只记日志，下一个检查周期重试，不影响其他 scope。
 */
export class MemoryMaintenanceJob {
  private readonly memory: MemoryStore;
  private readonly scopeIds: () => string[];
  private readonly enabled: boolean;
  private readonly checkIntervalMs: number;
  private readonly runEveryMs: number;
  private readonly now: () => number;
  private readonly logger?: MemoryMaintenanceJobOptions['logger'];
  private readonly lastRunAt = new Map<string, number>();
  private timer?: ReturnType<typeof setInterval>;

  constructor(options: MemoryMaintenanceJobOptions) {
    this.memory = options.memory;
    this.scopeIds = options.scopeIds;
    this.enabled = options.enabled !== false;
    this.checkIntervalMs = options.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS;
    this.runEveryMs = options.runEveryMs ?? DEFAULT_RUN_EVERY_MS;
    this.now = options.now ?? (() => Date.now());
    if (options.logger) this.logger = options.logger;
  }

  start(): void {
    if (!this.enabled || this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.checkIntervalMs);
    this.timer.unref?.();
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** 执行一次到期检查；返回本轮实际跑出的报告（测试可直接 await）。 */
  async tick(): Promise<MemoryMaintenanceReport[]> {
    if (!this.enabled) return [];
    const now = this.now();
    const reports: MemoryMaintenanceReport[] = [];
    for (const scopeId of this.scopeIds()) {
      const last = this.lastRunAt.get(scopeId) ?? 0;
      if (now - last < this.runEveryMs) continue;
      try {
        const report = runMemoryMaintenance(this.memory, {
          scope: { type: 'waker', id: scopeId },
          trigger: 'cron',
        });
        this.lastRunAt.set(scopeId, now);
        this.logger?.info(
          `${MEMORY_MAINTENANCE_JOB_NAME} scope=waker:${scopeId} checked=${report.checked} deleted=${report.deleted} skipped=${report.skipped}`,
        );
        reports.push(report);
      } catch (error) {
        // 失败不更新 lastRunAt：下个检查周期重试；只记日志，不影响其他 scope/功能。
        this.logger?.warn(
          `${MEMORY_MAINTENANCE_JOB_NAME} scope=waker:${scopeId} 失败（下周期重试）：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return reports;
  }
}
