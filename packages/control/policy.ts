/**
 * Recovery POLICY — which strategies is the developer willing to allow for
 * this failure class, given what's actually available in this pipeline?
 *
 * Pure: it takes an already-parsed config object, so it stays unit-testable
 * with no filesystem and no YAML. `loadConfig` (config.ts) does the I/O.
 *
 * Policy answers "what is permitted and possible". It does NOT decide
 * affordability (budget.ts) or safety (core/gate.ts). Keeping those three
 * separate is what makes each one independently verifiable.
 */
import type { FailureClass, RecoveryAction, RecoveryProposal } from '../core/types.ts';
import type { PriceTable } from './estimate.ts';
import { estimate, nextModel, nextProvider } from './estimate.ts';

export interface AutopilotConfig {
  budget: {
    extra_cost_usd: number;
    extra_latency_ms: number;
    extra_tokens: number;
    attempts: number;
    max_risk: 'LOW' | 'MEDIUM' | 'HIGH';
  };
  policy: Partial<Record<FailureClass, RecoveryAction[]>>;
  forbidden: string[];
  ranking_weights: { cost: number; latency: number; risk: number };
}

/** What the failing node actually is, which constrains what's possible. */
export interface NodeContext {
  nodeId: string;
  /** Model currently configured, for model_escalation / cost estimation. */
  model: string;
  /** Provider currently configured, for provider_fallback. */
  provider: string;
  /** Declared capability tag, if any — required for capability_swap. */
  capability?: string;
  /** Other registered node providers satisfying the same capability. */
  capabilityAlternatives?: string[];
  /** Tokens the failed attempt consumed. */
  priorTokens: number;
  /**
   * Provider name -> concrete endpoint URL.
   *
   * For `llm_openai_api`, provider identity IS the `base_url` — there is no
   * separate "provider" field the engine honours (confirmed against the node
   * schema in P0). So a provider fallback has to rewrite the endpoint, not a
   * label, or it changes nothing.
   */
  providerEndpoints?: Record<string, string>;
}

/**
 * Strategies that cannot apply to a given node, regardless of policy. Returning
 * a *reason* rather than silently dropping keeps the trace explainable — the
 * demo shows why each option was or wasn't on the table.
 */
function inapplicableReason(
  action: RecoveryAction,
  node: NodeContext,
  prices: PriceTable,
): string | null {
  switch (action) {
    case 'provider_fallback':
      return nextProvider(prices, node.provider) === null
        ? `no fallback provider after "${node.provider}" in the declared ladder`
        : null;
    case 'model_escalation':
      return nextModel(prices, node.model) === null
        ? `"${node.model}" is already at the top of the declared model ladder`
        : null;
    case 'capability_swap':
      if (!node.capability) return `node "${node.nodeId}" declares no capability tag`;
      if (!node.capabilityAlternatives?.length) {
        return `no alternative implementation registered for capability "${node.capability}"`;
      }
      return null;
    default:
      return null;
  }
}

export interface PolicyResult {
  candidates: RecoveryProposal[];
  /** Strategies the policy allowed but the node made impossible. */
  inapplicable: Array<{ action: RecoveryAction; reason: string }>;
}

export function selectCandidates(
  config: AutopilotConfig,
  prices: PriceTable,
  failureClass: FailureClass,
  node: NodeContext,
): PolicyResult {
  const allowed = config.policy[failureClass] ?? [];
  const candidates: RecoveryProposal[] = [];
  const inapplicable: Array<{ action: RecoveryAction; reason: string }> = [];

  for (const action of allowed) {
    const reason = inapplicableReason(action, node, prices);
    if (reason) {
      inapplicable.push({ action, reason });
      continue;
    }

    const est = estimate(prices, action, { model: node.model, priorTokens: node.priorTokens });
    candidates.push({
      action,
      nodeId: node.nodeId,
      expectedCostUsd: est.expectedCostUsd,
      expectedLatencyMs: est.expectedLatencyMs,
      expectedTokens: est.expectedTokens,
      risk: est.risk,
      successPrior: est.successPrior,
      rewrite: buildRewrite(action, node, prices),
    });
  }

  return { candidates, inapplicable };
}

/**
 * The deterministic JSON diff for each strategy — the core "recovery is a
 * data transformation" claim. No LLM decides any of this.
 */
function buildRewrite(action: RecoveryAction, node: NodeContext, prices: PriceTable) {
  switch (action) {
    case 'retry':
      return { targetNodeId: node.nodeId, description: 're-run the node unchanged' };
    case 'provider_fallback': {
      const next = nextProvider(prices, node.provider);
      const endpoint = next ? node.providerEndpoints?.[next] : undefined;
      return {
        targetNodeId: node.nodeId,
        description: `swap provider ${node.provider} -> ${next}`,
        // Rewrite the real endpoint when one is declared; fall back to a
        // label only when no endpoint map was supplied.
        configPatch: endpoint ? { base_url: endpoint } : { provider: next },
      };
    }
    case 'model_escalation': {
      const next = nextModel(prices, node.model);
      return {
        targetNodeId: node.nodeId,
        description: `escalate model ${node.model} -> ${next}`,
        configPatch: { model: next },
      };
    }
    case 'capability_swap': {
      const alt = node.capabilityAlternatives?.[0];
      return {
        targetNodeId: node.nodeId,
        description: `substitute capability "${node.capability}" with ${alt}`,
        providerReplacement: alt,
      };
    }
    case 'output_repair':
      return {
        targetNodeId: node.nodeId,
        description: 'prepend a repair pass over the malformed output',
        configPatch: { repair: true },
      };
    case 'retrieval_refresh':
      return {
        targetNodeId: node.nodeId,
        description: 'widen retrieval and bust the cache',
        configPatch: { refresh: true },
      };
    case 'escalate':
      return { targetNodeId: node.nodeId, description: 'escalate to a human' };
    default: {
      const _exhaustive: never = action;
      throw new Error(`unhandled action: ${String(_exhaustive)}`);
    }
  }
}
