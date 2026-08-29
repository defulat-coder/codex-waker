#!/usr/bin/env node
// Test fixture: minimal MCP stdio server (newline-delimited JSON-RPC).
// Implements initialize + tools/list; exits on stdin close.
import readline from 'node:readline';

const tools = [
  {
    name: 'fixture_echo',
    description: 'Echo back the input text',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
  },
  { name: 'fixture_count', inputSchema: { type: 'object', properties: {} } },
];

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (!msg || typeof msg.method !== 'string' || msg.id === undefined) return;
  const respond = (result, error) =>
    process.stdout.write(
      JSON.stringify({ jsonrpc: '2.0', id: msg.id, ...(error ? { error } : { result }) }) + '\n',
    );
  if (msg.method === 'initialize') {
    respond({
      protocolVersion: msg.params?.protocolVersion ?? '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'fixture', version: '0.0.1' },
    });
  } else if (msg.method === 'tools/list') {
    respond({ tools });
  } else {
    respond(undefined, { code: -32601, message: 'method not found' });
  }
});
