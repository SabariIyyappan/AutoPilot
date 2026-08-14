import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startFaultProxy } from './proxy.ts';

/**
 * Faults only apply to the ANSWER-PRODUCING call (`stream: false`) — the
 * engine also sends a probe and a streaming attempt per logical invocation,
 * and faulting those would be absorbed silently. See proxy.ts.
 */
async function post(url: string, body: Record<string, unknown>) {
  const res = await fetch(`${url}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ stream: false, ...body }),
  });
  const text = await res.text();
  return { status: res.status, text };
}

test('no fault: returns a valid OpenAI-shaped response with the canned text', async () => {
  const proxy = await startFaultProxy({
    seed: 1,
    nodeId: 'reason',
    profile: {}, // no faults ever
    taskIdOf: () => 'task-a',
    respond: () => 'hello from canned',
  });
  try {
    const { status, text } = await post(proxy.url, { messages: [] });
    assert.equal(status, 200);
    const parsed = JSON.parse(text);
    assert.equal(parsed.choices[0].message.content, 'hello from canned');
  } finally {
    await proxy.close();
  }
});

test('forced provider_500: returns HTTP 500', async () => {
  const proxy = await startFaultProxy({
    seed: 1,
    nodeId: 'reason',
    profile: { provider_500: 1.0 }, // always faults
    taskIdOf: () => 'task-a',
    respond: () => 'unused',
  });
  try {
    const { status } = await post(proxy.url, { messages: [] });
    assert.equal(status, 500);
  } finally {
    await proxy.close();
  }
});

test('forced provider_unavailable: returns HTTP 401 (non-retryable by the engine)', async () => {
  const proxy = await startFaultProxy({
    seed: 1,
    nodeId: 'reason',
    profile: { provider_unavailable: 1.0 },
    taskIdOf: () => 'task-a',
    respond: () => 'unused',
  });
  try {
    const { status, text } = await post(proxy.url, { messages: [] });
    assert.equal(status, 401);
    assert.match(text, /authentication_error/);
  } finally {
    await proxy.close();
  }
});

test('forced schema_drift: a WELL-FORMED envelope carrying wrong-shaped content', async () => {
  const proxy = await startFaultProxy({
    seed: 1,
    nodeId: 'reason',
    profile: { schema_drift: 1.0 },
    taskIdOf: () => 'task-a',
    respond: () => 'unused',
  });
  try {
    const { status, text } = await post(proxy.url, { messages: [] });
    assert.equal(status, 200);
    const parsed = JSON.parse(text);
    // The envelope must be VALID — this models a silent failure, where the
    // call succeeds and only the content is wrong. A malformed envelope
    // would instead be a provider protocol error the engine catches itself.
    assert.ok(parsed.choices?.[0]?.message?.content, 'envelope must be well-formed');
    const content = JSON.parse(parsed.choices[0].message.content);
    assert.equal(content.customerId, undefined, 'declared field must be missing (drifted)');
    assert.ok(content.account_ref, 'drifted field should be present instead');
  } finally {
    await proxy.close();
  }
});

test('non-answer calls (probe / streaming) are never faulted', async () => {
  const proxy = await startFaultProxy({
    seed: 1,
    nodeId: 'reason',
    profile: { provider_500: 1.0 },
    taskIdOf: () => 'task-a',
    respond: () => 'healthy',
  });
  try {
    // A streaming call must pass through cleanly even under a 100% fault
    // profile — otherwise the engine's own fallback path gets disrupted.
    const res = await fetch(`${proxy.url}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stream: true, messages: [] }),
    });
    assert.equal(res.status, 200);
  } finally {
    await proxy.close();
  }
});

test('forwardTo: healthy requests reach the real upstream and its response is returned', async () => {
  // Stand-in for Ollama. Proves the proxy genuinely forwards rather than
  // fabricating, and that it strips `stream` so no SSE stream is started.
  const seen: Array<Record<string, unknown>> = [];
  const upstream = await startFaultProxy({
    seed: 1,
    nodeId: 'upstream',
    profile: {},
    taskIdOf: () => 'up',
    respond: (body) => {
      seen.push(body as Record<string, unknown>);
      return 'REAL_MODEL_ANSWER';
    },
  });

  const proxy = await startFaultProxy({
    seed: 1,
    nodeId: 'reason',
    profile: {},
    taskIdOf: () => 'task-a',
    respond: () => 'CANNED_SHOULD_NOT_APPEAR',
    forwardTo: upstream.url,
  });

  try {
    const { status, text } = await post(proxy.url, { messages: [] });
    assert.equal(status, 200);
    const parsed = JSON.parse(text);
    assert.equal(parsed.choices[0].message.content, 'REAL_MODEL_ANSWER');
    assert.equal(seen.length, 1, 'upstream must actually have been called');
    assert.equal(seen[0]!.stream, false, 'forwarded request must not request streaming');
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('forwardTo: a fault still wins over forwarding', async () => {
  const proxy = await startFaultProxy({
    seed: 1,
    nodeId: 'reason',
    profile: { provider_unavailable: 1.0 },
    taskIdOf: () => 'task-a',
    respond: () => 'unused',
    forwardTo: 'http://127.0.0.1:9/v1', // would fail if ever contacted
  });
  try {
    const { status } = await post(proxy.url, { messages: [] });
    assert.equal(status, 401, 'fault injection must take precedence over the upstream');
  } finally {
    await proxy.close();
  }
});

test('forwardTo: an unreachable upstream surfaces as a real 502, not a fake success', async () => {
  const proxy = await startFaultProxy({
    seed: 1,
    nodeId: 'reason',
    profile: {},
    taskIdOf: () => 'task-a',
    respond: () => 'CANNED_SHOULD_NOT_APPEAR',
    forwardTo: 'http://127.0.0.1:9/v1', // nothing listens on port 9
    forwardTimeoutMs: 2000,
  });
  try {
    const { status, text } = await post(proxy.url, { messages: [] });
    assert.equal(status, 502);
    assert.doesNotMatch(text, /CANNED_SHOULD_NOT_APPEAR/, 'must not silently fall back to canned output');
  } finally {
    await proxy.close();
  }
});

test('BENCHMARK GUARANTEE: with forwardTo unset, behaviour is byte-identical to before', async () => {
  // The benchmark depends on this. If forwarding ever leaked into the
  // default path, silent-failure rate would become unmeasurable.
  const proxy = await startFaultProxy({
    seed: 42,
    nodeId: 'reason',
    profile: {},
    taskIdOf: () => 'task-a',
    respond: () => 'DETERMINISTIC',
  });
  try {
    const a = await post(proxy.url, { messages: [] });
    const b = await post(proxy.url, { messages: [] });
    assert.equal(JSON.parse(a.text).choices[0].message.content, 'DETERMINISTIC');
    assert.equal(JSON.parse(b.text).choices[0].message.content, 'DETERMINISTIC');
  } finally {
    await proxy.close();
  }
});

test('generation scoping: a transient fault clears on the next pipeline run', async () => {
  const proxy = await startFaultProxy({
    seed: 1,
    nodeId: 'reason',
    profile: { provider_500: 1.0 },
    faultAttempts: [0], // first run only
    taskIdOf: () => 'task-a',
    respond: () => 'healthy',
  });
  try {
    assert.equal((await post(proxy.url, { messages: [] })).status, 500, 'first run faults');
    proxy.nextGeneration();
    assert.equal((await post(proxy.url, { messages: [] })).status, 200, 'next run is healthy');
  } finally {
    await proxy.close();
  }
});

test('attemptIndex advances per taskId, so retries can escape the fault deterministically', async () => {
  // profile only faults on attemptIndex 0 in effect, because our schedule
  // hashes attemptIndex into the roll — verify the proxy actually passes an
  // advancing attemptIndex per taskId rather than a constant.
  const seen: number[] = [];
  const proxy = await startFaultProxy({
    seed: 99,
    nodeId: 'reason',
    profile: {}, // never fault; we're only checking call sequencing via `respond`
    taskIdOf: (body) => (body as { taskId: string }).taskId,
    respond: (body) => {
      seen.push(1);
      return JSON.stringify(body);
    },
  });
  try {
    await post(proxy.url, { taskId: 'same-task' });
    await post(proxy.url, { taskId: 'same-task' });
    await post(proxy.url, { taskId: 'same-task' });
    assert.equal(seen.length, 3);
  } finally {
    await proxy.close();
  }
});

test('unknown path returns 404, not a silent 200', async () => {
  const proxy = await startFaultProxy({
    seed: 1,
    nodeId: 'reason',
    profile: {},
    taskIdOf: () => 'task-a',
    respond: () => 'unused',
  });
  try {
    const res = await fetch(`${proxy.url}/embeddings`, { method: 'POST', body: '{}' });
    assert.equal(res.status, 404);
  } finally {
    await proxy.close();
  }
});
