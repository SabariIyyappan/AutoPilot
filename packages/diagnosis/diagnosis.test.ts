import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detect, parseEngineWarning } from './detector.ts';
import { diagnose } from './diagnoser.ts';

/**
 * These strings are VERBATIM from a live engine run captured in P2
 * (spike/smoke-proxy.mjs). Testing against real observed output rather than
 * invented shapes is the whole reason P2 ran before P3.
 */
const LIVE_WARNING_500 =
  'Warning*Error 500: server_error - internal server error*D:\\code\\rocketride\\.engine\\server\\nodes\\llm_openai_api\\IGlobal.py:77';
const LIVE_WARNING_401 =
  'Warning*Error 401: authentication_error - invalid api key*D:\\code\\rocketride\\.engine\\server\\nodes\\llm_openai_api\\IGlobal.py:77';
const LIVE_OUTPUT_500 = '**LLM error** — ValueError: An error occurred with the API.';
const LIVE_OUTPUT_401 = '**LLM error** — ValueError: Invalid API key.';
const LIVE_WARNING_BENIGN =
  'Warning*Streaming disabled for model=autopilot-smoke (ValueError): No generation chunks were returned. Falling back to non-streaming response.*D:\\code\\path.py:10';

// ── parseEngineWarning ────────────────────────────────────────────────────

test('parses the real engine warning format for a 500', () => {
  const parsed = parseEngineWarning(LIVE_WARNING_500);
  assert.deepEqual(parsed, { status: 500, kind: 'server_error', message: 'internal server error' });
});

test('parses the real engine warning format for a 401', () => {
  const parsed = parseEngineWarning(LIVE_WARNING_401);
  assert.deepEqual(parsed, { status: 401, kind: 'authentication_error', message: 'invalid api key' });
});

test('the benign streaming warning is NOT parsed as an error', () => {
  assert.equal(parseEngineWarning(LIVE_WARNING_BENIGN), null);
});

// ── detect ────────────────────────────────────────────────────────────────

test('detects a real 500 from the warnings channel', () => {
  const signal = detect({ nodeId: 'reason', warnings: [LIVE_WARNING_500] });
  assert.equal(signal.detected, true);
  assert.equal(signal.type, 'RUNTIME_ERROR');
  assert.equal(signal.evidence.find((e) => e.kind === 'http_status')?.detail, '500');
});

test('a benign warning alone does not trigger a false positive', () => {
  const signal = detect({ nodeId: 'reason', warnings: [LIVE_WARNING_BENIGN] });
  assert.equal(signal.detected, false, 'benign streaming notice must not be treated as a failure');
});

test('the real success case produces no detection', () => {
  const signal = detect({
    nodeId: 'reason',
    warnings: [LIVE_WARNING_BENIGN],
    outputText: 'AUTOPILOT_SMOKE_TEST_OK',
  });
  assert.equal(signal.detected, false);
});

test('detects via the output-text marker when warnings are unavailable (channel 2)', () => {
  const signal = detect({ nodeId: 'reason', outputText: LIVE_OUTPUT_500 });
  assert.equal(signal.detected, true);
  assert.equal(signal.type, 'RUNTIME_ERROR');
  assert.ok(signal.evidence.some((e) => e.kind === 'llm_error_marker'));
});

test('warnings channel takes priority over the output marker', () => {
  const signal = detect({
    nodeId: 'reason',
    warnings: [LIVE_WARNING_401],
    outputText: LIVE_OUTPUT_401,
  });
  // Should carry the precise HTTP status, which only the warnings channel has.
  assert.equal(signal.evidence.find((e) => e.kind === 'http_status')?.detail, '401');
});

test('detects malformed JSON output', () => {
  const signal = detect({ nodeId: 'reason', outputText: '{"broken": ' });
  assert.equal(signal.detected, true);
  assert.equal(signal.type, 'VALIDATION_ERROR');
});

test('valid JSON output is not a failure', () => {
  const signal = detect({ nodeId: 'reason', outputText: '{"ok": true}' });
  assert.equal(signal.detected, false);
});

test('plain prose output is not mistaken for malformed JSON', () => {
  const signal = detect({ nodeId: 'reason', outputText: 'The customer id is 42.' });
  assert.equal(signal.detected, false);
});

test('detects an explicit schema validation failure', () => {
  const signal = detect({ nodeId: 'reason', schemaValid: false });
  assert.equal(signal.detected, true);
  assert.equal(signal.type, 'VALIDATION_ERROR');
});

test('detects a repeated tool call as a loop', () => {
  const signal = detect({
    nodeId: 'crm',
    currentToolCall: 'lookup(42)',
    priorToolCalls: ['lookup(42)', 'lookup(42)'],
  });
  assert.equal(signal.detected, true);
  assert.equal(signal.type, 'LOOP');
});

test('two distinct tool calls are not a loop', () => {
  const signal = detect({
    nodeId: 'crm',
    currentToolCall: 'lookup(42)',
    priorToolCalls: ['lookup(1)', 'lookup(2)'],
  });
  assert.equal(signal.detected, false);
});

test('detects token budget exhaustion', () => {
  const signal = detect({ nodeId: 'reason', tokensUsed: 13000, tokenLimit: 12000 });
  assert.equal(signal.detected, true);
  assert.equal(signal.type, 'RESOURCE_EXHAUSTION');
});

// ── diagnose ──────────────────────────────────────────────────────────────

test('500 on an LLM node diagnoses as PROVIDER_TRANSIENT', () => {
  const signal = detect({ nodeId: 'reason', warnings: [LIVE_WARNING_500] });
  assert.equal(diagnose(signal, { isToolNode: false }), 'PROVIDER_TRANSIENT');
});

test('401 diagnoses as PROVIDER_UNAVAILABLE', () => {
  const signal = detect({ nodeId: 'reason', warnings: [LIVE_WARNING_401] });
  assert.equal(diagnose(signal, { isToolNode: false }), 'PROVIDER_UNAVAILABLE');
});

test('429 diagnoses as PROVIDER_TRANSIENT', () => {
  const signal = detect({
    nodeId: 'reason',
    warnings: ['Warning*Error 429: rate_limit_error - rate limit exceeded*x.py:1'],
  });
  assert.equal(diagnose(signal), 'PROVIDER_TRANSIENT');
});

test('the same 500 on a TOOL node diagnoses as TOOL_TIMEOUT, not PROVIDER_TRANSIENT', () => {
  const signal = detect({ nodeId: 'crm', warnings: [LIVE_WARNING_500] });
  assert.equal(diagnose(signal, { isToolNode: true }), 'TOOL_TIMEOUT');
});

test('404 on a tool node diagnoses as TOOL_UNAVAILABLE', () => {
  const signal = detect({
    nodeId: 'crm',
    warnings: ['Warning*Error 404: not_found - no such tool*x.py:1'],
  });
  assert.equal(diagnose(signal, { isToolNode: true }), 'TOOL_UNAVAILABLE');
});

test('malformed JSON diagnoses as SCHEMA_MISMATCH', () => {
  const signal = detect({ nodeId: 'reason', outputText: '{"broken": ' });
  assert.equal(diagnose(signal), 'SCHEMA_MISMATCH');
});

test('the LLM-error marker alone (no status) still diagnoses correctly from its text', () => {
  const signal = detect({ nodeId: 'reason', outputText: LIVE_OUTPUT_401 });
  assert.equal(diagnose(signal, { isToolNode: false }), 'PROVIDER_UNAVAILABLE');
});

test('resource exhaustion diagnoses as UNKNOWN so it escalates rather than retrying', () => {
  const signal = detect({ nodeId: 'reason', tokensUsed: 13000, tokenLimit: 12000 });
  assert.equal(
    diagnose(signal),
    'UNKNOWN',
    'spending more of an exhausted budget is the wrong move — must escalate',
  );
});

test('an undetected signal diagnoses as UNKNOWN', () => {
  assert.equal(diagnose({ detected: false, type: 'RUNTIME_ERROR', nodeId: 'x', evidence: [] }), 'UNKNOWN');
});

test('an unrecognized runtime error diagnoses as UNKNOWN rather than guessing', () => {
  const signal = detect({
    nodeId: 'reason',
    events: [
      {
        runId: 'r',
        nodeId: 'reason',
        nodeType: 'llm',
        op: 'leave',
        startedAt: 0,
        error: { message: 'something entirely novel happened' },
      },
    ],
  });
  assert.equal(diagnose(signal), 'UNKNOWN');
});
