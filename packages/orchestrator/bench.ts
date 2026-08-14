/**
 * The four-mode reliability benchmark — P7, the hard deliverable.
 *
 * Runs the SAME tasks with the SAME seeded faults under four recovery
 * strategies, so the comparison isolates the strategy and nothing else:
 *
 *   NO_RECOVERY   control group — detect and stop
 *   RETRY_ONLY    retry everything, verify nothing
 *   FULL_REPLAN   always escalate to the expensive strategy, verify nothing
 *   AUTOPILOT     targeted, budgeted, verified recovery
 *
 * ── Why the baselines do not verify ───────────────────────────────────────
 * That is the point of the comparison, not a handicap. Retry-only and
 * full-replan are what teams actually build, and neither checks whether the
 * answer is *correct* — only whether the call succeeded. Giving them a
 * verifier would be giving them Autopilot's main idea for free.
 *
 * ── How silent failure is measured honestly ───────────────────────────────
 * Every task carries KNOWN-CORRECT ground truth. A run is a SILENT FAILURE
 * when the mode reports success but the final answer does not match ground
 * truth. Ground truth is never shown to any verifier — it is only used to
 * score afterwards, so no mode (including Autopilot) can cheat by reading it.
 */
import type { AutopilotConfig } from '../control/policy.ts';
import type { PriceTable } from '../control/estimate.ts';
import type { RecoveryContract, VerifierSpec, FailureClass, RecoveryAction } from '../core/types.ts';
import type { PipelineConfig } from '../adapter/pipeline.ts';
import { EngineClient } from '../adapter/client.ts';
import { runWithAutopilot, type RunOutcome } from './orchestrator.ts';

export type BenchMode = 'NO_RECOVERY' | 'RETRY_ONLY' | 'FULL_REPLAN' | 'AUTOPILOT';

export const BENCH_MODES: BenchMode[] = [
  'NO_RECOVERY',
  'RETRY_ONLY',
  'FULL_REPLAN',
  'AUTOPILOT',
];

export interface BenchTask {
  id: string;
  input: string;
  /** Ground truth. Used ONLY for scoring, never shown to a verifier. */
  expected: string;
}

export interface BenchRecord {
  mode: BenchMode;
  taskId: string;
  firstPassOk: boolean;
  recovered: boolean;
  escalated: boolean;
  /** Did the mode CLAIM success? */
  claimedSuccess: boolean;
  /** Did it actually produce the right answer? */
  actuallyCorrect: boolean;
  /** Claimed success but was wrong — the metric that matters most. */
  silentFailure: boolean;
  attempts: number;
  costUsd: number;
  latencyMs: number;
  finalText?: string;
}

export interface ModeSummary {
  mode: BenchMode;
  tasks: number;
  firstPassSuccessRate: number;
  finalSuccessRate: number;
  silentFailureRate: number;
  escalationRate: number;
  meanAttempts: number;
  totalCostUsd: number;
  costPerTaskUsd: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  /** Additional correct answers per dollar of recovery spend, vs NO_RECOVERY. */
  reliabilityGainPerDollar: number | null;
}

const ALL_CLASSES: FailureClass[] = [
  'PROVIDER_TRANSIENT',
  'PROVIDER_UNAVAILABLE',
  'TOOL_TIMEOUT',
  'TOOL_UNAVAILABLE',
  'INVALID_TOOL_ARGS',
  'SCHEMA_MISMATCH',
  'STALE_CONTEXT',
];

/** Force every failure class onto a single strategy, for the baselines. */
function singleStrategyConfig(base: AutopilotConfig, action: RecoveryAction): AutopilotConfig {
  const policy: AutopilotConfig['policy'] = {};
  for (const c of ALL_CLASSES) policy[c] = [action];
  return { ...base, policy };
}

export function configForMode(base: AutopilotConfig, mode: BenchMode): AutopilotConfig {
  switch (mode) {
    case 'RETRY_ONLY':
      return singleStrategyConfig(base, 'retry');
    case 'FULL_REPLAN':
      // "Always do the big expensive thing" — the strategy that ignores cost.
      return singleStrategyConfig(base, 'model_escalation');
    case 'NO_RECOVERY':
    case 'AUTOPILOT':
      return base;
  }
}

export interface BenchOptions {
  tasks: BenchTask[];
  config: AutopilotConfig;
  prices: PriceTable;
  contracts: Map<string, RecoveryContract>;
  pipeline: PipelineConfig;
  watchNodeId: string;
  verifier: VerifierSpec;
  providerEndpoints?: Record<string, string>;
  engineUri?: string;
  /** Advance the chaos generation between recovery runs. */
  onBeforeRecoveryRun?: () => void;
  /** Reset chaos state at the start of each task, so modes see identical faults. */
  onTaskStart?: (taskId: string) => void;
  onProgress?: (done: number, total: number, mode: BenchMode) => void;
}

function correct(finalText: string | undefined, expected: string): boolean {
  if (!finalText) return false;
  return finalText.includes(expected);
}

export async function runBenchmark(opts: BenchOptions): Promise<BenchRecord[]> {
  const records: BenchRecord[] = [];
  const client = new EngineClient({ uri: opts.engineUri, runId: 'bench' });
  await client.connect();

  const total = opts.tasks.length * BENCH_MODES.length;
  let done = 0;

  try {
    for (const mode of BENCH_MODES) {
      const modeConfig = configForMode(opts.config, mode);

      for (const task of opts.tasks) {
        // Reset fault state so EVERY mode sees byte-identical initial faults
        // for this task. This is what makes the comparison fair rather than
        // merely repeated.
        opts.onTaskStart?.(task.id);

        let outcome: RunOutcome;
        try {
          outcome = await runWithAutopilot(task.id, task.input, {
            config: modeConfig,
            prices: opts.prices,
            contracts: opts.contracts,
            pipeline: opts.pipeline,
            watchNodeId: opts.watchNodeId,
            // Only AUTOPILOT verifies. The baselines are what teams actually
            // build, and they check success, not correctness.
            verifier: mode === 'AUTOPILOT' ? opts.verifier : undefined,
            providerEndpoints: opts.providerEndpoints,
            onBeforeRecoveryRun: opts.onBeforeRecoveryRun,
            mode: mode === 'FULL_REPLAN' ? 'AUTOPILOT' : mode,
            sharedClient: client,
          });
        } catch (err) {
          outcome = {
            runId: `${task.id}-error`,
            phase: 'ESCALATED',
            firstPassOk: false,
            recovered: false,
            escalated: true,
            attempts: 0,
            totalCostUsd: 0,
            totalLatencyMs: 0,
            trace: [{ at: Date.now(), event: 'error', detail: String(err) }],
            diffs: [],
            rejections: [],
          };
        }

        const claimedSuccess = outcome.firstPassOk || outcome.recovered;
        const actuallyCorrect = correct(outcome.finalText, task.expected);

        records.push({
          mode,
          taskId: task.id,
          firstPassOk: outcome.firstPassOk,
          recovered: outcome.recovered,
          escalated: outcome.escalated,
          claimedSuccess,
          actuallyCorrect,
          silentFailure: claimedSuccess && !actuallyCorrect,
          attempts: outcome.attempts,
          costUsd: outcome.totalCostUsd,
          latencyMs: outcome.totalLatencyMs,
          finalText: outcome.finalText,
        });

        opts.onProgress?.(++done, total, mode);
      }
    }
  } finally {
    await client.releaseAll();
    await client.disconnect();
  }

  return records;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx] ?? 0;
}

export function summarize(records: BenchRecord[]): ModeSummary[] {
  const baseline = records.filter((r) => r.mode === 'NO_RECOVERY');
  const baselineCorrect = baseline.filter((r) => r.actuallyCorrect).length;
  const baselineRate = baseline.length > 0 ? baselineCorrect / baseline.length : 0;

  return BENCH_MODES.map((mode) => {
    const rs = records.filter((r) => r.mode === mode);
    const n = rs.length || 1;
    const correctCount = rs.filter((r) => r.actuallyCorrect).length;
    const totalCost = rs.reduce((s, r) => s + r.costUsd, 0);

    // Reliability gain per recovery dollar: additional CORRECT answers over
    // the no-recovery baseline, divided by what was spent to get them.
    const additionalCorrect = correctCount / n - baselineRate;
    const gain = totalCost > 0 ? (additionalCorrect * n) / totalCost : null;

    return {
      mode,
      tasks: rs.length,
      firstPassSuccessRate: rs.filter((r) => r.firstPassOk).length / n,
      finalSuccessRate: correctCount / n,
      silentFailureRate: rs.filter((r) => r.silentFailure).length / n,
      escalationRate: rs.filter((r) => r.escalated).length / n,
      meanAttempts: rs.reduce((s, r) => s + r.attempts, 0) / n,
      totalCostUsd: totalCost,
      costPerTaskUsd: totalCost / n,
      p50LatencyMs: percentile(rs.map((r) => r.latencyMs), 50),
      p95LatencyMs: percentile(rs.map((r) => r.latencyMs), 95),
      reliabilityGainPerDollar: gain,
    };
  });
}
