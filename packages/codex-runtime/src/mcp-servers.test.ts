import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import {
  probeMcpServerTools,
  registerMcpServer,
  removeMcpServer,
  splitCommandLine,
} from './mcp-servers.js';

const fixtureServer = fileURLToPath(
  new URL('../test/fixtures/dummy-mcp-server.mjs', import.meta.url),
);

const roots: string[] = [];
const servers: Server[] = [];

function tempHome(): string {
  const root = mkdtempSync(join(tmpdir(), 'waker-mcp-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  for (const server of servers.splice(0)) server.close();
});

describe('splitCommandLine', () => {
  it('splits plain and quoted arguments', () => {
    assert.deepEqual(splitCommandLine('node server.mjs'), ['node', 'server.mjs']);
    assert.deepEqual(splitCommandLine('npx -y @scope/mcp-server --arg "a b"'), [
      'npx',
      '-y',
      '@scope/mcp-server',
      '--arg',
      'a b',
    ]);
    assert.deepEqual(splitCommandLine("run 'x y' z"), ['run', 'x y', 'z']);
    assert.deepEqual(splitCommandLine(''), []);
  });

  it('rejects unbalanced quotes', () => {
    assert.throws(() => splitCommandLine('run "unclosed'), /引号未闭合/);
  });
});

describe('probeMcpServerTools (stdio)', () => {
  it('discovers tools from a real stdio MCP server', async () => {
    const tools = await probeMcpServerTools({
      transport: 'stdio',
      command: `${process.execPath} ${fixtureServer}`,
    });
    assert.deepEqual(tools, [
      { name: 'fixture_echo', description: 'Echo back the input text' },
      { name: 'fixture_count' },
    ]);
  });

  it('rejects when the command cannot start', async () => {
    await assert.rejects(
      probeMcpServerTools(
        { transport: 'stdio', command: 'definitely-not-a-real-command-xyz' },
        3000,
      ),
      /启动失败/,
    );
  });

  it('rejects on a server that never answers', async () => {
    await assert.rejects(
      probeMcpServerTools(
        { transport: 'stdio', command: `${process.execPath} -e "setInterval(()=>{},1000)"` },
        500,
      ),
      /超时/,
    );
  });
});

describe('probeMcpServerTools (http)', () => {
  it('discovers tools over streamable HTTP JSON responses', async () => {
    const server = createServer((request, response) => {
      let body = '';
      request.on('data', (chunk) => (body += chunk));
      request.on('end', () => {
        const message = JSON.parse(body) as { id?: number; method?: string };
        response.setHeader('content-type', 'application/json');
        if (message.method === 'initialize') {
          response.setHeader('mcp-session-id', 'session-1');
          response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} }));
        } else if (message.method === 'tools/list') {
          response.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: message.id,
              result: { tools: [{ name: 'http_tool', description: 'HTTP tool' }] },
            }),
          );
        } else {
          response.statusCode = 202;
          response.end();
        }
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const tools = await probeMcpServerTools({
      transport: 'http',
      url: `http://127.0.0.1:${port}/mcp`,
    });
    assert.deepEqual(tools, [{ name: 'http_tool', description: 'HTTP tool' }]);
  });

  it('rejects on unreachable endpoints', async () => {
    await assert.rejects(
      probeMcpServerTools({ transport: 'http', url: 'http://127.0.0.1:1/mcp' }, 2000),
    );
  });
});

describe('registerMcpServer / removeMcpServer', () => {
  it('merges into config.toml and removes only its own entry', async () => {
    const home = tempHome();
    await registerMcpServer(home, {
      name: 'waker_alpha',
      transport: 'stdio',
      command: `${process.execPath} ${fixtureServer}`,
    });
    await registerMcpServer(home, {
      name: 'waker_beta',
      transport: 'http',
      url: 'https://example.com/mcp',
    });
    let toml = readFileSync(join(home, 'config.toml'), 'utf8');
    assert.match(toml, /\[mcp_servers\.waker_alpha\]/);
    assert.match(toml, /\[mcp_servers\.waker_beta\]/);

    await removeMcpServer(home, 'waker_alpha');
    toml = readFileSync(join(home, 'config.toml'), 'utf8');
    assert.doesNotMatch(toml, /waker_alpha/);
    assert.match(toml, /\[mcp_servers\.waker_beta\]/);

    // Removing a missing entry is idempotent.
    await removeMcpServer(home, 'waker_alpha');
  });

  it('rejects unsafe server names', async () => {
    const home = tempHome();
    await assert.rejects(
      registerMcpServer(home, { name: 'bad name!', transport: 'stdio', command: 'x' }),
      /非法字符/,
    );
  });
});
