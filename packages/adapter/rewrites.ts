/**
 * Strategy → JSON diff.
 *
 * This is where "recovery is a deterministic data transformation" stops being
 * a claim and becomes code. Every recovery strategy is a small, printable
 * mutation of the pipeline document — provider fallback is literally one
 * field. No model is consulted; the diff can be inspected, tested and
 * reviewed like any other data change.
 *
 * Returns a human-readable diff so the demo can show exactly what changed.
 */
import type { PipelineRewrite } from '../core/types.ts';
import { findComponent, type PipelineConfig } from './pipeline.ts';

/**
 * The engine's `llm_openai_api` node nests its real settings under
 * `config.custom` (profile-based schema, confirmed against getServices() in
 * P0). Model and base_url swaps therefore have to reach inside it rather than
 * patching the top level.
 */
function patchModelConfig(
  config: Record<string, unknown>,
  key: string,
  value: unknown,
): boolean {
  const custom = config.custom;
  if (custom && typeof custom === 'object') {
    (custom as Record<string, unknown>)[key] = value;
    return true;
  }
  config[key] = value;
  return false;
}

export function applyRewrite(pipeline: PipelineConfig, rewrite: PipelineRewrite): string[] {
  const target = findComponent(pipeline, rewrite.targetNodeId);
  if (!target) {
    throw new Error(
      `rewrite targets "${rewrite.targetNodeId}" which is not in the residual pipeline`,
    );
  }

  const diff: string[] = [];

  // A whole-component replacement (capability substitution): the node keeps
  // its id and wiring, but becomes a different implementation entirely.
  if (rewrite.providerReplacement) {
    const before = target.provider;
    target.provider = rewrite.providerReplacement;
    diff.push(`${target.id}.provider: "${before}" -> "${rewrite.providerReplacement}"`);
  }

  if (rewrite.configPatch) {
    for (const [key, value] of Object.entries(rewrite.configPatch)) {
      if (value === undefined || value === null) continue;

      if (key === 'model' || key === 'base_url') {
        const nested = patchModelConfig(target.config, key, value);
        const before =
          nested && target.config.custom && typeof target.config.custom === 'object'
            ? undefined
            : target.config[key];
        diff.push(
          `${target.id}.config${nested ? '.custom' : ''}.${key} -> ${JSON.stringify(value)}` +
            (before === undefined ? '' : ` (was ${JSON.stringify(before)})`),
        );
        continue;
      }

      const before = target.config[key];
      target.config[key] = value;
      diff.push(
        `${target.id}.config.${key}: ${JSON.stringify(before)} -> ${JSON.stringify(value)}`,
      );
    }
  }

  if (diff.length === 0) {
    diff.push(`${target.id}: re-run unchanged (retry)`);
  }

  return diff;
}
