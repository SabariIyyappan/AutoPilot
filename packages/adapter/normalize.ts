/**
 * `apaevt_flow` → `ExecutionEvent`, plus checkpoint harvesting.
 *
 * Frame shape is verbatim from the live engine (P0, fixtures/raw-events.jsonl):
 *
 *   { id, op: 'begin'|'enter'|'leave'|'end', pipes: string[],
 *     component: string, trace: { lane?, data?, result?, error? },
 *     project_id, source }
 *
 * Note `component` is the declared node id and `trace.data` carries the REAL
 * per-lane payload — which is what makes residual synthesis possible at all
 * (Q1 in docs/architecture.md).
 */
import { isPayloadLane, type ExecutionEvent } from '../core/types.ts';
import { outputKey, type CheckpointOutputs } from './residual.ts';

export interface FlowFrameBody {
  id: number;
  op: 'begin' | 'enter' | 'leave' | 'end';
  pipes?: string[];
  component: string;
  trace?: {
    lane?: string;
    data?: unknown;
    result?: string;
    error?: string;
  };
  project_id?: string;
  source?: string;
}

export function normalizeFlowFrame(
  body: FlowFrameBody,
  runId: string,
  nodeTypes: ReadonlyMap<string, string> = new Map(),
): ExecutionEvent {
  const event: ExecutionEvent = {
    runId,
    nodeId: body.component,
    nodeType: nodeTypes.get(body.component) ?? 'unknown',
    op: body.op,
    lane: body.trace?.lane,
    startedAt: Date.now(),
  };

  if (body.trace?.data !== undefined && body.trace.data !== null) {
    event.output = body.trace.data;
  }
  if (body.trace?.error) {
    event.error = { message: body.trace.error, raw: body.trace.error };
  }
  return event;
}

/**
 * Harvest cached upstream outputs from a run's flow events.
 *
 * Only `leave` on a payload lane counts: `enter` is the same value arriving,
 * and the open/closing/close lanes are stream lifecycle rather than data
 * (observed live in P0 — they carry `data: null`).
 */
export function harvestOutputs(events: readonly ExecutionEvent[]): CheckpointOutputs {
  const outputs: CheckpointOutputs = {};
  for (const e of events) {
    if (e.op !== 'leave') continue;
    if (!isPayloadLane(e.lane)) continue;
    if (e.output === undefined) continue;
    outputs[outputKey(e.nodeId, e.lane as string)] = e.output;
  }
  return outputs;
}

/**
 * Extract the plain text a node emitted, for the detector's second channel
 * (the `**LLM error**` marker) and for verifiers.
 */
export function extractText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const parts = value.filter((v): v is string => typeof v === 'string');
    return parts.length > 0 ? parts.join('\n') : undefined;
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    for (const key of ['text', 'answers', 'content', 'output', 'result']) {
      const found = extractText(obj[key]);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}
