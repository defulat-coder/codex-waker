import { execFile } from 'node:child_process';
import type { AutomationRun, WorkspaceStore } from '@waker/workspace-data';
import {
  GIT_POLL_DEFAULT_INTERVAL_SECONDS,
  isRemoteGitRepo,
} from '@waker/workspace-data';

/** 对齐旧版 script pull 的本地作业名。 */
export const GIT_POLL_JOB_NAME = 'waker-git-poll';

const DEFAULT_CHECK_INTERVAL_MS = 30_000;
const GIT_TIMEOUT_MS = 15_000;

export type GitExec = (args: string[], options: { timeout: number }) => Promise<string>;

const defaultExec: GitExec = (args, options) =>
  new Promise((resolve, reject) => {
    execFile('git', args, options, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr?.trim() || error.message));
      else resolve(stdout);
    });
  });

export interface GitHead {
  commit: string;
  branch: string;
}

/**
 * 取被轮询分支的头 commit。
 * - 本地路径：`git -C <path> log -1 <branch|HEAD>`。不做 fetch——fetch 会写 FETCH_HEAD、
 *   可能需要凭证，违背只读轮询语义；跟踪远端更新应把 repo 配成 URL。
 * - 远端 URL：`git ls-remote <url> <branch|HEAD>`，解析第一行的 sha。
 */
export async function resolveGitHead(
  repo: string,
  branch: string | null,
  exec: GitExec = defaultExec,
): Promise<GitHead> {
  const ref = branch ?? 'HEAD';
  if (isRemoteGitRepo(repo)) {
    const out = await exec(['ls-remote', repo, ref], { timeout: GIT_TIMEOUT_MS });
    const line = out.split('\n').find((entry) => entry.trim());
    const commit = line?.split(/\s+/)[0];
    if (!commit) throw new Error(`git ls-remote 未返回分支头：${repo} ${ref}`);
    return { commit, branch: ref };
  }
  const out = await exec(['-C', repo, 'log', '-1', '--format=%H', ref], {
    timeout: GIT_TIMEOUT_MS,
  });
  const commit = out.trim();
  if (!commit) throw new Error(`git log 未返回分支头：${repo} ${ref}`);
  const resolvedBranch =
    branch ??
    (
      await exec(['-C', repo, 'rev-parse', '--abbrev-ref', 'HEAD'], { timeout: GIT_TIMEOUT_MS })
    ).trim() ??
    'HEAD';
  return { commit, branch: resolvedBranch || 'HEAD' };
}

export interface GitPollJobOptions {
  store: WorkspaceStore;
  /** 每次 tick 时枚举的 waker id 列表（通常是当前全部 Agent id）。 */
  wakerIds: () => string[];
  /** 触发后把排队中的 run 交给执行器。 */
  enqueue: (wakerId: string, runId: string) => void;
  enabled?: boolean;
  /** 到期检查间隔，默认 30s（与 schedule 调度器同节奏）。 */
  checkIntervalMs?: number;
  exec?: GitExec;
  now?: () => number;
  logger?: { info: (message: string) => void; warn: (message: string) => void };
}

/**
 * git-poll 轮询作业：对每个 enabled 的 kind='git-poll' automation 按各自的
 * pollIntervalSeconds 检查分支头 commit，变化时经 store.claimGitPollRun 排队一次
 * trigger='git' 的运行。仓库不可达等失败只记日志（下轮重试，不做熔断），不影响其他
 * automation 与调度器。每个 automation 的到期时间保存在进程内存（首次见到立即轮询落基线）。
 */
export class GitPollJob {
  private readonly store: WorkspaceStore;
  private readonly wakerIds: () => string[];
  private readonly enqueue: (wakerId: string, runId: string) => void;
  private readonly enabled: boolean;
  private readonly checkIntervalMs: number;
  private readonly exec: GitExec;
  private readonly now: () => number;
  private readonly logger?: GitPollJobOptions['logger'];
  private readonly lastPolledAt = new Map<string, number>();
  private timer?: ReturnType<typeof setInterval>;
  private ticking = false;

  constructor(options: GitPollJobOptions) {
    this.store = options.store;
    this.wakerIds = options.wakerIds;
    this.enqueue = options.enqueue;
    this.enabled = options.enabled !== false;
    this.checkIntervalMs = options.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS;
    this.exec = options.exec ?? defaultExec;
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

  /** 执行一次轮询；返回本轮触发的 run（测试可直接 await）。 */
  async tick(): Promise<AutomationRun[]> {
    if (!this.enabled || this.ticking) return [];
    this.ticking = true;
    try {
      const now = this.now();
      const live = new Set<string>();
      const triggered: AutomationRun[] = [];
      for (const wakerId of this.wakerIds()) {
        for (const automation of this.store.listAutomations(wakerId)) {
          if (automation.kind !== 'git-poll' || !automation.enabled || !automation.repo) continue;
          live.add(automation.id);
          const intervalMs =
            (automation.pollIntervalSeconds ?? GIT_POLL_DEFAULT_INTERVAL_SECONDS) * 1_000;
          const last = this.lastPolledAt.get(automation.id);
          if (last !== undefined && now - last < intervalMs) continue;
          this.lastPolledAt.set(automation.id, now);
          try {
            const head = await resolveGitHead(automation.repo, automation.branch, this.exec);
            const run = this.store.claimGitPollRun(wakerId, automation.id, head);
            if (run) {
              this.enqueue(run.wakerId, run.id);
              triggered.push(run);
              this.logger?.info(
                `${GIT_POLL_JOB_NAME} automation=${automation.id} repo=${automation.repo} branch=${head.branch} ${automation.lastSeenCommit ?? 'baseline'} -> ${head.commit}，已排队运行 ${run.id}`,
              );
            }
          } catch (error) {
            // 失败只记日志：游标不动，下个周期重试；不影响其他 automation 与调度器。
            this.logger?.warn(
              `${GIT_POLL_JOB_NAME} automation=${automation.id} repo=${automation.repo} 轮询失败（下轮重试）：${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
      }
      // 已删除/停用的 automation 不再保留进程内轮询状态。
      for (const id of [...this.lastPolledAt.keys()]) {
        if (!live.has(id)) this.lastPolledAt.delete(id);
      }
      return triggered;
    } finally {
      this.ticking = false;
    }
  }
}
