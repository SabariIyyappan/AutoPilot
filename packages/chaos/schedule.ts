/**
 * Deterministic, seeded fault schedule.
 *
 * `fault(seed, taskId, nodeId, attemptIndex)` is a pure function: same inputs,
 * same output, forever. This is what makes the four-baseline benchmark fair
 * rather than merely repeated — every mode sees byte-identical faults at
 * `attemptIndex = 0`, and only recovery attempts (`attemptIndex > 0`) can
 * diverge between modes.
 *
 * No engine dependency. Faults are injected by the local proxy/MCP server
 * (packages/chaos/proxy.ts, mcp-server.ts) consulting this module — never by
 * the adapter after the fact (see docs/architecture.md's determinism model
 * for why post-hoc corruption at the adapter boundary is wrong).
 */

export type FaultType =
  | 'provider_500'
  | 'provider_429'
  | 'provider_unavailable' // maps to a non-retryable HTTP 401 — see docs/architecture.md
  | 'mcp_timeout'
  | 'tool_unavailable'
  | 'invalid_json'
  | 'schema_drift'
  | 'stale_context';

/**
 * Probability per fault type. FROZEN before P4 — see docs/architecture.md.
 *
 * Deliberately `Partial<Record<FaultType, number>>`, not an open string
 * index — every key is a real `FaultType`, so `fault()` below never needs an
 * unsound cast to return one.
 */
export type FaultProfile = Partial<Record<FaultType, number>>;

/**
 * Faults an LLM-node pipeline can actually experience. The benchmark uses
 * this rather than DEFAULT_PROFILE: injecting `mcp_timeout` into an endpoint
 * that has no MCP tool would produce a meaningless error rather than the
 * failure mode it names. Tool faults belong to a tool pipeline (scenario B).
 *
 * FROZEN before P4 — tuning a fault profile after seeing recovery results is
 * exactly how benchmarks become dishonest.
 */
export const LLM_PROFILE: FaultProfile = Object.freeze({
  provider_500: 0.08,
  provider_429: 0.04,
  provider_unavailable: 0.03,
  invalid_json: 0.08,
  schema_drift: 0.07,
});

export const DEFAULT_PROFILE: FaultProfile = Object.freeze({
  provider_500: 0.05,
  provider_429: 0.03,
  provider_unavailable: 0.02,
  mcp_timeout: 0.1,
  tool_unavailable: 0.03,
  invalid_json: 0.08,
  schema_drift: 0.04,
  stale_context: 0.04,
});

/**
 * FNV-1a — small, dependency-free, and stable across Node versions. We need
 * determinism and distribution, not cryptographic strength.
 */
function hash32(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Maps a hash to [0, 1) uniformly. */
function unitInterval(h: number): number {
  return h / 0xffffffff;
}

/**
 * Decide whether (and which) fault fires for one call.
 *
 * Deterministic total order over fault types (Object.keys of the profile,
 * sorted) so the same roll always lands on the same fault when several
 * probabilities are in play — no dependency on object key insertion order
 * surviving a JSON round-trip.
 */
export function fault(
  seed: number,
  taskId: string,
  nodeId: string,
  attemptIndex: number,
  profile: FaultProfile = DEFAULT_PROFILE,
): FaultType | null {
  const key = `${seed}:${taskId}:${nodeId}:${attemptIndex}`;
  const roll = unitInterval(hash32(key));

  const types = (Object.keys(profile) as FaultType[]).sort();
  let cumulative = 0;
  for (const type of types) {
    cumulative += profile[type] ?? 0;
    if (roll < cumulative) return type;
  }
  return null;
}

/** Convenience: does this fault type retry internally inside the engine? */
export function isEngineRetried(type: FaultType): boolean {
  return type === 'provider_500' || type === 'provider_429';
}
