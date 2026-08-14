import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startFaultMcpServer } from './mcp-server.ts';

async function rpc(url: string, method: string, params?: Record<string, unknown>) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return { status: res.status, body: await res.json() };
}

test('initialize returns protocol info', async () => {
  const server = await startFaultMcpServer({
    seed: 1,
    nodeId: 'crm',
    tools: [],
    call: () => ({}),
    taskIdOf: () => 't',
  });
  try {
    const { body } = await rpc(server.url, 'initialize');
    assert.equal(body.result.serverInfo.name, 'autopilot-chaos-mcp');
  } finally {
    await server.close();
  }
});

test('tools/list returns the declared tool catalog', async () => {
  const tools = [{ name: 'customer_lookup', description: 'looks up a customer', inputSchema: {} }];
  const server = await startFaultMcpServer({ seed: 1, nodeId: 'crm', tools, call: () => ({}), taskIdOf: () => 't' });
  try {
    const { body } = await rpc(server.url, 'tools/list');
    assert.deepEqual(body.result.tools, tools);
  } finally {
    await server.close();
  }
});

test('tools/call with no fault returns the canned deterministic result', async () => {
  const server = await startFaultMcpServer({
    seed: 1,
    nodeId: 'crm',
    profile: {},
    tools: [],
    call: (name, args) => ({ echoed: name, args }),
    taskIdOf: () => 'task-a',
  });
  try {
    const { body } = await rpc(server.url, 'tools/call', { name: 'lookup', arguments: { id: 42 } });
    const text = JSON.parse(body.result.content[0].text);
    assert.deepEqual(text, { echoed: 'lookup', args: { id: 42 } });
  } finally {
    await server.close();
  }
});

test('forced tool_unavailable: JSON-RPC error, not a hang', async () => {
  const server = await startFaultMcpServer({
    seed: 1,
    nodeId: 'crm',
    profile: { tool_unavailable: 1.0 },
    tools: [],
    call: () => ({}),
    taskIdOf: () => 'task-a',
  });
  try {
    const { body } = await rpc(server.url, 'tools/call', { name: 'lookup', arguments: {} });
    assert.ok(body.error);
    assert.match(body.error.message, /unavailable/);
  } finally {
    await server.close();
  }
});

test('forced mcp_timeout: response genuinely does not arrive within a short window', async () => {
  const server = await startFaultMcpServer({
    seed: 1,
    nodeId: 'crm',
    profile: { mcp_timeout: 1.0 },
    tools: [],
    call: () => ({}),
    taskIdOf: () => 'task-a',
    timeoutHangMs: 300,
  });
  try {
    const controller = new AbortController();
    const clientTimeout = setTimeout(() => controller.abort(), 50);
    await assert.rejects(
      fetch(server.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'x', arguments: {} } }),
        signal: controller.signal,
      }),
    );
    clearTimeout(clientTimeout);
  } finally {
    await server.close();
  }
});

test('attemptIndex advances per taskId across repeated tool calls', async () => {
  let calls = 0;
  const server = await startFaultMcpServer({
    seed: 1,
    nodeId: 'crm',
    profile: {},
    tools: [],
    call: () => {
      calls++;
      return { ok: true };
    },
    taskIdOf: (args) => (args as { taskId: string }).taskId,
  });
  try {
    await rpc(server.url, 'tools/call', { name: 'x', arguments: { taskId: 'same' } });
    await rpc(server.url, 'tools/call', { name: 'x', arguments: { taskId: 'same' } });
    assert.equal(calls, 2);
  } finally {
    await server.close();
  }
});

test('unknown method returns a JSON-RPC method-not-found error', async () => {
  const server = await startFaultMcpServer({ seed: 1, nodeId: 'crm', tools: [], call: () => ({}), taskIdOf: () => 't' });
  try {
    const { body } = await rpc(server.url, 'nonexistent/method');
    assert.equal(body.error.code, -32601);
  } finally {
    await server.close();
  }
});
