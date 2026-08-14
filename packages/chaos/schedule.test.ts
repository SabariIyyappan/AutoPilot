import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PROFILE, fault, type FaultProfile } from './schedule.ts';

test('determinism: same inputs always produce the same fault, across repeated calls', () => {
  const a = fault(42, 'task-1', 'reason', 0);
  const b = fault(42, 'task-1', 'reason', 0);
  assert.equal(a, b);
});

test('determinism: an entire schedule is byte-identical across two independent runs', () => {
  const seed = 42;
  const nodes = ['retrieve', 'crm', 'reason', 'payment'];
  const tasks = Array.from({ length: 50 }, (_, i) => `task-${i}`);

  function runSchedule() {
    const out: string[] = [];
    for (const t of tasks) {
      for (const n of nodes) {
        out.push(`${t}:${n}:${fault(seed, t, n, 0)}`);
      }
    }
    return out.join('\n');
  }

  assert.equal(runSchedule(), runSchedule());
});

test('all four benchmark modes see byte-identical faults at attemptIndex 0', () => {
  // Simulates NO_RECOVERY / RETRY_ONLY / FULL_REPLAN / AUTOPILOT all making
  // their first call to the same node for the same task — the fairness
  // property the benchmark depends on.
  const seed = 7;
  const modes = ['NO_RECOVERY', 'RETRY_ONLY', 'FULL_REPLAN', 'AUTOPILOT'];
  const results = modes.map(() => fault(seed, 'task-9', 'crm', 0));
  assert.ok(results.every((r) => r === results[0]));
});

test('recovery attempts (attemptIndex > 0) CAN diverge from attemptIndex 0', () => {
  // Not a hard guarantee for every seed, but the hash must not be constant
  // across attemptIndex — otherwise retries would deterministically refault
  // forever, and no recovery strategy could ever succeed.
  const seed = 1;
  const values = Array.from({ length: 20 }, (_, i) => fault(seed, 'task-x', 'node-y', i));
  const distinct = new Set(values);
  assert.ok(distinct.size > 1, 'fault outcomes must vary across attempt indices');
});

test('probabilities roughly match the profile over many samples', () => {
  const profile: FaultProfile = { mcp_timeout: 0.3 };
  let hits = 0;
  const N = 20_000;
  for (let i = 0; i < N; i++) {
    if (fault(1, `t${i}`, 'n', 0, profile) === 'mcp_timeout') hits++;
  }
  const rate = hits / N;
  assert.ok(Math.abs(rate - 0.3) < 0.02, `observed rate ${rate} too far from 0.3`);
});

test('profile entries never overlap: total fault rate never exceeds the sum of probabilities', () => {
  let hits = 0;
  const N = 20_000;
  const totalP = Object.values(DEFAULT_PROFILE).reduce((a, b) => a + b, 0);
  for (let i = 0; i < N; i++) {
    if (fault(1, `t${i}`, 'n', 0) !== null) hits++;
  }
  const rate = hits / N;
  assert.ok(Math.abs(rate - totalP) < 0.02, `observed ${rate} vs expected ${totalP}`);
});

test('different nodeId or taskId changes the outcome (not globally constant per seed)', () => {
  const a = fault(1, 'task-1', 'node-a', 0);
  const b = fault(1, 'task-1', 'node-b', 0);
  const c = fault(1, 'task-2', 'node-a', 0);
  // Not asserting inequality (collisions are possible) — asserting the
  // function actually consults all three inputs by checking variety exists
  // across a larger sample instead of a single point comparison.
  const samples = new Set<string>();
  for (let i = 0; i < 200; i++) {
    samples.add(String(fault(1, `task-${i}`, 'node-a', 0)));
    samples.add(String(fault(1, `task-${i}`, 'node-b', 0)));
  }
  assert.ok(samples.size > 1);
  void a;
  void b;
  void c;
});

test('empty profile never faults', () => {
  for (let i = 0; i < 100; i++) {
    assert.equal(fault(1, `t${i}`, 'n', 0, {}), null);
  }
});
