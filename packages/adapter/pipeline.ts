/**
 * RocketRide `.pipe` document types and graph mapping.
 *
 * Deliberately declared structurally here rather than imported from the
 * `rocketride` SDK, so that residual.ts / rewrites.ts stay pure and
 * unit-testable with no engine and no SDK. `client.ts` is the only file that
 * actually talks to the SDK.
 *
 * Shapes verified against the SDK's own typings in P0
 * (node_modules/rocketride/dist/types/types/pipeline.d.ts).
 */
import type { GraphNode } from '../core/graph.ts';

export interface PipelineInputConnection {
  lane: string;
  from: string;
}

export interface PipelineControlConnection {
  classType: string;
  from: string;
}

export interface PipelineComponent {
  id: string;
  provider: string;
  name?: string;
  description?: string;
  config: Record<string, unknown>;
  input?: PipelineInputConnection[];
  control?: PipelineControlConnection[];
}

export interface PipelineConfig {
  description?: string;
  version?: number;
  components: PipelineComponent[];
  /** Entry-point component id. Required for the engine to schedule anything. */
  source?: string;
  project_id?: string;
}

/** Map a pipeline document onto the pure graph model used by core/graph.ts. */
export function toGraph(pipeline: PipelineConfig): GraphNode[] {
  return pipeline.components.map((c) => ({
    id: c.id,
    inputs: (c.input ?? []).map((i) => i.from),
    control: (c.control ?? []).map((c2) => c2.from),
  }));
}

export function findComponent(
  pipeline: PipelineConfig,
  id: string,
): PipelineComponent | undefined {
  return pipeline.components.find((c) => c.id === id);
}

/**
 * Providers whose execution is free and deterministic — pure transforms with
 * no model call, no network, no side effect.
 *
 * This matters for residual synthesis: there is no point caching the output
 * of a node that costs nothing to recompute. Re-running these is strictly
 * simpler than plumbing their cached values back in, and it is *cheaper* than
 * the alternative, not a compromise. See residual.ts.
 */
export const FREE_PROVIDERS = new Set([
  'prompt',
  'question',
  'webhook',
  'response_text',
  'response_answers',
  'response_documents',
  'response_questions',
  'response_table',
]);

export function isFreeToReplay(component: PipelineComponent): boolean {
  return FREE_PROVIDERS.has(component.provider);
}

/** Deep clone via structured JSON. Pipelines are plain JSON by definition. */
export function clonePipeline(p: PipelineConfig): PipelineConfig {
  return JSON.parse(JSON.stringify(p)) as PipelineConfig;
}
