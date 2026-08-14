import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { budgetFromConfig, loadConfig, loadPrices } from './config.ts';
import { estimate, estimateTokens, costUsd, nextModel, nextProvider } from './estimate.ts';
import { filterByBudget, rank, score } from './budget.ts';
import { selectCandidates, type NodeContext } from './policy.ts';
import { selectRecovery } from './select.ts';
import { detect } from '../diagnosis/detector.ts';
import { diagnose } from '../diagnosis/diagnoser.ts';
import { initialState, step } from '../core/machine.ts';
import type { RecoveryBudget, RecoveryContract, RecoveryProposal } from '../core/types.ts';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const config = loadConfig(path.join(ROOT, 'autopilot.config.yaml'));
const prices = loadPrices(path.join(ROOT, 'prices.json'));

const safeContracts = new Map<string, RecoveryContract>([
  ['reason', { nodeId: 'reason', sideEffect: 'NONE', retryable: true }],
  ['crm', { nodeId: 'crm', sideEffect: 'NONE', retryable: true, capability: 'customer.lookup' }],
  [
    'payment',
    { nodeId: 'payment', sideEffect: 'IRREVERSIBLE_WRITE', retryable: false },
  ],
]);

function node(overrides: Partial<NodeContext> = {}): NodeContext {
  return {
    nodeId: 'reason',
    model: 'autopilot-canned',
    provider: 'primary',
    priorTokens: 1000,
    ...overrides,
  };
}

// ── config + prices ───────────────────────────────────────────────────────

test('the real config and prices files load and validate', () => {
  assert.ok(config.budget.attempts > 0);
  assert.ok(prices.models['autopilot-canned']);
});

test('a config missing its budget section is rejected loudly, not defaulted', () => {
  assert.throws(() => loadConfig(path.join(ROOT, 'prices.json')), /missing required "budget"/);
});

// ── estimate ──────────────────────────────────────────────────────────────

test('every dollar figure traces to prices.json', () => {
  const cost = costUsd(prices, 'autopilot-canned', 1_000_000, 0);
  assert.equal(cost, prices.models['autopilot-canned']!.inputPerMillion);
});

test('an undeclared model throws rather than silently costing zero', () => {
  assert.throws(() => costUsd(prices, 'nonexistent-model', 100, 100), /No declared price/);
});

test('token estimation from characters uses the declared ratio', () => {
  assert.equal(estimateTokens('abcdefgh', 4), 2);
});

test('model and provider ladders advance and terminate correctly', () => {
  assert.equal(nextModel(prices, 'autopilot-canned'), 'autopilot-canned-mid');
  assert.equal(nextModel(prices, 'autopilot-canned-strong'), null);
  assert.equal(nextProvider(prices, 'primary'), 'secondary');
  assert.equal(nextProvider(prices, 'secondary'), null);
});

test('output_repair is cheaper than a full retry, and escalate is free', () => {
  const ctx = { model: 'autopilot-canned', priorTokens: 1000 };
  assert.ok(estimate(prices, 'output_repair', ctx).expectedCostUsd < estimate(prices, 'retry', ctx).expectedCostUsd);
  assert.equal(estimate(prices, 'escalate', ctx).expectedCostUsd, 0);
});

test('model_escalation is priced at the HIGHER model, not the current one', () => {
  const ctx = { model: 'autopilot-canned', priorTokens: 1000 };
  const escalated = estimate(prices, 'model_escalation', ctx);
  const retried = estimate(prices, 'retry', ctx);
  assert.ok(
    escalated.expectedCostUsd > retried.expectedCostUsd,
    'escalating to a stronger model must cost more than re-running the current one',
  );
});

test('capability_swap costs no LLM tokens (it re-runs a tool, not a model)', () => {
  const est = estimate(prices, 'capability_swap', { model: 'autopilot-canned', priorTokens: 1000 });
  assert.equal(est.expectedTokens, 0);
  assert.equal(est.expectedCostUsd, 0);
});

// ── policy ────────────────────────────────────────────────────────────────

test('policy returns the configured candidates for a known failure class', () => {
  const { candidates } = selectCandidates(config, prices, 'PROVIDER_TRANSIENT', node());
  assert.deepEqual(candidates.map((c) => c.action), ['retry', 'provider_fallback']);
});

test('UNKNOWN has no configured policy, so it yields no candidates', () => {
  const { candidates } = selectCandidates(config, prices, 'UNKNOWN', node());
  assert.equal(candidates.length, 0);
});

test('capability_swap is inapplicable — with a reason — when no alternative is registered', () => {
  const { candidates, inapplicable } = selectCandidates(
    config,
    prices,
    'TOOL_UNAVAILABLE',
    node({ nodeId: 'crm', capability: 'customer.lookup', capabilityAlternatives: [] }),
  );
  assert.equal(candidates.length, 0);
  assert.match(inapplicable[0]!.reason, /no alternative implementation/);
});

test('capability_swap becomes available once an alternative is registered', () => {
  const { candidates } = selectCandidates(
    config,
    prices,
    'TOOL_UNAVAILABLE',
    node({ nodeId: 'crm', capability: 'customer.lookup', capabilityAlternatives: ['local_index'] }),
  );
  assert.deepEqual(candidates.map((c) => c.action), ['capability_swap']);
  assert.equal(candidates[0]!.rewrite.providerReplacement, 'local_index');
});

test('model_escalation is inapplicable at the top of the ladder', () => {
  const { inapplicable } = selectCandidates(
    config,
    prices,
    'PROVIDER_UNAVAILABLE',
    node({ model: 'autopilot-canned-strong', provider: 'secondary' }),
  );
  assert.ok(inapplicable.some((i) => i.action === 'model_escalation'));
});

// ── budget ────────────────────────────────────────────────────────────────

const budget: RecoveryBudget = {
  remainingCostUsd: 0.05,
  remainingLatencyMs: 4000,
  remainingTokens: 12000,
  remainingAttempts: 3,
  maxRisk: 'MEDIUM',
};

function proposal(o: Partial<RecoveryProposal> = {}): RecoveryProposal {
  return {
    action: 'retry',
    nodeId: 'reason',
    expectedCostUsd: 0.001,
    expectedLatencyMs: 500,
    expectedTokens: 100,
    risk: 'LOW',
    successPrior: 0.5,
    rewrite: { targetNodeId: 'reason', description: 'x' },
    ...o,
  };
}

test('a too-expensive strategy is rejected with a readable dollar reason', () => {
  const { affordable, rejections } = filterByBudget(
    [proposal({ action: 'model_escalation', expectedCostUsd: 0.14 })],
    budget,
  );
  assert.equal(affordable.length, 0);
  assert.match(rejections[0]!.reason, /\$0\.14 > \$0\.05 remaining cost budget/);
});

test('each budget dimension rejects independently, with its own reason', () => {
  const cases: Array<[Partial<RecoveryProposal>, RegExp]> = [
    [{ expectedLatencyMs: 9999 }, /ms > 4000ms remaining latency/],
    [{ expectedTokens: 99999 }, /tokens > 12000 remaining token budget/],
    [{ risk: 'HIGH' }, /risk HIGH exceeds permitted maximum MEDIUM/],
  ];
  for (const [patch, expected] of cases) {
    const { affordable, rejections } = filterByBudget([proposal(patch)], budget);
    assert.equal(affordable.length, 0);
    assert.match(rejections[0]!.reason, expected);
  }
});

test('zero remaining attempts rejects everything', () => {
  const { affordable, rejections } = filterByBudget(
    [proposal()],
    { ...budget, remainingAttempts: 0 },
  );
  assert.equal(affordable.length, 0);
  assert.match(rejections[0]!.reason, /attempt budget exhausted/);
});

test('ranking prefers the cheaper strategy when success priors are equal', () => {
  const cheap = proposal({ action: 'output_repair', expectedCostUsd: 0.002, successPrior: 0.8 });
  const dear = proposal({ action: 'model_escalation', expectedCostUsd: 0.04, successPrior: 0.8 });
  const ranked = rank([dear, cheap], budget, config.ranking_weights);
  assert.equal(ranked[0]!.action, 'output_repair');
});

test('ranking prefers a materially better prior even at higher cost', () => {
  const weak = proposal({ action: 'retry', expectedCostUsd: 0.001, successPrior: 0.2 });
  const strong = proposal({ action: 'provider_fallback', expectedCostUsd: 0.002, successPrior: 0.95 });
  const ranked = rank([weak, strong], budget, config.ranking_weights);
  assert.equal(ranked[0]!.action, 'provider_fallback');
});

test('ranking is deterministic for identical inputs (benchmark reproducibility)', () => {
  const ps = [proposal({ action: 'retry' }), proposal({ action: 'provider_fallback' })];
  const a = rank(ps, budget, config.ranking_weights).map((p) => p.action);
  const b = rank(ps, budget, config.ranking_weights).map((p) => p.action);
  assert.deepEqual(a, b);
});

test('score normalises against REMAINING budget, not absolute cost', () => {
  const p = proposal({ expectedCostUsd: 0.04 });
  const rich = score(p, { ...budget, remainingCostUsd: 1.0 }, config.ranking_weights);
  const poor = score(p, { ...budget, remainingCostUsd: 0.05 }, config.ranking_weights);
  assert.ok(rich > poor, 'the same strategy must score worse when little budget remains');
});

// ── select: policy -> budget -> gate composition ──────────────────────────

test('selectRecovery produces a PROPOSALS_READY input for a recoverable failure', () => {
  const { input, trace } = selectRecovery(
    config,
    prices,
    'PROVIDER_TRANSIENT',
    node(),
    budget,
    safeContracts,
  );
  assert.equal(input.kind, 'PROPOSALS_READY');
  assert.ok(trace.permitted > 0);
});

test('SCENARIO D: an IRREVERSIBLE_WRITE node yields NO permitted proposals, whatever the budget', () => {
  const hugeBudget: RecoveryBudget = {
    remainingCostUsd: 1000,
    remainingLatencyMs: 10_000_000,
    remainingTokens: 10_000_000,
    remainingAttempts: 99,
    maxRisk: 'HIGH',
  };
  const { input, trace } = selectRecovery(
    config,
    prices,
    'PROVIDER_TRANSIENT',
    node({ nodeId: 'payment' }),
    hugeBudget,
    safeContracts,
  );
  assert.equal(input.kind, 'NO_RECOVERY_AVAILABLE');
  assert.equal(trace.permitted, 0, 'zero proposals may survive the gate for an irreversible write');
  assert.match(
    (input as { reason: string }).reason,
    /blocked/i,
    'the refusal reason must state the side-effect block, not a budget excuse',
  );
});

test('SCENARIO D: a node with no declared contract also refuses (fail closed)', () => {
  const { input, trace } = selectRecovery(
    config,
    prices,
    'PROVIDER_TRANSIENT',
    node({ nodeId: 'undeclared' }),
    budget,
    safeContracts,
  );
  assert.equal(input.kind, 'NO_RECOVERY_AVAILABLE');
  assert.equal(trace.permitted, 0);
});

test('the gate runs LAST: an affordable strategy on an unsafe node is still refused', () => {
  // retry is trivially affordable here; only the gate can stop it.
  const { input } = selectRecovery(
    config,
    prices,
    'PROVIDER_TRANSIENT',
    node({ nodeId: 'payment' }),
    budget,
    safeContracts,
  );
  assert.equal(input.kind, 'NO_RECOVERY_AVAILABLE');
});

// ── full chain: detect -> diagnose -> select -> machine ───────────────────

test('END TO END: a live-captured 500 flows through detect -> diagnose -> select -> RECOVERING', () => {
  const LIVE_WARNING_500 =
    'Warning*Error 500: server_error - internal server error*D:\\path\\IGlobal.py:77';

  const signal = detect({ nodeId: 'reason', warnings: [LIVE_WARNING_500] });
  assert.equal(signal.detected, true);

  const failureClass = diagnose(signal, { isToolNode: false });
  assert.equal(failureClass, 'PROVIDER_TRANSIENT');

  const runBudget = budgetFromConfig(config);
  const { input } = selectRecovery(config, prices, failureClass, node(), runBudget, safeContracts);
  assert.equal(input.kind, 'PROPOSALS_READY');

  let state = initialState('run-e2e', runBudget);
  [state] = step(state, { kind: 'FAILURE_DETECTED', signal });
  [state] = step(state, { kind: 'DIAGNOSED', failureClass });
  [state] = step(state, input);

  assert.equal(state.phase, 'RECOVERING');
  assert.ok(state.current, 'a concrete strategy must be selected');
});

test('END TO END SCENARIO D: payment timeout escalates with ZERO attempts issued', () => {
  const signal = detect({
    nodeId: 'payment',
    warnings: ['Warning*Error 500: server_error - internal server error*x.py:1'],
  });
  const failureClass = diagnose(signal, { isToolNode: true });
  const runBudget = budgetFromConfig(config);
  const { input } = selectRecovery(
    config,
    prices,
    failureClass,
    node({ nodeId: 'payment' }),
    runBudget,
    safeContracts,
  );

  let state = initialState('run-d', runBudget);
  [state] = step(state, { kind: 'FAILURE_DETECTED', signal });
  [state] = step(state, { kind: 'DIAGNOSED', failureClass });
  [state] = step(state, input);

  assert.equal(state.phase, 'ESCALATED');
  assert.equal(state.history.length, 0, 'ZERO recovery attempts must have been issued');
  assert.equal(state.budget.remainingAttempts, runBudget.remainingAttempts, 'no attempt budget consumed');
});

test('END TO END: an UNKNOWN failure escalates rather than guessing at a recovery', () => {
  const signal = detect({ nodeId: 'reason', tokensUsed: 99999, tokenLimit: 100 });
  const failureClass = diagnose(signal);
  assert.equal(failureClass, 'UNKNOWN');

  let state = initialState('run-unknown', budgetFromConfig(config));
  [state] = step(state, { kind: 'FAILURE_DETECTED', signal });
  [state] = step(state, { kind: 'DIAGNOSED', failureClass });
  assert.equal(state.phase, 'ESCALATED');
  assert.equal(state.history.length, 0);
});
