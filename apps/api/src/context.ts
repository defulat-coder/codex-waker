import type { FastifyReply } from 'fastify';
import type { ArtifactStore } from '@waker/artifacts';
import { AgentSessionStore, getAgent, SessionBindingError } from '@waker/codex-runtime';
import type { KnowledgeStore } from '@waker/knowledge';
import type { MemoryStore } from '@waker/memory';
import type { WorkspaceStore } from '@waker/workspace-data';
import type { AppConfig } from './config.js';
import type { AutomationExecutor } from './automation-executor.js';
import type { WorkflowExecutor } from './workflow-executor.js';

const deletingAgents = new Set<string>();

export function beginAgentDeletion(agentId: string): boolean {
  if (deletingAgents.has(agentId)) return false;
  deletingAgents.add(agentId);
  return true;
}

export function endAgentDeletion(agentId: string): void {
  deletingAgents.delete(agentId);
}

export function isAgentDeleting(agentId: string): boolean {
  return deletingAgents.has(agentId);
}

export function rejectDeletingAgent(reply: FastifyReply, agentId: string): boolean {
  if (!deletingAgents.has(agentId)) return false;
  reply.code(409).send({ error: `Agent 正在删除：${agentId}` });
  return true;
}

/** Shared per-app dependencies handed to every route module. */
export interface AppContext {
  config: AppConfig;
  cwd: string;
  sessions: AgentSessionStore;
  knowledge: KnowledgeStore;
  memory: MemoryStore;
  workspaceData: WorkspaceStore;
  artifacts: ArtifactStore;
  automationExecutor: AutomationExecutor;
  workflowExecutor: WorkflowExecutor;
}

export function agentOr404(ctx: AppContext, agentId: string, reply: FastifyReply) {
  try {
    return getAgent(ctx.cwd, agentId);
  } catch {
    reply.code(404).send({ error: `Agent 不存在：${agentId}` });
    return undefined;
  }
}

/** Maps the session-binding contract onto HTTP statuses. */
export async function withOwnedSession<T>(
  reply: FastifyReply,
  run: () => Promise<T>,
): Promise<T | undefined> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof SessionBindingError) {
      if (error.code === 'AGENT_SESSION_MISMATCH') {
        reply.code(409).send({ error: '该会话属于另一个 Agent' });
        return undefined;
      }
      if (error.code === 'AGENT_SESSION_NOT_FOUND') {
        reply.code(404).send({ error: '会话不存在' });
        return undefined;
      }
    }
    throw error;
  }
}
