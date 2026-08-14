import { test } from 'node:test';
import assert from 'node:assert/strict';
import { frontier, residualSet, type GraphNode } from './graph.ts';

// retrieve → crm → reason → payment → out
const linear: GraphNode[] = [
  { id: 'retrieve', inputs: [] },
  { id: 'crm', inputs: ['retrieve'] },
  { id: 'reason', inputs: ['crm'] },
  { id: 'payment', inputs: ['reason'] },
  { id: 'out', inputs: ['payment'] },
];

test('residualSet: failure at reason includes reason + everything downstream, excludes upstream', () => {
  const set = residualSet(linear, 'reason');
  assert.deepEqual([...set].sort(), ['out', 'payment', 'reason']);
});

test('residualSet: failure at the terminal node is just itself', () => {
  const set = residualSet(linear, 'out');
  assert.deepEqual([...set], ['out']);
});

test('residualSet: failure at the first node includes the whole pipeline', () => {
  const set = residualSet(linear, 'retrieve');
  assert.deepEqual([...set].sort(), ['crm', 'out', 'payment', 'reason', 'retrieve']);
});

test('frontier: exactly the edges crossing into the residual set', () => {
  const set = residualSet(linear, 'reason');
  const edges = frontier(linear, set);
  assert.deepEqual(edges, [{ from: 'crm', to: 'reason' }]);
});

test('frontier: empty when the residual set is the whole graph', () => {
  const set = residualSet(linear, 'retrieve');
  assert.deepEqual(frontier(linear, set), []);
});

// A fan-in graph: crm and search both feed reason.
const fanIn: GraphNode[] = [
  { id: 'crm', inputs: [] },
  { id: 'search', inputs: [] },
  { id: 'reason', inputs: ['crm', 'search'] },
  { id: 'out', inputs: ['reason'] },
];

test('frontier: fan-in produces one edge per upstream cached dependency', () => {
  const set = residualSet(fanIn, 'reason');
  const edges = frontier(fanIn, set);
  assert.deepEqual(
    edges.sort((a, b) => a.from.localeCompare(b.from)),
    [
      { from: 'crm', to: 'reason' },
      { from: 'search', to: 'reason' },
    ],
  );
});

// Q3: agent (reason) invokes a tool (mcp_client) via control[], and the tool
// feeds forward into payment via a normal data edge.
const withControl: GraphNode[] = [
  { id: 'crm', inputs: [] },
  { id: 'reason', inputs: ['crm'], control: ['mcp_client'] },
  { id: 'mcp_client', inputs: [] },
  { id: 'payment', inputs: ['reason'] },
];

test('Q3 fallback: a residual set touching a control edge widens to the whole control group', () => {
  const set = residualSet(withControl, 'reason');
  // reason is in the residual set and has a control edge to mcp_client — the
  // whole control-connected group must be pulled in, not sliced through.
  assert.ok(set.has('mcp_client'), 'control-wired tool must not be severed from its agent');
  assert.ok(set.has('reason'));
  assert.ok(set.has('payment'));
});

test('residualSet throws on an unknown start node rather than silently returning empty', () => {
  assert.throws(() => residualSet(linear, 'does_not_exist'));
});
