import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IllegalTransitionError, initialState, run, step } from './machine.ts';
import { passGate } from './gate.ts';
import type { RecoveryBudget, RecoveryContract, RecoveryProposal } from './types.ts';

const budget: RecoveryBudget = {
  remainingCostUsd: 0.1,
  remainingLatencyMs: 5000,
  remainingTokens: 12000,
  remainingAttempts: 3,
  maxRisk: 'MEDIUM',
};

function proposal(overrides: Partial<RecoveryProposal> = {}): RecoveryProposal {
  return {
    action: 'output_repair',
    nodeId: 'reason',
    expectedCostUsd: 0.002,
    expectedLatencyMs: 240,
    expectedTokens: 100,
    risk: 'LOW',
    successPrior: 0.9,
    rewrite: { targetNodeId: 'reason', description: 'repair' },
    ...overrides,
  };
}

/**
 * Gate-approve a proposal for the machine tests. Defaults to a `NONE`
 * side-effect contract for the proposal's node so "happy path" tests exercise
 * the machine, not the gate (the gate has its own dedicated tests in
 * gate.test.ts, including the fail-closed default this helper opts out of).
 */
function permitted(p: RecoveryProposal, contracts?: ReadonlyMap<string, RecoveryContract>) {
  const withDefault =
    contracts ??
    new Map<string, RecoveryContract>([[p.nodeId, { nodeId: p.nodeId, sideEffect: 'NONE', retryable: true }]]);
  const { permitted } = passGate([p], withDefault);
  return permitted;
}

test('happy path: FAILURE_DETECTED -> ... -> RECOVERED requires a passing verifier', () => {
  const s0 = initialState('run-1', budget);
  const [s1] = run(s0, [
    { kind: 'FAILURE_DETECTED', signal: { detected: true, type: 'VALIDATION_ERROR', nodeId: 'reason', evidence: [] } },
    { kind: 'DIAGNOSED', failureClass: 'SCHEMA_MISMATCH' },
    { kind: 'PROPOSALS_READY', proposals: permitted(proposal()) },
    { kind: 'RECOVERY_EXECUTED', ok: true, costUsd: 0.002, latencyMs: 240, tokens: 100 },
    { kind: 'VERIFIED', result: { passed: true, verifier: 'schema', detail: 'ok' } },
  ]);
  assert.equal(s1.phase, 'RECOVERED');
  assert.equal(s1.outcome?.kind, 'RECOVERED');
});

test('INVARIANT 1: failed verification cannot become RECOVERED — it escalates when the queue is empty', () => {
  const s0 = initialState('run-2', budget);
  const [s1] = run(s0, [
    { kind: 'FAILURE_DETECTED', signal: { detected: true, type: 'VALIDATION_ERROR', nodeId: 'reason', evidence: [] } },
    { kind: 'DIAGNOSED', failureClass: 'SCHEMA_MISMATCH' },
    { kind: 'PROPOSALS_READY', proposals: permitted(proposal()) },
    { kind: 'RECOVERY_EXECUTED', ok: true, costUsd: 0.002, latencyMs: 240, tokens: 100 },
    { kind: 'VERIFIED', result: { passed: false, verifier: 'schema', detail: 'still invalid' } },
  ]);
  assert.notEqual(s1.phase, 'RECOVERED');
  assert.equal(s1.phase, 'ESCALATED');
});

test('INVARIANT 1 (exhaustive): no reachable sequence of real inputs ends in RECOVERED without a VERIFIED{passed:true}', () => {
  // Every input kind that could conceivably precede RECOVERED, tried without
  // ever sending a passing VERIFIED. None may reach RECOVERED.
  const attempts: Array<Parameters<typeof run>[1]> = [
    [
      { kind: 'FAILURE_DETECTED', signal: { detected: true, type: 'RUNTIME_ERROR', nodeId: 'x', evidence: [] } },
      { kind: 'DIAGNOSED', failureClass: 'PROVIDER_TRANSIENT' },
      { kind: 'PROPOSALS_READY', proposals: permitted(proposal({ action: 'retry' })) },
      { kind: 'RECOVERY_EXECUTED', ok: true, costUsd: 0.001, latencyMs: 50, tokens: 5 },
      // no VERIFIED at all — must not spontaneously become RECOVERED
    ],
    [
      { kind: 'FAILURE_DETECTED', signal: { detected: true, type: 'RUNTIME_ERROR', nodeId: 'x', evidence: [] } },
      { kind: 'DIAGNOSED', failureClass: 'UNKNOWN' }, // escalates immediately
    ],
  ];
  for (const inputs of attempts) {
    const [s] = run(initialState('run-inv1', budget), inputs);
    assert.notEqual(s.phase, 'RECOVERED');
  }
});

test('budget is consumed on every attempt, success or failure', () => {
  const s0 = initialState('run-3', budget);
  const [s1] = run(s0, [
    { kind: 'FAILURE_DETECTED', signal: { detected: true, type: 'RUNTIME_ERROR', nodeId: 'x', evidence: [] } },
    { kind: 'DIAGNOSED', failureClass: 'PROVIDER_TRANSIENT' },
    { kind: 'PROPOSALS_READY', proposals: permitted(proposal({ action: 'retry', nodeId: 'x' })) },
    { kind: 'RECOVERY_EXECUTED', ok: false, costUsd: 0.005, latencyMs: 300, tokens: 40 },
  ]);
  assert.equal(s1.budget.remainingCostUsd, budget.remainingCostUsd - 0.005);
  assert.equal(s1.budget.remainingAttempts, budget.remainingAttempts - 1);
});

test('exhausting the queue escalates rather than looping forever', () => {
  const s0 = initialState('run-4', budget);
  const [s1] = run(s0, [
    { kind: 'FAILURE_DETECTED', signal: { detected: true, type: 'RUNTIME_ERROR', nodeId: 'x', evidence: [] } },
    { kind: 'DIAGNOSED', failureClass: 'PROVIDER_TRANSIENT' },
    { kind: 'PROPOSALS_READY', proposals: permitted(proposal({ action: 'retry', nodeId: 'x' })) },
    { kind: 'RECOVERY_EXECUTED', ok: false, costUsd: 0.001, latencyMs: 10, tokens: 1 },
  ]);
  assert.equal(s1.phase, 'ESCALATED');
});

test('no candidates at all escalates directly from DIAGNOSING', () => {
  const s0 = initialState('run-5', budget);
  const [s1] = run(s0, [
    { kind: 'FAILURE_DETECTED', signal: { detected: true, type: 'RUNTIME_ERROR', nodeId: 'x', evidence: [] } },
    { kind: 'DIAGNOSED', failureClass: 'TOOL_UNAVAILABLE' },
    { kind: 'NO_RECOVERY_AVAILABLE', reason: 'no capability substitute registered' },
  ]);
  assert.equal(s1.phase, 'ESCALATED');
  assert.match(s1.outcome?.reason ?? '', /no capability substitute/);
});

test('illegal transitions throw rather than silently ignoring', () => {
  const s0 = initialState('run-6', budget);
  assert.throws(
    () => step(s0, { kind: 'VERIFIED', result: { passed: true, verifier: 'x', detail: '' } }),
    IllegalTransitionError,
  );
});

test('the machine never advances once terminal (RECOVERED)', () => {
  const s0 = initialState('run-7', budget);
  const [s1] = run(s0, [
    { kind: 'FAILURE_DETECTED', signal: { detected: true, type: 'VALIDATION_ERROR', nodeId: 'reason', evidence: [] } },
    { kind: 'DIAGNOSED', failureClass: 'SCHEMA_MISMATCH' },
    { kind: 'PROPOSALS_READY', proposals: permitted(proposal()) },
    { kind: 'RECOVERY_EXECUTED', ok: true, costUsd: 0.002, latencyMs: 240, tokens: 100 },
    { kind: 'VERIFIED', result: { passed: true, verifier: 'schema', detail: 'ok' } },
  ]);
  assert.equal(s1.phase, 'RECOVERED');
  assert.throws(() => step(s1, { kind: 'FAILURE_DETECTED', signal: { detected: true, type: 'RUNTIME_ERROR', nodeId: 'y', evidence: [] } }));
});

test('a proposal that never passed the gate is rejected by the machine at runtime (defence in depth)', () => {
  const s0 = initialState('run-8', budget);
  const [s1] = step(s0, {
    kind: 'FAILURE_DETECTED',
    signal: { detected: true, type: 'RUNTIME_ERROR', nodeId: 'x', evidence: [] },
  });
  const [s2] = step(s1, { kind: 'DIAGNOSED', failureClass: 'PROVIDER_TRANSIENT' });
  const forged = { ...proposal(), gateReason: 'forged, not really gated' };
  assert.throws(() =>
    step(s2, { kind: 'PROPOSALS_READY', proposals: [forged as never] }),
  );
});

test('multiple candidates: a failed verification tries the next candidate before escalating', () => {
  const s0 = initialState('run-9', budget);
  const contracts = new Map<string, RecoveryContract>([['x', { nodeId: 'x', sideEffect: 'NONE', retryable: true }]]);
  const proposals = permitted(proposal({ action: 'retry', nodeId: 'x' }), contracts).concat(
    permitted(proposal({ action: 'provider_fallback', nodeId: 'x' }), contracts),
  );
  const [s1] = run(s0, [
    { kind: 'FAILURE_DETECTED', signal: { detected: true, type: 'RUNTIME_ERROR', nodeId: 'x', evidence: [] } },
    { kind: 'DIAGNOSED', failureClass: 'PROVIDER_TRANSIENT' },
    { kind: 'PROPOSALS_READY', proposals },
    { kind: 'RECOVERY_EXECUTED', ok: true, costUsd: 0.001, latencyMs: 10, tokens: 1 },
    { kind: 'VERIFIED', result: { passed: false, verifier: 'x', detail: 'nope' } },
  ]);
  // Second candidate should now be `current`, machine still RECOVERING (not yet escalated).
  assert.equal(s1.phase, 'RECOVERING');
  assert.equal(s1.current?.action, 'provider_fallback');
});
