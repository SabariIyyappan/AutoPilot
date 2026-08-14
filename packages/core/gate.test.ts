import { test } from 'node:test';
import assert from 'node:assert/strict';
import { passGate } from './gate.ts';
import { isPermitted, type RecoveryContract, type RecoveryProposal } from './types.ts';

function proposal(overrides: Partial<RecoveryProposal> = {}): RecoveryProposal {
  return {
    action: 'retry',
    nodeId: 'n1',
    expectedCostUsd: 0.01,
    expectedLatencyMs: 100,
    expectedTokens: 10,
    risk: 'LOW',
    successPrior: 0.8,
    rewrite: { targetNodeId: 'n1', description: 'retry' },
    ...overrides,
  };
}

test('gate: IRREVERSIBLE_WRITE is rejected, not executed', () => {
  const contracts = new Map<string, RecoveryContract>([
    ['payment.capture', { nodeId: 'payment.capture', sideEffect: 'IRREVERSIBLE_WRITE', retryable: false }],
  ]);
  const { permitted, rejections } = passGate(
    [proposal({ nodeId: 'payment.capture' })],
    contracts,
  );
  assert.equal(permitted.length, 0, 'zero attempts must be permitted for an irreversible write');
  assert.equal(rejections.length, 1);
  assert.match(rejections[0]!.reason, /blocked/i);
});

test('gate: node with no declared contract defaults to unsafe (fail closed)', () => {
  const { permitted, rejections } = passGate([proposal({ nodeId: 'undeclared_node' })], new Map());
  assert.equal(permitted.length, 0);
  assert.equal(rejections.length, 1);
});

test('gate: NONE side effect is permitted and correctly branded', () => {
  const contracts = new Map<string, RecoveryContract>([
    ['search_docs', { nodeId: 'search_docs', sideEffect: 'NONE', retryable: true }],
  ]);
  const { permitted, rejections } = passGate([proposal({ nodeId: 'search_docs' })], contracts);
  assert.equal(rejections.length, 0);
  assert.equal(permitted.length, 1);
  assert.ok(isPermitted(permitted[0]!), 'permitted proposal must carry the gate brand');
});

test('gate: escalate is always permitted regardless of contract', () => {
  const contracts = new Map<string, RecoveryContract>([
    ['payment.capture', { nodeId: 'payment.capture', sideEffect: 'IRREVERSIBLE_WRITE', retryable: false }],
  ]);
  const { permitted, rejections } = passGate(
    [proposal({ nodeId: 'payment.capture', action: 'escalate' })],
    contracts,
  );
  assert.equal(permitted.length, 1);
  assert.equal(rejections.length, 0);
});

test('gate: IDEMPOTENT_WRITE and REVERSIBLE_WRITE are permitted', () => {
  const contracts = new Map<string, RecoveryContract>([
    ['a', { nodeId: 'a', sideEffect: 'IDEMPOTENT_WRITE', retryable: true }],
    ['b', { nodeId: 'b', sideEffect: 'REVERSIBLE_WRITE', retryable: true }],
  ]);
  const { permitted, rejections } = passGate(
    [proposal({ nodeId: 'a' }), proposal({ nodeId: 'b' })],
    contracts,
  );
  assert.equal(permitted.length, 2);
  assert.equal(rejections.length, 0);
});

test('a hand-forged object cannot pass isPermitted without the real symbol', () => {
  const forged = {
    ...proposal(),
    gateReason: 'I claim to be permitted',
  };
  assert.equal(isPermitted(forged as unknown as RecoveryProposal), false);
});
