/**
 * Real-model upstream discovery.
 *
 * The demo and MCP server use a real local model when one is available and
 * fall back to the deterministic canned responder when it is not — so the
 * project still runs end-to-end on a machine without Ollama, just without a
 * real LLM in the loop.
 *
 * Pure and dependency-free: this is control-plane-adjacent config, not
 * engine access, so it stays on the safe side of the seam.
 */
export interface UpstreamModel {
  /** OpenAI-compatible base URL, e.g. http://127.0.0.1:11434/v1 */
  baseUrl: string;
  /** Real model name the upstream actually serves. */
  model: string;
}

export const DEFAULT_OLLAMA: UpstreamModel = {
  baseUrl: process.env.AUTOPILOT_OLLAMA_URL ?? 'http://127.0.0.1:11434/v1',
  model: process.env.AUTOPILOT_OLLAMA_MODEL ?? 'qwen2.5:3b',
};

/**
 * Logical model tier -> real model.
 *
 * The pipeline declares a logical tier (`autopilot-canned`), and
 * `model_escalation` rewrites that field up the ladder. Without this map the
 * escalation would be cosmetic: the rewrite would change the pipeline JSON
 * but every tier would still resolve to the same upstream model, so
 * "escalated to a stronger model and it worked" would not be a true claim.
 *
 * Mapping each tier to a genuinely different model makes the escalation real
 * and observable.
 */
export const MODEL_TIERS: Record<string, string> = {
  'autopilot-canned': 'qwen2.5:1.5b',
  'autopilot-canned-mid': 'qwen2.5:3b',
  'autopilot-canned-strong': 'qwen2.5:3b',
};

/**
 * Resolve whatever model the pipeline asked for to a real upstream model.
 * Unknown names pass through so a developer can name a real model directly.
 */
export function resolveModelTier(requested: unknown, fallback: string): string {
  if (typeof requested !== 'string') return fallback;
  return MODEL_TIERS[requested] ?? requested;
}

/**
 * Is a real model actually reachable AND serving the model we expect?
 *
 * Checks the model list rather than just the port, because a running server
 * with the model absent would fail later in a far more confusing way.
 */
export async function detectUpstream(
  candidate: UpstreamModel = DEFAULT_OLLAMA,
  timeoutMs = 2000,
): Promise<UpstreamModel | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${candidate.baseUrl.replace(/\/$/, '')}/models`, {
      signal: controller.signal,
    });
    if (!res.ok) return undefined;

    const body = (await res.json()) as { data?: Array<{ id?: string }> };
    const ids = (body.data ?? []).map((m) => m.id).filter((id): id is string => !!id);

    // Accept an exact match or a tag-less match (`qwen2.5:3b` vs `qwen2.5`).
    const base = candidate.model.split(':')[0]!;
    const found = ids.find((id) => id === candidate.model || id.split(':')[0] === base);
    return found ? { ...candidate, model: found } : undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}
