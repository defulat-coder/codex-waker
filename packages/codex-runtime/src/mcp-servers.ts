/**
 * Connector MCP 真实连接能力：把启用的 connector 写入 Codex CLI 原生配置面
 * （$CODEX_HOME/config.toml 的 mcp_servers 表，经 `codex mcp add/remove` 合并，
 * 不手改 TOML），并用 MCP 协议直连探测 server 工具列表（CLI 没有只读的工具
 * 列举子命令——`codex mcp list/get` 只输出配置，实测 0.144/0.149 均如此）。
 * 配置面由 CLI 在线程启动时读取，enable 之后新开的 Codex 线程即注入这些工具。
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface McpServerSpec {
  /** mcp_servers 表键名；只允许安全字符（同时是 TOML 键与 CLI 参数）。 */
  name: string;
  transport: 'stdio' | 'http';
  /** stdio：完整命令行（含参数），按 shell 词法切分。 */
  command?: string;
  /** http：streamable HTTP MCP endpoint。 */
  url?: string;
}

export interface McpDiscoveredTool {
  name: string;
  description?: string;
}

const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;
const CLI_TIMEOUT_MS = 15_000;
const PROBE_TIMEOUT_MS = 10_000;

/** 解析 SDK 自带的 codex CLI 启动脚本（@openai/codex/bin/codex.js）。 */
export function resolveCodexCliScript(): string {
  // codex-sdk 的 exports 只给 import 条件且不含 ./package.json：
  // 用 import.meta.resolve 拿入口文件，再建 require 解析 @openai/codex。
  const sdkRequire = createRequire(fileURLToPath(import.meta.resolve('@openai/codex-sdk')));
  const codexPackageJson = sdkRequire.resolve('@openai/codex/package.json');
  return join(dirname(codexPackageJson), 'bin', 'codex.js');
}

function assertServerName(name: string): void {
  if (!SERVER_NAME_PATTERN.test(name)) {
    throw new Error(`MCP server 名称含非法字符：${name}`);
  }
}

/** 按 shell 词法切分命令行（支持单双引号与反斜杠转义），不经过 shell 展开。 */
export function splitCommandLine(command: string): string[] {
  const argv: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let hasToken = false;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;
    if (quote) {
      if (char === quote) {
        quote = null;
      } else if (char === '\\' && quote === '"' && index + 1 < command.length) {
        index += 1;
        current += command[index];
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      hasToken = true;
    } else if (char === '\\' && index + 1 < command.length) {
      index += 1;
      current += command[index];
      hasToken = true;
    } else if (/\s/.test(char)) {
      if (hasToken || current) {
        argv.push(current);
        current = '';
        hasToken = false;
      }
    } else {
      current += char;
    }
  }
  if (quote) throw new Error('Connector command 引号未闭合');
  if (hasToken || current) argv.push(current);
  return argv;
}

function runCodexCli(codexHome: string, args: string[]): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [resolveCodexCliScript(), ...args], {
      env: { ...process.env, CODEX_HOME: codexHome },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`codex ${args[0]} ${args[1] ?? ''} 超时`));
    }, CLI_TIMEOUT_MS);
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolvePromise();
      else reject(new Error(output.trim() || `codex mcp 退出码 ${code}`));
    });
  });
}

/**
 * 把 MCP server 写入 $CODEX_HOME/config.toml 的 mcp_servers 表。
 * `codex mcp add` 自身做 TOML 合并，同名条目覆盖、其他条目保留（已实测）。
 */
export async function registerMcpServer(codexHome: string, spec: McpServerSpec): Promise<void> {
  assertServerName(spec.name);
  if (spec.transport === 'stdio') {
    const argv = splitCommandLine(spec.command?.trim() ?? '');
    if (!argv.length) throw new Error('Connector 缺少 command');
    await runCodexCli(codexHome, ['mcp', 'add', spec.name, '--', ...argv]);
    return;
  }
  const url = spec.url?.trim() ?? '';
  if (!url) throw new Error('Connector 缺少 url');
  await runCodexCli(codexHome, ['mcp', 'add', spec.name, '--url', url]);
}

/** 从 config.toml 移除 MCP server；条目本就不存在时视为成功（幂等）。 */
export async function removeMcpServer(codexHome: string, name: string): Promise<void> {
  assertServerName(name);
  try {
    await runCodexCli(codexHome, ['mcp', 'remove', name]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/No MCP server named|not found/i.test(message)) return;
    throw error;
  }
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id?: number | string;
  result?: unknown;
  error?: { code: number; message: string };
}

function normalizeTools(result: unknown): McpDiscoveredTool[] {
  const tools = (result as { tools?: unknown } | null)?.tools;
  if (!Array.isArray(tools)) throw new Error('MCP tools/list 响应缺少 tools 数组');
  return tools
    .map((tool) => {
      const record = tool && typeof tool === 'object' ? (tool as Record<string, unknown>) : {};
      return typeof record.name === 'string' && record.name.trim()
        ? {
            name: record.name.trim(),
            ...(typeof record.description === 'string' && record.description.trim()
              ? { description: record.description.trim() }
              : {}),
          }
        : undefined;
    })
    .filter((tool): tool is McpDiscoveredTool => Boolean(tool));
}

function probeStdio(command: string, timeoutMs: number): Promise<McpDiscoveredTool[]> {
  const argv = splitCommandLine(command);
  if (!argv.length) return Promise.reject(new Error('Connector 缺少 command'));
  return new Promise((resolvePromise, reject) => {
    const child = spawn(argv[0]!, argv.slice(1), {
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let buffer = '';
    let stderr = '';
    let settled = false;
    let nextId = 0;
    const pending = new Map<
      number,
      { resolve: (result: unknown) => void; reject: (error: Error) => void }
    >();
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGKILL');
      reject(error);
    };
    const timer = setTimeout(() => fail(new Error('MCP 探测超时')), timeoutMs);
    const stdin = child.stdin;
    if (!stdin) {
      clearTimeout(timer);
      reject(new Error('MCP server stdin 不可用'));
      return;
    }
    const send = (method: string, params?: unknown): Promise<unknown> => {
      nextId += 1;
      const id = nextId;
      stdin.write(
        JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }) + '\n',
      );
      return new Promise((resolve, rejectPromise) => pending.set(id, { resolve, reject: rejectPromise }));
    };
    const notify = (method: string) => {
      stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n');
    };
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
        if (!line) continue;
        let message: JsonRpcResponse;
        try {
          message = JSON.parse(line) as JsonRpcResponse;
        } catch {
          continue;
        }
        if (message.id === undefined) continue;
        const entry = pending.get(Number(message.id));
        if (!entry) continue;
        pending.delete(Number(message.id));
        if (message.error) entry.reject(new Error(message.error.message));
        else entry.resolve(message.result);
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => fail(new Error(`MCP server 启动失败：${error.message}`)));
    child.on('close', (code) => {
      if (!settled) {
        fail(new Error(`MCP server 提前退出（${code}）${stderr.trim() ? `：${stderr.trim().slice(0, 300)}` : ''}`));
      }
    });
    send('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'waker-connector-probe', version: '1.0.0' },
    })
      .then(() => {
        notify('notifications/initialized');
        return send('tools/list');
      })
      .then((result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.kill('SIGKILL');
        try {
          resolvePromise(normalizeTools(result));
        } catch (error) {
          reject(error);
        }
      })
      .catch((error: unknown) =>
        fail(error instanceof Error ? error : new Error(String(error))),
      );
  });
}

/** 从 SSE 帧或纯 JSON 响应体里取最后一条带 id 的 JSON-RPC 响应。 */
function parseJsonRpcBody(body: string, contentType: string): JsonRpcResponse {
  if (contentType.includes('text/event-stream')) {
    const responses: JsonRpcResponse[] = [];
    for (const block of body.split(/\r?\n\r?\n/)) {
      const data = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n');
      if (!data) continue;
      try {
        responses.push(JSON.parse(data) as JsonRpcResponse);
      } catch {
        // 跳过非 JSON 事件
      }
    }
    const response = [...responses].reverse().find((message) => message.id !== undefined);
    if (!response) throw new Error('MCP HTTP 响应缺少 JSON-RPC 消息');
    return response;
  }
  return JSON.parse(body) as JsonRpcResponse;
}

async function probeHttp(url: string, timeoutMs: number): Promise<McpDiscoveredTool[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let sessionId: string | undefined;
  const post = async (payload: Record<string, unknown>): Promise<JsonRpcResponse | null> => {
    const headers: Record<string, string> = {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    };
    if (sessionId) headers['mcp-session-id'] = sessionId;
    if (payload.method !== 'initialize') headers['mcp-protocol-version'] = '2025-03-26';
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    sessionId = response.headers.get('mcp-session-id') ?? sessionId;
    if (response.status === 202) return null;
    if (!response.ok) throw new Error(`MCP HTTP ${response.status}`);
    const message = parseJsonRpcBody(
      await response.text(),
      response.headers.get('content-type') ?? '',
    );
    if (message.error) throw new Error(message.error.message);
    return message;
  };
  try {
    await post({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'waker-connector-probe', version: '1.0.0' },
      },
    });
    await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
    const result = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    return normalizeTools(result?.result);
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError')
      throw new Error('MCP 探测超时', { cause: error });
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** 探测 MCP server 的工具列表；失败抛错（超时/启动失败/协议错误统一成 Error）。 */
export function probeMcpServerTools(
  spec: Pick<McpServerSpec, 'transport' | 'command' | 'url'>,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<McpDiscoveredTool[]> {
  if (spec.transport === 'stdio') return probeStdio(spec.command?.trim() ?? '', timeoutMs);
  const url = spec.url?.trim() ?? '';
  if (!url) return Promise.reject(new Error('Connector 缺少 url'));
  return probeHttp(url, timeoutMs);
}
