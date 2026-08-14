/**
 * Failure DIAGNOSIS — "why did it fail?"
 *
 * TWO-STAGE, and the order matters:
 *
 *   1. A deterministic rules table over the detector's evidence. Free, instant,
 *      reproducible. Handles every failure with a known signature.
 *   2. For anything the rules cannot classify, an OPTIONAL model classifier
 *      (see `diagnoseAsync`). This is where "an LLM reads the trace and infers
 *      the cause" actually lives.
 *
 * Rules run first on purpose: a model should be spent on genuinely ambiguous
 * failures, not on re-deriving that HTTP 401 means the provider is
 * unavailable. It also keeps the benchmark reproducible, because a run that
 * never hits `UNKNOWN` never invokes a model.
 *
 * ── The seam ──────────────────────────────────────────────────────────────
 * This package is control-plane code and may not import the adapter or the
 * RocketRide SDK (`pnpm check:seam` makes that a build failure). So the
 * classifier is INJECTED: this file defines the contract, and
 * `packages/adapter/llm-diagnoser.ts` supplies an implementation that runs a
 * real RocketRide pipeline. The diagnoser stays pure and engine-free testable.
 *
 * `UNKNOWN` remains a legitimate, well-handled outcome — the state machine
 * routes it straight to escalation rather than guessing at a recovery.
 */
import type { FailureClass, FailureSignal } from '../core/types.ts';
import { FAILURE_CLASSES } from '../core/types.ts';

function evidenceValue(signal: FailureSignal, kind: string): string | undefined {
  return signal.evidence.find((e) => e.kind === kind)?.detail;
}

export interface DiagnosisContext {
  /** True when the failing node is a tool/MCP node rather than an LLM node. */
  isToolNode?: boolean;
  /** True when retrieved context is known to be older than the freshness policy. */
  contextStale?: boolean;
}

/**
 * HTTP status → failure class, for provider-shaped failures.
 *
 * The 401/403 mapping to PROVIDER_UNAVAILABLE (rather than a config error) is
 * deliberate and matches how the chaos harness models a dead provider: see
 * docs/architecture.md's note on why `provider_unavailable` maps to 401 —
 * it is the non-retryable code that surfaces on the first attempt.
 */
function classifyHttpStatus(status: number, isToolNode: boolean): FailureClass {
  if (status === 429) return 'PROVIDER_TRANSIENT';
  if (status >= 500) return isToolNode ? 'TOOL_TIMEOUT' : 'PROVIDER_TRANSIENT';
  if (status === 401 || status === 403) return 'PROVIDER_UNAVAILABLE';
  if (status === 404) return isToolNode ? 'TOOL_UNAVAILABLE' : 'PROVIDER_UNAVAILABLE';
  if (status === 400 || status === 422) return 'INVALID_TOOL_ARGS';
  return 'UNKNOWN';
}

export function diagnose(signal: FailureSignal, ctx: DiagnosisContext = {}): FailureClass {
  if (!signal.detected) return 'UNKNOWN';

  const isToolNode = ctx.isToolNode ?? false;

  switch (signal.type) {
    case 'RUNTIME_ERROR': {
      const statusRaw = evidenceValue(signal, 'http_status');
      if (statusRaw) {
        const cls = classifyHttpStatus(Number(statusRaw), isToolNode);
        if (cls !== 'UNKNOWN') return cls;
      }

      // No HTTP status — fall back to textual signals.
      const detail = (
        evidenceValue(signal, 'flow_error') ??
        evidenceValue(signal, 'llm_error_marker') ??
        evidenceValue(signal, 'engine_warning') ??
        ''
      ).toLowerCase();

      if (detail.includes('timeout') || detail.includes('timed out')) {
        return isToolNode ? 'TOOL_TIMEOUT' : 'PROVIDER_TRANSIENT';
      }
      if (detail.includes('rate limit') || detail.includes('overloaded')) return 'PROVIDER_TRANSIENT';
      if (detail.includes('invalid api key') || detail.includes('authentication')) {
        return 'PROVIDER_UNAVAILABLE';
      }
      // The engine collapses provider exceptions into fixed strings before
      // they reach us (nodes/llm_openai_api/openai_client.py -> map_exception):
      //   AuthenticationError  -> "Invalid API key."          (handled above)
      //   APIError             -> "An error occurred with the API."
      //   RateLimitError       -> "Rate limit exceeded..."     (handled above)
      //   APIConnectionError   -> "Failed to connect to the API."
      // A generic APIError is overwhelmingly a 5xx, so it classifies as
      // transient. Read from the engine source, not guessed.
      if (detail.includes('an error occurred with the api')) return 'PROVIDER_TRANSIENT';
      if (detail.includes('failed to connect')) {
        return isToolNode ? 'TOOL_TIMEOUT' : 'PROVIDER_TRANSIENT';
      }
      if (detail.includes('unavailable') || detail.includes('not found')) {
        return isToolNode ? 'TOOL_UNAVAILABLE' : 'PROVIDER_UNAVAILABLE';
      }
      if (detail.includes('connection') || detail.includes('network')) {
        return isToolNode ? 'TOOL_TIMEOUT' : 'PROVIDER_TRANSIENT';
      }
      return 'UNKNOWN';
    }

    case 'VALIDATION_ERROR': {
      if (evidenceValue(signal, 'json_parse')) return 'SCHEMA_MISMATCH';
      if (evidenceValue(signal, 'schema_validation')) return 'SCHEMA_MISMATCH';
      return 'UNKNOWN';
    }

    case 'STALE_CONTEXT':
      return 'STALE_CONTEXT';

    case 'LOOP':
      // A repeating tool call usually means the agent is re-trying a tool that
      // isn't giving it what it needs.
      return isToolNode ? 'TOOL_UNAVAILABLE' : 'UNKNOWN';

    case 'RESOURCE_EXHAUSTION':
      // Deliberately not recoverable by retrying — spending more of an
      // exhausted budget is exactly the wrong move. Escalate.
      return 'UNKNOWN';

    case 'VERIFIER_REJECTION': {
      // A silent failure: the run reported success but the answer was wrong.
      // WHICH verifier rejected it tells us why, and therefore what to try.
      const verifier = evidenceValue(signal, 'verifier');
      if (verifier === 'schema' || verifier === 'llm_error_guard') return 'SCHEMA_MISMATCH';
      if (verifier === 'min_results') return 'STALE_CONTEXT';
      if (ctx.contextStale) return 'STALE_CONTEXT';
      // expected_field / invariant rejections mean the content was wrong for
      // reasons we cannot attribute deterministically — escalate rather than
      // guess at a fix.
      return 'UNKNOWN';
    }

    default: {
      const _exhaustive: never = signal.type;
      void _exhaustive;
      return 'UNKNOWN';
    }
  }
}

// ─── Stage 2: optional model-based classification ──────────────────────────

/**
 * Everything a classifier is given about a failure. Deliberately a flat,
 * serialisable record: it becomes the payload of a RocketRide pipeline run,
 * and nothing here may reference engine types.
 */
export interface LlmDiagnosisInput {
  nodeId: string;
  signalType: FailureSignal['type'];
  /** Evidence the detector gathered, flattened to `kind: detail` lines. */
  evidence: string[];
  /** Whether the failing node is a tool/MCP node. */
  isToolNode: boolean;
  /** The classes the model is allowed to choose from. */
  allowedClasses: readonly FailureClass[];
}

/**
 * Returns a class, or `undefined` when it cannot classify confidently.
 *
 * `undefined` (not a guess) is the correct answer for an unclear failure —
 * it becomes `UNKNOWN`, which escalates to a human.
 */
export type LlmClassifier = (input: LlmDiagnosisInput) => Promise<FailureClass | undefined>;

/**
 * Coerce arbitrary model output into a valid class, or reject it.
 *
 * A model is allowed to INFORM a diagnosis. It is never allowed to widen what
 * recovery is permitted, so anything unrecognised collapses to `UNKNOWN` and
 * escalates. Prose, invented classes, JSON, and empty output all fail closed.
 */
export function parseFailureClass(raw: string | undefined): FailureClass | undefined {
  if (!raw) return undefined;

  // EXACT match on the whole response, not a substring search.
  //
  // Substring matching is unsafe here and was rejected during testing: it
  // reads "this is NOT provider_transient" as selecting PROVIDER_TRANSIENT,
  // and it lets an injected string ("ignore previous rules ... Class: X")
  // steer the diagnosis. The prompt asks for a bare class name, so anything
  // wrapped in prose is a non-compliant response and fails closed.
  //
  // Only surrounding whitespace, quotes and trailing punctuation are
  // forgiven — a model appending a full stop is a formatting quirk, not
  // ambiguity about which class it chose.
  const cleaned = raw
    .trim()
    .replace(/^[\s"'`*]+/, '')
    .replace(/[\s"'`*.]+$/, '')
    .toUpperCase();

  const match = FAILURE_CLASSES.find((c) => c === cleaned);
  if (!match) return undefined;

  // An explicit UNKNOWN means "I cannot classify this", which is a refusal to
  // guess rather than a diagnosis — and it routes to escalation.
  return match === 'UNKNOWN' ? undefined : match;
}

/**
 * Rules first; model only for what rules cannot classify.
 *
 * The classifier is optional — with none supplied this behaves exactly like
 * `diagnose()`, which is what the benchmark relies on.
 */
export async function diagnoseAsync(
  signal: FailureSignal,
  ctx: DiagnosisContext = {},
  classifier?: LlmClassifier,
): Promise<{ failureClass: FailureClass; source: 'rules' | 'llm' }> {
  const fromRules = diagnose(signal, ctx);
  if (fromRules !== 'UNKNOWN' || !classifier) {
    return { failureClass: fromRules, source: 'rules' };
  }

  try {
    const guess = await classifier({
      nodeId: signal.nodeId,
      signalType: signal.type,
      evidence: signal.evidence.map((e) => `${e.kind}: ${e.detail}`),
      isToolNode: ctx.isToolNode ?? false,
      allowedClasses: FAILURE_CLASSES,
    });
    return guess
      ? { failureClass: guess, source: 'llm' }
      : { failureClass: 'UNKNOWN', source: 'rules' };
  } catch {
    // A classifier that throws, times out, or is unreachable must never take
    // the whole run down — an unavailable diagnoser degrades to escalation.
    return { failureClass: 'UNKNOWN', source: 'rules' };
  }
}
