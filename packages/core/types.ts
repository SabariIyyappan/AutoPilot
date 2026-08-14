/**
 * Autopilot core data model.
 *
 * This file has ZERO dependencies — no `rocketride`, no adapter, no I/O.
 * Everything here is testable with the engine switched off. That is the
 * architectural seam the whole project rests on.
 */

// ─── Observation ──────────────────────────────────────────────────────────

export interface RuntimeError {
  message: string;
  /** HTTP status when the failure came from a provider/tool call. */
  status?: number;
  /** Engine-side error string, verbatim from apaevt_flow trace.error. */
  raw?: string;
}

/**
 * Normalized execution event. The adapter maps RocketRide's `apaevt_flow`
 * frames onto this; nothing downstream knows RocketRide exists.
 */
export interface ExecutionEvent {
  runId: string;
  /** Component id as declared in the pipeline (`apaevt_flow.component`). */
  nodeId: string;
  nodeType: string;
  op: 'begin' | 'enter' | 'leave' | 'end';
  /** Lane the payload travelled on. Control lanes are open/closing/close. */
  lane?: string;
  startedAt: number;
  endedAt?: number;
  output?: unknown;
  error?: RuntimeError;
  provider?: string;
  model?: string;
  tool?: string;
  tokens?: number;
  costUsd?: number;
  latencyMs?: number;
}

/** Lanes RocketRide uses for stream lifecycle rather than real payloads. */
export const CONTROL_LANES = ['open', 'closing', 'close'] as const;

export function isPayloadLane(lane: string | undefined): boolean {
  return lane !== undefined && !CONTROL_LANES.includes(lane as never);
}

// ─── Detection: did it fail? ──────────────────────────────────────────────

export interface Evidence {
  kind: string;
  detail: string;
}

export type FailureSignalType =
  | 'RUNTIME_ERROR'
  | 'VALIDATION_ERROR'
  | 'LOOP'
  | 'STALE_CONTEXT'
  | 'VERIFIER_REJECTION'
  | 'RESOURCE_EXHAUSTION';

export interface FailureSignal {
  detected: boolean;
  type: FailureSignalType;
  nodeId: string;
  evidence: Evidence[];
}

// ─── Diagnosis: why did it fail? ──────────────────────────────────────────

export type FailureClass =
  | 'PROVIDER_TRANSIENT'
  | 'PROVIDER_UNAVAILABLE'
  | 'TOOL_TIMEOUT'
  | 'TOOL_UNAVAILABLE'
  | 'INVALID_TOOL_ARGS'
  | 'SCHEMA_MISMATCH'
  | 'STALE_CONTEXT'
  | 'UNKNOWN';

export const FAILURE_CLASSES: readonly FailureClass[] = [
  'PROVIDER_TRANSIENT',
  'PROVIDER_UNAVAILABLE',
  'TOOL_TIMEOUT',
  'TOOL_UNAVAILABLE',
  'INVALID_TOOL_ARGS',
  'SCHEMA_MISMATCH',
  'STALE_CONTEXT',
  'UNKNOWN',
] as const;

// ─── Selection ────────────────────────────────────────────────────────────

export type RecoveryAction =
  | 'retry'
  | 'provider_fallback'
  | 'model_escalation'
  | 'capability_swap'
  | 'output_repair'
  | 'retrieval_refresh'
  | 'escalate';

export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH';

export const RISK_ORDER: Record<RiskLevel, number> = { LOW: 0, MEDIUM: 1, HIGH: 2 };

/**
 * A single deterministic mutation of the pipeline JSON. Recovery is a diff —
 * never an LLM decision.
 */
export interface PipelineRewrite {
  targetNodeId: string;
  description: string;
  /** Shallow config patch applied to the target component. */
  configPatch?: Record<string, unknown>;
  /** Replace the component's provider entirely (capability_swap / fallback). */
  providerReplacement?: string;
}

export interface RecoveryProposal {
  action: RecoveryAction;
  nodeId: string;
  expectedCostUsd: number;
  expectedLatencyMs: number;
  expectedTokens: number;
  risk: RiskLevel;
  /** Declared, not learned. Lives in config, never inferred at runtime. */
  successPrior: number;
  rewrite: PipelineRewrite;
}

/**
 * INVARIANT 2, enforced at both compile time and runtime.
 *
 * `GATE_BRAND` is a real runtime Symbol, not just a type-level tag — an
 * object literal cannot satisfy `PermittedProposal` without importing this
 * exact symbol and assigning it, which happens in exactly one place:
 * `passGate()` below. `machine.ts` additionally asserts the brand's presence
 * at runtime as defence in depth, so even a `JSON.parse` payload forged to
 * look like a `PermittedProposal` is caught before it reaches an executor.
 */
export const GATE_BRAND: unique symbol = Symbol('autopilot.passed-side-effect-gate');

export interface PermittedProposal extends RecoveryProposal {
  readonly [GATE_BRAND]: true;
  /** Why the gate allowed this — surfaced in traces. */
  readonly gateReason: string;
}

export function isPermitted(p: RecoveryProposal): p is PermittedProposal {
  return (p as Partial<PermittedProposal>)[GATE_BRAND] === true && typeof (p as Partial<PermittedProposal>).gateReason === 'string';
}

// ─── Budget ───────────────────────────────────────────────────────────────

export interface RecoveryBudget {
  remainingCostUsd: number;
  remainingLatencyMs: number;
  remainingTokens: number;
  remainingAttempts: number;
  maxRisk: RiskLevel;
}

export interface BudgetRejection {
  action: RecoveryAction;
  /** Human-readable and demo-facing: "$0.14 > $0.10 remaining". */
  reason: string;
}

// ─── Side effects ─────────────────────────────────────────────────────────

export type SideEffect =
  | 'NONE'
  | 'IDEMPOTENT_WRITE'
  | 'REVERSIBLE_WRITE'
  | 'IRREVERSIBLE_WRITE';

export interface VerifierSpec {
  type: 'schema' | 'expected_field' | 'min_results' | 'invariant';
  ref?: string;
  value?: unknown;
}

export interface RecoveryContract {
  nodeId: string;
  /** Absent ⇒ IRREVERSIBLE_WRITE. Fail closed, always. */
  sideEffect: SideEffect;
  retryable: boolean;
  /** Declared capability tag enabling capability_swap (e.g. "customer.lookup"). */
  capability?: string;
  verifier?: VerifierSpec;
}

/** Fail-closed default for any node without a declared contract. */
export function defaultContract(nodeId: string): RecoveryContract {
  return { nodeId, sideEffect: 'IRREVERSIBLE_WRITE', retryable: false };
}

// ─── Verification ─────────────────────────────────────────────────────────

export interface VerificationResult {
  passed: boolean;
  verifier: string;
  detail: string;
}

// ─── State ────────────────────────────────────────────────────────────────

export interface RecoveryAttempt {
  action: RecoveryAction;
  nodeId: string;
  ok: boolean;
  verified: boolean;
  costUsd: number;
  latencyMs: number;
  tokens: number;
  detail?: string;
}

export interface RecoveryCheckpoint {
  runId: string;
  failedNodeId: string;
  /** Cached upstream outputs, keyed `${nodeId}:${lane}`. */
  outputs: Record<string, unknown>;
  history: RecoveryAttempt[];
  budget: RecoveryBudget;
}

export type Phase =
  | 'RUNNING'
  | 'FAILED'
  | 'DIAGNOSING'
  | 'RECOVERING'
  | 'VERIFYING'
  | 'RECOVERED'
  | 'DEGRADED'
  | 'ESCALATED';

export const TERMINAL_PHASES: readonly Phase[] = ['RECOVERED', 'DEGRADED', 'ESCALATED'];

export function isTerminal(phase: Phase): boolean {
  return TERMINAL_PHASES.includes(phase);
}
