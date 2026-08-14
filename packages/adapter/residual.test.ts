import { test } from 'node:test';
import assert from 'node:assert/strict';
import { synthesizeResidual, SynthesisError, outputKey } from './residual.ts';
import { harvestOutputs, normalizeFlowFrame, extractText } from './normalize.ts';
import { applyRewrite } from './rewrites.ts';
import { clonePipeline, findComponent, type PipelineConfig } from './pipeline.ts';
import type { ExecutionEvent } from '../core/types.ts';

/** The demo pipeline shape: in -> ask -> reason -> out */
const demo: PipelineConfig = {
  version: 1,
  source: 'in',
  components: [
    { id: 'in', provider: 'webhook', config: {} },
    { id: 'ask', provider: 'prompt', config: { instructions: ['Answer.'] }, input: [{ lane: 'text', from: 'in' }] },
    {
      id: 'reason',
      provider: 'llm_openai_api',
      config: { profile: 'custom', custom: { model: 'autopilot-canned', base_url: 'http://a', apikey: 'k' } },
      input: [{ lane: 'questions', from: 'ask' }],
    },
    { id: 'out', provider: 'response_answers', config: {}, input: [{ lane: 'answers', from: 'reason' }] },
  ],
};

// ── residual set / skipping ───────────────────────────────────────────────

test('failure at reason: keeps reason + downstream, and does NOT re-run expensive upstream', () => {
  const r = synthesizeResidual({
    original: demo,
    failedNodeId: 'reason',
    outputs: {},
    rewrite: { targetNodeId: 'reason', description: 'retry' },
  });
  const ids = r.pipeline.components.map((c) => c.id).sort();
  // ask/in are free transforms so they are replayed rather than cached.
  assert.deepEqual(ids, ['ask', 'in', 'out', 'reason']);
  assert.ok(r.replayedFree.includes('ask'), 'a free prompt node is replayed, not cached');
});

test('free upstream replay is cheaper than caching, and leaves no frontier to splice', () => {
  const r = synthesizeResidual({
    original: demo,
    failedNodeId: 'reason',
    outputs: {},
    rewrite: { targetNodeId: 'reason', description: 'retry' },
  });
  assert.equal(r.spliced.length, 0, 'no cached value needed when upstream is free to recompute');
});

test('an EXPENSIVE upstream producer is skipped and its cached value spliced in', () => {
  // retrieve is an llm node (not free), feeding a prompt node we can splice into.
  const withRetrieve: PipelineConfig = {
    version: 1,
    source: 'in',
    components: [
      { id: 'in', provider: 'webhook', config: {} },
      { id: 'retrieve', provider: 'llm_openai_api', config: {}, input: [{ lane: 'text', from: 'in' }] },
      {
        id: 'ask',
        provider: 'prompt',
        config: { instructions: ['Answer.'] },
        input: [{ lane: 'text', from: 'retrieve' }],
      },
      { id: 'reason', provider: 'llm_openai_api', config: {}, input: [{ lane: 'questions', from: 'ask' }] },
    ],
  };

  const r = synthesizeResidual({
    original: withRetrieve,
    failedNodeId: 'reason',
    outputs: { [outputKey('retrieve', 'text')]: 'CACHED_RETRIEVAL_RESULT' },
    rewrite: { targetNodeId: 'reason', description: 'retry' },
  });

  assert.ok(r.skipped.includes('retrieve'), 'the expensive node must NOT be re-run');
  assert.equal(r.spliced.length, 1);
  const ask = findComponent(r.pipeline, 'ask')!;
  assert.ok(
    (ask.config.instructions as string[]).includes('CACHED_RETRIEVAL_RESULT'),
    'the cached value must actually reach the consumer',
  );
  assert.equal(
    (ask.input ?? []).some((i) => i.from === 'retrieve'),
    false,
    'the dangling edge to the skipped node must be removed',
  );
});

test('missing cached output throws rather than running with missing context', () => {
  const withRetrieve: PipelineConfig = {
    version: 1,
    source: 'in',
    components: [
      { id: 'in', provider: 'webhook', config: {} },
      { id: 'retrieve', provider: 'llm_openai_api', config: {}, input: [{ lane: 'text', from: 'in' }] },
      { id: 'ask', provider: 'prompt', config: {}, input: [{ lane: 'text', from: 'retrieve' }] },
      { id: 'reason', provider: 'llm_openai_api', config: {}, input: [{ lane: 'questions', from: 'ask' }] },
    ],
  };
  assert.throws(
    () =>
      synthesizeResidual({
        original: withRetrieve,
        failedNodeId: 'reason',
        outputs: {}, // nothing cached
        rewrite: { targetNodeId: 'reason', description: 'retry' },
      }),
    SynthesisError,
  );
});

test('an unspliceable consumer refuses rather than guessing (same principle as the gate)', () => {
  const bad: PipelineConfig = {
    version: 1,
    source: 'in',
    components: [
      { id: 'in', provider: 'webhook', config: {} },
      { id: 'retrieve', provider: 'llm_openai_api', config: {}, input: [{ lane: 'text', from: 'in' }] },
      // consumer is an llm node — no supported literal slot
      { id: 'reason', provider: 'llm_openai_api', config: {}, input: [{ lane: 'text', from: 'retrieve' }] },
    ],
  };
  assert.throws(
    () =>
      synthesizeResidual({
        original: bad,
        failedNodeId: 'reason',
        outputs: { [outputKey('retrieve', 'text')]: 'x' },
        rewrite: { targetNodeId: 'reason', description: 'retry' },
      }),
    /no supported literal slot/,
  );
});

test('the residual pipeline always has a valid source the engine can schedule', () => {
  const r = synthesizeResidual({
    original: demo,
    failedNodeId: 'reason',
    outputs: {},
    rewrite: { targetNodeId: 'reason', description: 'retry' },
  });
  assert.ok(r.pipeline.source);
  assert.ok(
    r.pipeline.components.some((c) => c.id === r.pipeline.source),
    'source must exist in the residual components (P0: unscheduled pipelines never run)',
  );
});

test('synthesis never mutates the original pipeline', () => {
  const before = JSON.stringify(demo);
  synthesizeResidual({
    original: demo,
    failedNodeId: 'reason',
    outputs: {},
    rewrite: { targetNodeId: 'reason', description: 'x', configPatch: { model: 'other' } },
  });
  assert.equal(JSON.stringify(demo), before);
});

test('unknown failed node throws', () => {
  assert.throws(
    () =>
      synthesizeResidual({
        original: demo,
        failedNodeId: 'nope',
        outputs: {},
        rewrite: { targetNodeId: 'nope', description: 'x' },
      }),
    SynthesisError,
  );
});

// ── rewrites: recovery as a printable JSON diff ───────────────────────────

test('provider_fallback is literally a one-field diff', () => {
  const p = clonePipeline(demo);
  const diff = applyRewrite(p, {
    targetNodeId: 'reason',
    description: 'swap',
    configPatch: { base_url: 'http://fallback' },
  });
  const custom = findComponent(p, 'reason')!.config.custom as Record<string, unknown>;
  assert.equal(custom.base_url, 'http://fallback');
  assert.equal(diff.length, 1);
  assert.match(diff[0]!, /base_url/);
});

test('model_escalation patches the NESTED custom config, matching the real node schema', () => {
  const p = clonePipeline(demo);
  applyRewrite(p, {
    targetNodeId: 'reason',
    description: 'escalate',
    configPatch: { model: 'autopilot-canned-strong' },
  });
  const custom = findComponent(p, 'reason')!.config.custom as Record<string, unknown>;
  assert.equal(custom.model, 'autopilot-canned-strong', 'must reach inside config.custom');
  assert.equal(findComponent(p, 'reason')!.config.model, undefined, 'must not patch the top level');
});

test('capability_swap replaces the provider while keeping id and wiring intact', () => {
  const p = clonePipeline(demo);
  const diff = applyRewrite(p, {
    targetNodeId: 'reason',
    description: 'swap impl',
    providerReplacement: 'tool_filesystem',
  });
  const node = findComponent(p, 'reason')!;
  assert.equal(node.provider, 'tool_filesystem');
  assert.deepEqual(node.input, [{ lane: 'questions', from: 'ask' }], 'wiring must survive the swap');
  assert.match(diff[0]!, /provider/);
});

test('retry produces an explicit "unchanged" diff rather than an empty one', () => {
  const p = clonePipeline(demo);
  const diff = applyRewrite(p, { targetNodeId: 'reason', description: 'retry' });
  assert.equal(diff.length, 1);
  assert.match(diff[0]!, /unchanged/);
});

test('a rewrite targeting a node outside the residual pipeline throws', () => {
  const p = clonePipeline(demo);
  assert.throws(() => applyRewrite(p, { targetNodeId: 'ghost', description: 'x' }), /not in the residual/);
});

// ── normalize / harvest ───────────────────────────────────────────────────

test('normalizes a real captured flow frame', () => {
  const e = normalizeFlowFrame(
    { id: 0, op: 'leave', component: 'out', trace: { lane: 'text', data: { text: 'hello', length: 5 } } },
    'run-1',
  );
  assert.equal(e.nodeId, 'out');
  assert.equal(e.op, 'leave');
  assert.deepEqual(e.output, { text: 'hello', length: 5 });
});

test('harvest keeps payload lanes and ignores stream-lifecycle lanes', () => {
  const events: ExecutionEvent[] = [
    { runId: 'r', nodeId: 'a', nodeType: 'x', op: 'leave', lane: 'open', startedAt: 0, output: null },
    { runId: 'r', nodeId: 'a', nodeType: 'x', op: 'leave', lane: 'text', startedAt: 0, output: 'real' },
    { runId: 'r', nodeId: 'a', nodeType: 'x', op: 'enter', lane: 'text', startedAt: 0, output: 'ignored' },
    { runId: 'r', nodeId: 'a', nodeType: 'x', op: 'leave', lane: 'close', startedAt: 0, output: null },
  ];
  const outputs = harvestOutputs(events);
  assert.deepEqual(outputs, { 'a:text': 'real' });
});

test('extractText pulls text out of the engine result shapes', () => {
  assert.equal(extractText('plain'), 'plain');
  assert.equal(extractText(['a', 'b']), 'a\nb');
  assert.equal(extractText({ answers: ['from answers'] }), 'from answers');
  assert.equal(extractText({ text: 'from text' }), 'from text');
  assert.equal(extractText({ nothing: 1 }), undefined);
});
