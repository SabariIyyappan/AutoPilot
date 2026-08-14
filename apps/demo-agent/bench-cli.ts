/**
 * `autopilot bench --seed 42 --tasks 100`
 *
 * Runs the four-mode reliability benchmark against the live engine and
 * writes raw JSONL to runs/ so results are reproducible from the repo.
 */
import path from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { startFaultProxy } from '../../packages/chaos/proxy.ts';
import { LLM_PROFILE } from '../../packages/chaos/schedule.ts';
import { runBenchmark, summarize, type BenchTask } from '../../packages/orchestrator/bench.ts';
import { loadConfig, loadPrices } from '../../packages/control/config.ts';
import type { RecoveryContract } from '../../packages/core/types.ts';

const ROOT = path.resolve(import.meta.dirname, '..', '..');

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

/**
 * Tasks with KNOWN-CORRECT answers. Ground truth is essential: without it,
 * silent-failure rate cannot be measured, and that metric is the whole
 * argument. Answers are exact strings, never free prose.
 */
function buildTasks(count: number): BenchTask[] {
  return Array.from({ length: count }, (_, i) => {
    const id = 4000 + i;
    return {
      id: `task-${i}`,
      input: `Return the customer record for CUSTOMER-${id} as JSON.`,
      expected: `CUSTOMER-${id}`,
    };
  });
}

async function main() {
  const seed = Number(arg('seed', '42'));
  const taskCount = Number(arg('tasks', '100'));

  const config = loadConfig(path.join(ROOT, 'autopilot.config.yaml'));
  const prices = loadPrices(path.join(ROOT, 'prices.json'));
  const tasks = buildTasks(taskCount);

  // Which task the proxy is currently serving, so its canned answer matches
  // the task's ground truth and faults key off the right task id.
  let currentTask = tasks[0]!;

  const primary = await startFaultProxy({
    seed,
    nodeId: 'reason',
    // The FROZEN LLM profile — probabilistic across all attempts, unlike the
    // forced single-fault profiles the demo scenarios use.
    profile: LLM_PROFILE,
    taskIdOf: () => currentTask.id,
    respond: () =>
      JSON.stringify({ customerId: currentTask.expected, balance: 128.4 }),
  });

  const secondary = await startFaultProxy({
    seed,
    nodeId: 'reason',
    profile: {}, // healthy fallback endpoint
    taskIdOf: () => currentTask.id,
    respond: () =>
      JSON.stringify({ customerId: currentTask.expected, balance: 128.4 }),
  });

  const pipeline = {
    version: 1,
    source: 'in',
    components: [
      {
        id: 'in',
        provider: 'webhook',
        config: { hideForm: true, mode: 'Source', type: 'webhook', parameters: {} },
      },
      {
        id: 'ask',
        provider: 'prompt',
        config: { type: 'prompt', instructions: ['Return the customer record as JSON.'] },
        input: [{ lane: 'text', from: 'in' }],
      },
      {
        id: 'reason',
        provider: 'llm_openai_api',
        config: {
          profile: 'custom',
          custom: {
            model: 'autopilot-canned',
            base_url: primary.url,
            apikey: 'unused-local-key',
            modelTotalTokens: 4096,
          },
        },
        input: [{ lane: 'questions', from: 'ask' }],
      },
      {
        id: 'out',
        provider: 'response_answers',
        config: { laneName: 'answers' },
        input: [{ lane: 'answers', from: 'reason' }],
      },
    ],
  };

  const contracts = new Map<string, RecoveryContract>([
    ['reason', { nodeId: 'reason', sideEffect: 'NONE', retryable: true }],
  ]);

  console.log(`\nAutopilot benchmark — seed ${seed}, ${taskCount} tasks x 4 modes\n`);
  const started = Date.now();

  const records = await runBenchmark({
    tasks,
    config,
    prices,
    contracts,
    pipeline,
    watchNodeId: 'reason',
    verifier: { type: 'schema', ref: 'customerId,balance' },
    providerEndpoints: { primary: primary.url, secondary: secondary.url },
    onTaskStart: (taskId) => {
      currentTask = tasks.find((t) => t.id === taskId) ?? currentTask;
      // Reset fault generation so every mode sees identical initial faults.
      primary.resetGeneration();
      secondary.resetGeneration();
    },
    onBeforeRecoveryRun: () => {
      primary.nextGeneration();
      secondary.nextGeneration();
    },
    onProgress: (done, total, mode) => {
      if (done % 10 === 0 || done === total) {
        process.stdout.write(`\r  ${done}/${total}  (${mode})          `);
      }
    },
  });

  await primary.close();
  await secondary.close();

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`\n\ncompleted in ${elapsed}s\n`);

  mkdirSync(path.join(ROOT, 'runs'), { recursive: true });
  const raw = path.join(ROOT, 'runs', `bench-seed${seed}-n${taskCount}.jsonl`);
  writeFileSync(raw, records.map((r) => JSON.stringify(r)).join('\n') + '\n');

  const summaries = summarize(records);

  const head = [
    'mode'.padEnd(14),
    'first'.padStart(7),
    'final'.padStart(7),
    'silent'.padStart(8),
    'escal'.padStart(7),
    'att'.padStart(5),
    '$/task'.padStart(9),
    'p50ms'.padStart(7),
    'gain/$'.padStart(9),
  ].join(' ');
  console.log(head);
  console.log('─'.repeat(head.length));

  for (const s of summaries) {
    console.log(
      [
        s.mode.padEnd(14),
        pct(s.firstPassSuccessRate).padStart(7),
        pct(s.finalSuccessRate).padStart(7),
        pct(s.silentFailureRate).padStart(8),
        pct(s.escalationRate).padStart(7),
        s.meanAttempts.toFixed(2).padStart(5),
        `$${s.costPerTaskUsd.toFixed(5)}`.padStart(9),
        String(s.p50LatencyMs).padStart(7),
        (s.reliabilityGainPerDollar === null
          ? '—'
          : s.reliabilityGainPerDollar.toFixed(1)
        ).padStart(9),
      ].join(' '),
    );
  }

  console.log(`\nraw records: ${path.relative(ROOT, raw)}`);
  console.log(
    '\nsilent failure = the mode reported success but the answer was wrong.\n' +
      'Ground truth is used only for scoring — never shown to any verifier.\n',
  );

  writeFileSync(
    path.join(ROOT, 'runs', `summary-seed${seed}-n${taskCount}.json`),
    JSON.stringify({ seed, taskCount, summaries }, null, 2),
  );
}

main().catch((err) => {
  console.error(`\nbenchmark failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
