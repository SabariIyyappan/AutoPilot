/**
 * The BUDGET engine — affordability and ranking.
 *
 * Two responsibilities, in order:
 *   1. FILTER on all five budget dimensions (cost, latency, tokens, attempts,
 *      risk). Anything that doesn't fit is rejected WITH ITS REASON.
 *   2. RANK the survivors by expected value per unit of budget spent.
 *
 * Every rejection carries a human-readable reason — "full_replan rejected:
 * $0.14 > $0.10 remaining" is a product feature that makes the demo legible,
 * not a debug line.
 */
import { RISK_ORDER, type BudgetRejection, type RecoveryBudget, type RecoveryProposal } from '../core/types.ts';

export interface RankingWeights {
  cost: number;
  latency: number;
  risk: number;
}

export interface BudgetResult {
  affordable: RecoveryProposal[];
  rejections: BudgetRejection[];
}

function money(n: number): string {
  return `$${n.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')}`;
}

export function filterByBudget(
  proposals: readonly RecoveryProposal[],
  budget: RecoveryBudget,
): BudgetResult {
  const affordable: RecoveryProposal[] = [];
  const rejections: BudgetRejection[] = [];

  if (budget.remainingAttempts <= 0) {
    for (const p of proposals) {
      rejections.push({ action: p.action, reason: 'attempt budget exhausted (0 remaining)' });
    }
    return { affordable, rejections };
  }

  for (const p of proposals) {
    if (p.expectedCostUsd > budget.remainingCostUsd) {
      rejections.push({
        action: p.action,
        reason: `${money(p.expectedCostUsd)} > ${money(budget.remainingCostUsd)} remaining cost budget`,
      });
      continue;
    }
    if (p.expectedLatencyMs > budget.remainingLatencyMs) {
      rejections.push({
        action: p.action,
        reason: `${p.expectedLatencyMs}ms > ${budget.remainingLatencyMs}ms remaining latency budget`,
      });
      continue;
    }
    if (p.expectedTokens > budget.remainingTokens) {
      rejections.push({
        action: p.action,
        reason: `${p.expectedTokens} tokens > ${budget.remainingTokens} remaining token budget`,
      });
      continue;
    }
    if (RISK_ORDER[p.risk] > RISK_ORDER[budget.maxRisk]) {
      rejections.push({
        action: p.action,
        reason: `risk ${p.risk} exceeds permitted maximum ${budget.maxRisk}`,
      });
      continue;
    }
    affordable.push(p);
  }

  return { affordable, rejections };
}

/**
 * score = successPrior / (w_cost*normCost + w_latency*normLatency + w_risk*riskWeight)
 *
 * Normalised against the remaining budget so "expensive" means expensive
 * *relative to what's left*, not in absolute terms. A $0.04 strategy is cheap
 * with $1.00 left and prohibitive with $0.05 left.
 */
export function score(
  p: RecoveryProposal,
  budget: RecoveryBudget,
  weights: RankingWeights,
): number {
  const normCost = budget.remainingCostUsd > 0 ? p.expectedCostUsd / budget.remainingCostUsd : 0;
  const normLatency =
    budget.remainingLatencyMs > 0 ? p.expectedLatencyMs / budget.remainingLatencyMs : 0;
  const riskWeight = RISK_ORDER[p.risk] / 2; // LOW=0, MEDIUM=0.5, HIGH=1

  const denominator =
    weights.cost * normCost + weights.latency * normLatency + weights.risk * riskWeight;

  // A free, instant, zero-risk strategy has an undefined ratio — rank it top.
  if (denominator <= 0) return Number.POSITIVE_INFINITY;
  return p.successPrior / denominator;
}

export function rank(
  proposals: readonly RecoveryProposal[],
  budget: RecoveryBudget,
  weights: RankingWeights,
): RecoveryProposal[] {
  return [...proposals].sort((a, b) => {
    const diff = score(b, budget, weights) - score(a, budget, weights);
    // Stable tie-break so ranking is fully deterministic for the benchmark.
    if (diff !== 0) return diff;
    return a.action.localeCompare(b.action);
  });
}

export function filterAndRank(
  proposals: readonly RecoveryProposal[],
  budget: RecoveryBudget,
  weights: RankingWeights,
): BudgetResult {
  const { affordable, rejections } = filterByBudget(proposals, budget);
  return { affordable: rank(affordable, budget, weights), rejections };
}
