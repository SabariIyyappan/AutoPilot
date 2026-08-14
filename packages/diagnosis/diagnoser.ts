/**
 * Failure DIAGNOSIS — "why did it fail?"
 *
 * A deterministic rules table over the evidence the detector gathered. No LLM
 * is in this path: the plan's "explicitly not building" list rules out
 * model-based diagnosis for v1 precisely because it is non-deterministic,
 * costs money, and would poison the benchmark's reproducibility.
 *
 * `UNKNOWN` is a legitimate, well-handled outcome — the state machine routes
 * it straight to escalation rather than guessing at a recovery.
 */
import type { FailureClass, FailureSignal } from '../core/types.ts';

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
