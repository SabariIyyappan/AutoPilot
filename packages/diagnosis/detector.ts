/**
 * Failure DETECTION — "did something go wrong?"
 *
 * It deliberately does NOT answer *why*. That separation is the point: this
 * module is 100% deterministic pattern matching over observed runtime data.
 * No model is ever asked whether an HTTP 429 is a failure.
 *
 * The signal shapes below are not guesses — they were captured from a live
 * engine in P2 (see docs/architecture.md, "P2 Findings"). The key finding:
 * LLM-node faults never surface as `apaevt_flow.trace.error`. The engine
 * catches its own exception and formats it into a *successful-looking*
 * answer, with the real detail landing in `getTaskStatus().warnings[]`.
 * Hence two channels, checked in priority order.
 */
import type { Evidence, ExecutionEvent, FailureSignal } from '../core/types.ts';

/**
 * Engine warning format, verbatim from a live run:
 *   "Warning*Error 500: server_error - internal server error*<path>:<line>"
 *   "Warning*Error 401: authentication_error - invalid api key*<path>:<line>"
 */
const WARNING_ERROR_RE = /Error\s+(\d{3}):\s*([a-z_]+)\s*-\s*([^*]+)/i;

/**
 * The marker the LLM node embeds in its own output text when it has given up.
 * Live-observed: "**LLM error** — ValueError: An error occurred with the API."
 */
const LLM_ERROR_MARKER = '**LLM error**';

export interface DetectionInput {
  nodeId: string;
  /** Warnings from getTaskStatus() / apaevt_status_update. Authoritative channel. */
  warnings?: readonly string[];
  /** The node's textual output, if any. Secondary channel. */
  outputText?: string;
  /** Normalized flow events for this node, if any. */
  events?: readonly ExecutionEvent[];
  /** Result of a structured-output validation, when the node declares a schema. */
  schemaValid?: boolean;
  /** Prior tool calls this run, used for loop detection. */
  priorToolCalls?: readonly string[];
  /** Current tool call signature, used for loop detection. */
  currentToolCall?: string;
  /** Budget thresholds, for RESOURCE_EXHAUSTION. */
  tokensUsed?: number;
  tokenLimit?: number;
}

const NO_FAILURE: FailureSignal = {
  detected: false,
  type: 'RUNTIME_ERROR',
  nodeId: '',
  evidence: [],
};

/** Parsed detail from an engine warning line. */
export interface ParsedEngineError {
  status: number;
  kind: string;
  message: string;
}

export function parseEngineWarning(warning: string): ParsedEngineError | null {
  const m = WARNING_ERROR_RE.exec(warning);
  if (!m) return null;
  const [, status, kind, message] = m;
  return {
    status: Number(status),
    kind: (kind ?? '').trim(),
    message: (message ?? '').trim(),
  };
}

export function detect(input: DetectionInput): FailureSignal {
  const evidence: Evidence[] = [];

  // ── Channel 1 (authoritative): engine warnings carrying a real HTTP status.
  for (const w of input.warnings ?? []) {
    const parsed = parseEngineWarning(w);
    if (parsed) {
      return {
        detected: true,
        type: 'RUNTIME_ERROR',
        nodeId: input.nodeId,
        evidence: [
          { kind: 'engine_warning', detail: w },
          { kind: 'http_status', detail: String(parsed.status) },
          { kind: 'provider_error_kind', detail: parsed.kind },
        ],
      };
    }
  }

  // ── Channel 2 (defence in depth): the node formatted an error into its
  //    own output instead of failing. Catches the case where warnings were
  //    not subscribed to.
  if (input.outputText?.includes(LLM_ERROR_MARKER)) {
    return {
      detected: true,
      type: 'RUNTIME_ERROR',
      nodeId: input.nodeId,
      evidence: [{ kind: 'llm_error_marker', detail: input.outputText.slice(0, 200) }],
    };
  }

  // ── Explicit flow-level errors, when a node type does surface them.
  for (const e of input.events ?? []) {
    if (e.error) {
      return {
        detected: true,
        type: 'RUNTIME_ERROR',
        nodeId: input.nodeId,
        evidence: [
          { kind: 'flow_error', detail: e.error.message },
          ...(e.error.status ? [{ kind: 'http_status', detail: String(e.error.status) }] : []),
        ],
      };
    }
  }

  // ── Structured output validation.
  if (input.schemaValid === false) {
    return {
      detected: true,
      type: 'VALIDATION_ERROR',
      nodeId: input.nodeId,
      evidence: [{ kind: 'schema_validation', detail: 'declared output schema did not validate' }],
    };
  }

  // Malformed JSON where the node was expected to emit structured output.
  if (input.outputText !== undefined && input.schemaValid === undefined) {
    const trimmed = input.outputText.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        JSON.parse(trimmed);
      } catch {
        return {
          detected: true,
          type: 'VALIDATION_ERROR',
          nodeId: input.nodeId,
          evidence: [{ kind: 'json_parse', detail: 'output began as JSON but failed to parse' }],
        };
      }
    }
  }

  // ── Loop detection: the same tool call repeating within one run.
  if (input.currentToolCall && input.priorToolCalls) {
    const repeats = input.priorToolCalls.filter((c) => c === input.currentToolCall).length;
    if (repeats >= 2) {
      return {
        detected: true,
        type: 'LOOP',
        nodeId: input.nodeId,
        evidence: [
          { kind: 'repeated_tool_call', detail: `"${input.currentToolCall}" repeated ${repeats + 1}x` },
        ],
      };
    }
  }

  // ── Resource exhaustion.
  if (
    input.tokensUsed !== undefined &&
    input.tokenLimit !== undefined &&
    input.tokensUsed > input.tokenLimit
  ) {
    return {
      detected: true,
      type: 'RESOURCE_EXHAUSTION',
      nodeId: input.nodeId,
      evidence: [
        { kind: 'token_budget', detail: `${input.tokensUsed} > ${input.tokenLimit}` },
      ],
    };
  }

  return { ...NO_FAILURE, nodeId: input.nodeId, evidence };
}
