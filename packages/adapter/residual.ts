/**
 * RESIDUAL PIPELINE SYNTHESIS — the core mechanism of the whole project.
 *
 * RocketRide has no resume API. But pipelines are portable JSON and
 * `client.use()` accepts an in-memory object, so:
 *
 *     Autopilot does not resume a pipeline. It synthesizes a new one.
 *
 * On failure at node N: keep what already succeeded, rebuild only N and
 * everything downstream, apply the strategy's JSON diff to N, and run that.
 *
 * ── Two P0 findings shape this (docs/architecture.md) ──────────────────────
 *
 * 1. There is no literal/constant component, and a node with no inbound data
 *    edge is NEVER SCHEDULED — even if something downstream references it.
 *    So a residual pipeline must be driven by a real `source`, and cached
 *    values cannot simply be parked in a standalone node.
 *
 * 2. Therefore cached values reach the residual pipeline one of two ways:
 *
 *    (a) RE-RUN FREE UPSTREAM NODES. If a frontier producer is a pure
 *        transform (`prompt`, etc. — see FREE_PROVIDERS), recomputing it is
 *        free and deterministic, so we widen the residual set to include it
 *        rather than plumbing its value back in. This is *cheaper* than
 *        caching, not a workaround: we skip only the expensive upstream work
 *        (LLM calls, tool calls), which is the whole point.
 *
 *    (b) CONFIG SPLICE. For an expensive frontier producer whose value must
 *        be preserved, the cached value is spliced directly into the
 *        consuming node's config at synthesis time (we are generating this
 *        JSON ourselves, so a literal value is just another field).
 *
 * Both are deterministic JSON transformations. No model decides any of it.
 */
import { frontier, residualSet } from '../core/graph.ts';
import type { PipelineRewrite } from '../core/types.ts';
import {
  clonePipeline,
  findComponent,
  isFreeToReplay,
  toGraph,
  type PipelineComponent,
  type PipelineConfig,
} from './pipeline.ts';
import { applyRewrite } from './rewrites.ts';

/** Cached upstream outputs, keyed `${nodeId}:${lane}`. */
export type CheckpointOutputs = Record<string, unknown>;

export function outputKey(nodeId: string, lane: string): string {
  return `${nodeId}:${lane}`;
}

export interface SynthesisInput {
  original: PipelineConfig;
  failedNodeId: string;
  outputs: CheckpointOutputs;
  rewrite: PipelineRewrite;
}

export interface SynthesisResult {
  pipeline: PipelineConfig;
  /** Nodes that were kept (not re-run) because they already succeeded. */
  skipped: string[];
  /** Nodes re-run despite succeeding, because recomputing them is free. */
  replayedFree: string[];
  /** Frontier values spliced into a consumer's config. */
  spliced: Array<{ from: string; to: string; lane: string }>;
  /** A human-readable diff summary — the demo's "recovery is a JSON diff" moment. */
  diff: string[];
}

export class SynthesisError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SynthesisError';
  }
}

/**
 * Widen the residual set upstream through free-to-replay producers, so that
 * frontier edges only ever remain for genuinely expensive nodes.
 */
function widenThroughFreeNodes(
  pipeline: PipelineConfig,
  residual: Set<string>,
): { residual: Set<string>; replayedFree: string[] } {
  const graph = toGraph(pipeline);
  const replayedFree: string[] = [];
  let changed = true;

  while (changed) {
    changed = false;
    for (const edge of frontier(graph, residual)) {
      const producer = findComponent(pipeline, edge.from);
      if (!producer) continue;
      if (!isFreeToReplay(producer)) continue;
      if (residual.has(producer.id)) continue;
      residual.add(producer.id);
      replayedFree.push(producer.id);
      changed = true;
    }
  }

  return { residual, replayedFree };
}

/**
 * Splice a cached value into a consuming component's config.
 *
 * Only `prompt` is supported today — its `instructions: string[]` is a
 * natural, schema-legal place to carry a literal. Anything else throws rather
 * than silently producing a pipeline that would run with missing context: a
 * wrong answer is worse than a refusal, which is the same principle the
 * side-effect gate encodes.
 */
function spliceIntoConfig(consumer: PipelineComponent, lane: string, value: unknown): void {
  if (consumer.provider !== 'prompt') {
    throw new SynthesisError(
      `cannot splice a cached "${lane}" value into a "${consumer.provider}" node ` +
        `("${consumer.id}") — no supported literal slot. Residual synthesis is not ` +
        `possible for this pipeline shape; escalate instead of guessing.`,
    );
  }
  const instructions = Array.isArray(consumer.config.instructions)
    ? [...(consumer.config.instructions as string[])]
    : [];
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  instructions.push(text);
  consumer.config.instructions = instructions;
}

export function synthesizeResidual(input: SynthesisInput): SynthesisResult {
  const { original, failedNodeId, outputs, rewrite } = input;

  if (!findComponent(original, failedNodeId)) {
    throw new SynthesisError(`failed node "${failedNodeId}" is not in the pipeline`);
  }

  // 1. Downstream closure from the failure point (widened across control
  //    groups by core/graph.ts — see Q3 in docs/architecture.md).
  const graph = toGraph(original);
  let residual = residualSet(graph, failedNodeId);

  // 2. Pull in free-to-replay upstream producers.
  const widened = widenThroughFreeNodes(original, new Set(residual));
  residual = widened.residual;

  // 3. Build the new document from the surviving components.
  const next = clonePipeline(original);
  const kept = next.components.filter((c) => residual.has(c.id));
  const skipped = original.components.filter((c) => !residual.has(c.id)).map((c) => c.id);

  // 4. Any remaining frontier edge crosses from an expensive node we are NOT
  //    re-running, so its cached value must be spliced in.
  const spliced: SynthesisResult['spliced'] = [];
  const keptGraph = toGraph({ ...next, components: kept });
  for (const edge of frontier(keptGraph, residual)) {
    const consumer = kept.find((c) => c.id === edge.to);
    if (!consumer) continue;

    const lane =
      (findComponent(original, edge.to)?.input ?? []).find((i) => i.from === edge.from)?.lane ??
      'text';
    const key = outputKey(edge.from, lane);
    if (!(key in outputs)) {
      throw new SynthesisError(
        `no cached output for "${key}" — cannot rebuild the pipeline without it`,
      );
    }

    spliceIntoConfig(consumer, lane, outputs[key]);
    // The edge's producer is gone, so drop the now-dangling connection.
    consumer.input = (consumer.input ?? []).filter((i) => i.from !== edge.from);
    spliced.push({ from: edge.from, to: edge.to, lane });
  }

  next.components = kept;

  // 5. The residual pipeline needs a source that still exists.
  if (!next.source || !residual.has(next.source)) {
    const newSource = kept.find((c) => (c.input ?? []).length === 0);
    if (!newSource) {
      throw new SynthesisError(
        'residual pipeline has no component without inputs to act as source — ' +
          'the engine would never schedule it',
      );
    }
    next.source = newSource.id;
  }

  // 6. Apply the strategy's JSON diff to the failed node. THIS is the recovery.
  const diff = applyRewrite(next, rewrite);

  return { pipeline: next, skipped, replayedFree: widened.replayedFree, spliced, diff };
}
