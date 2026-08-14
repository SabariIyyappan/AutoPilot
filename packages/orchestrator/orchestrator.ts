/**
 * The DRIVER. The state machine decides *what* should happen; this
 * interprets those decisions and performs the actual I/O.
 *
 * Keeping the decision logic in a pure reducer and the side effects here is
 * what lets the entire control plane be tested without an engine — and it
 * means the recovery policy can be audited by reading one pure function.
 */
import { EngineClient } from '../adapter/client.ts';
import { extractText, harvestOutputs } from '../adapter/normalize.ts';
import type { PipelineConfig } from '../adapter/pipeline.ts';
import { synthesizeResidual, SynthesisError } from '../adapter/residual.ts';
import { budgetFromConfig } from '../control/config.ts';
import type { PriceTable } from '../control/estimate.ts';
import type { AutopilotConfig, NodeContext } from '../control/policy.ts';
import { selectRecovery } from '../control/select.ts';
import { initialState, step } from '../core/machine.ts';
import type { MachineState } from '../core/machine-types.ts';
import type { RecoveryContract, VerifierSpec } from '../core/types.ts';
import { detect } from '../diagnosis/detector.ts';
import { diagnose } from '../diagnosis/diagnoser.ts';
import { verify } from '../verify/verify.ts';

export interface TraceEntry {
  at: number;
  event: string;
  [key: string]: unknown;
}

export interface OrchestratorOptions {
  config: AutopilotConfig;
  prices: PriceTable;
  contracts: Map<string, RecoveryContract>;
  pipeline: PipelineConfig;
  /** Node the scenario expects to fail — used to scope detection. */
  watchNodeId: string;
  /** Is the watched node a tool/MCP node? Changes diagnosis. */
  isToolNode?: boolean;
  verifier?: VerifierSpec;
  expected?: string;
  engineUri?: string;
  /**
   * Alternative component providers satisfying the watched node's declared
   * capability. Enables capability_swap (scenario B) — e.g. a real MCP tool
   * failing over to RocketRide's native tool_filesystem node.
   */
  capabilityAlternatives?: string[];
  /** Provider name -> endpoint URL, so provider_fallback rewrites a real URL. */
  providerEndpoints?: Record<string, string>;
  /**
   * Called before each recovery pipeline run. The chaos harness uses this to
   * advance its fault "generation", so a transient fault clears for the next
   * run — see the fault-scope note in packages/chaos/proxy.ts.
   */
  onBeforeRecoveryRun?: () => void;
  /** Recovery mode, for the benchmark's four-way comparison. */
  mode?: 'AUTOPILOT' | 'RETRY_ONLY' | 'NO_RECOVERY';
  /**
   * Reuse an existing connected client and its pipeline-instance cache.
   * The benchmark passes one shared client so `use()` (≈10.9s) is paid once
   * per distinct pipeline instead of once per task.
   */
  sharedClient?: EngineClient;
}

export interface RunOutcome {
  runId: string;
  phase: MachineState['phase'];
  firstPassOk: boolean;
  recovered: boolean;
  escalated: boolean;
  attempts: number;
  totalCostUsd: number;
  totalLatencyMs: number;
  trace: TraceEntry[];
  finalText?: string;
  /** Printable JSON diffs applied during recovery — the demo's centrepiece. */
  diffs: string[][];
  rejections: Array<{ action: string; reason: string }>;
}

export async function runWithAutopilot(
  taskId: string,
  input: string,
  opts: OrchestratorOptions,
): Promise<RunOutcome> {
  const runId = `${taskId}-${Date.now()}`;
  const trace: TraceEntry[] = [];
  const diffs: string[][] = [];
  const log = (event: string, data: Record<string, unknown> = {}) =>
    trace.push({ at: Date.now(), event, ...data });

  const budget = budgetFromConfig(opts.config);
  let state = initialState(runId, budget);
  const client = opts.sharedClient ?? new EngineClient({ uri: opts.engineUri, runId });
  const ownsClient = !opts.sharedClient;

  let totalCost = 0;
  const startedAt = Date.now();

  try {
    if (ownsClient) await client.connect();

    // ── First pass ────────────────────────────────────────────────────────
    const first = await client.runCached(opts.pipeline, input, `${taskId}-first`);
    const firstText = extractText(first.result);
    log('first_pass', { ok: first.ok, latencyMs: first.latencyMs });

    const signal = detect({
      nodeId: opts.watchNodeId,
      warnings: first.warnings,
      outputText: firstText,
      events: first.events.filter((e) => e.nodeId === opts.watchNodeId),
    });

    let effectiveSignal = signal;

    if (!signal.detected) {
      // Nothing *looked* wrong — but "nothing detected" is not "correct".
      // The run reported success, so only the verifier can tell us whether
      // the answer is actually right.
      const v = await verify(opts.verifier, {
        output: first.result,
        text: firstText,
        expected: opts.expected,
      });
      log('first_pass_verified', { passed: v.passed, verifier: v.verifier, detail: v.detail });

      if (v.passed) {
        return {
          runId,
          phase: 'RUNNING',
          firstPassOk: true,
          recovered: false,
          escalated: false,
          attempts: 0,
          totalCostUsd: 0,
          totalLatencyMs: Date.now() - startedAt,
          trace,
          finalText: firstText,
          diffs,
          rejections: [],
        };
      }

      // THIS IS A SILENT FAILURE: the pipeline succeeded and returned a wrong
      // answer. It is the single most valuable thing this system catches, so
      // it enters the recovery loop like any other failure rather than
      // dead-ending here.
      effectiveSignal = {
        detected: true,
        type: 'VERIFIER_REJECTION',
        nodeId: opts.watchNodeId,
        evidence: [
          { kind: 'verifier', detail: v.verifier },
          { kind: 'verifier_detail', detail: v.detail },
        ],
      };
    }

    const signalToUse = effectiveSignal;
    log('failure_detected', { type: signalToUse.type, evidence: signalToUse.evidence });

    // NO_RECOVERY baseline stops here — this is the benchmark's control group.
    if (opts.mode === 'NO_RECOVERY') {
      return {
        runId,
        phase: 'FAILED',
        firstPassOk: false,
        recovered: false,
        escalated: true,
        attempts: 0,
        totalCostUsd: 0,
        totalLatencyMs: Date.now() - startedAt,
        trace,
        finalText: firstText,
        diffs,
        rejections: [],
      };
    }

    [state] = step(state, { kind: 'FAILURE_DETECTED', signal: signalToUse });

    // ── Diagnose ──────────────────────────────────────────────────────────
    const failureClass = diagnose(signalToUse, { isToolNode: opts.isToolNode });
    log('diagnosed', { failureClass });
    [state] = step(state, { kind: 'DIAGNOSED', failureClass });
    if (state.phase === 'ESCALATED') {
      return finish(state, 'escalated_on_diagnosis');
    }

    const outputs = harvestOutputs(first.events);

    // ── Recovery loop ─────────────────────────────────────────────────────
    const failedNode = opts.pipeline.components.find((c) => c.id === opts.watchNodeId);
    const nodeCtx: NodeContext = {
      nodeId: opts.watchNodeId,
      model: readModel(failedNode?.config) ?? 'autopilot-canned',
      provider: 'primary',
      priorTokens: Math.ceil((firstText?.length ?? 400) / opts.prices.charsPerToken),
      capability: opts.contracts.get(opts.watchNodeId)?.capability,
      capabilityAlternatives: opts.capabilityAlternatives ?? [],
      providerEndpoints: opts.providerEndpoints,
    };

    const selection = selectRecovery(
      opts.config,
      opts.prices,
      failureClass,
      nodeCtx,
      state.budget,
      opts.contracts,
    );
    log('selection', {
      considered: selection.trace.considered,
      permitted: selection.trace.permitted,
      rejections: selection.trace.rejections,
    });

    [state] = step(state, selection.input);
    if (state.phase === 'ESCALATED') {
      return finish(state, 'escalated_no_permitted_recovery');
    }

    // Execute permitted strategies until one verifies or the queue empties.
    while (state.phase === 'RECOVERING' && state.current) {
      const proposal = state.current;
      log('recovery_attempt', { action: proposal.action, gateReason: proposal.gateReason });

      let residual;
      try {
        residual = synthesizeResidual({
          original: opts.pipeline,
          failedNodeId: opts.watchNodeId,
          outputs,
          rewrite: proposal.rewrite,
        });
      } catch (err) {
        // Synthesis refuses rather than running with missing context.
        const detail = err instanceof SynthesisError ? err.message : String(err);
        log('synthesis_refused', { detail });
        [state] = step(state, {
          kind: 'RECOVERY_EXECUTED',
          ok: false,
          costUsd: 0,
          latencyMs: 0,
          tokens: 0,
          detail,
        });
        continue;
      }

      diffs.push(residual.diff);
      log('residual_synthesized', {
        diff: residual.diff,
        skipped: residual.skipped,
        replayedFree: residual.replayedFree,
      });

      opts.onBeforeRecoveryRun?.();
      const attempt = await client.runCached(residual.pipeline, input, `${taskId}-recovery`);
      const attemptText = extractText(attempt.result);
      const attemptSignal = detect({
        nodeId: opts.watchNodeId,
        warnings: attempt.warnings,
        outputText: attemptText,
      });
      totalCost += proposal.expectedCostUsd;

      [state] = step(state, {
        kind: 'RECOVERY_EXECUTED',
        ok: attempt.ok && !attemptSignal.detected,
        costUsd: proposal.expectedCostUsd,
        latencyMs: attempt.latencyMs,
        tokens: proposal.expectedTokens,
      });

      if (state.phase !== 'VERIFYING') continue;

      // ── Verify. A recovery that ran is not a recovery that worked. ──
      const v = await verify(opts.verifier, {
        output: attempt.result,
        text: attemptText,
        expected: opts.expected,
      });
      log('verified', { passed: v.passed, verifier: v.verifier, detail: v.detail });
      [state] = step(state, { kind: 'VERIFIED', result: v });

      if (state.phase === 'RECOVERED') {
        return finish(state, 'recovered', attemptText);
      }
    }

    return finish(state, 'exhausted');
  } finally {
    if (ownsClient) {
      await client.releaseAll();
      await client.disconnect();
    }
  }

  function finish(s: MachineState, reason: string, finalText?: string): RunOutcome {
    log('finished', { phase: s.phase, reason });
    return {
      runId,
      phase: s.phase,
      firstPassOk: false,
      recovered: s.phase === 'RECOVERED',
      escalated: s.phase === 'ESCALATED',
      attempts: s.history.length,
      totalCostUsd: totalCost,
      totalLatencyMs: Date.now() - startedAt,
      trace,
      finalText,
      diffs,
      rejections: s.rejections,
    };
  }
}

function readModel(config: Record<string, unknown> | undefined): string | undefined {
  if (!config) return undefined;
  const custom = config.custom;
  if (custom && typeof custom === 'object') {
    const m = (custom as Record<string, unknown>).model;
    if (typeof m === 'string') return m;
  }
  return typeof config.model === 'string' ? config.model : undefined;
}
