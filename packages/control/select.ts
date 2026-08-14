/**
 * Composes the selection pipeline into a single state-machine input.
 *
 *   POLICY  -> what is permitted & possible
 *   BUDGET  -> what is affordable, ranked
 *   GATE    -> what is SAFE            <- always last, never bypassable
 *
 * The ordering is deliberate and enforced here rather than left to callers:
 * the gate runs LAST and unconditionally, so no combination of generous
 * budget or permissive policy can produce a proposal that skipped it. The
 * gate is also the only place a `PermittedProposal` can be constructed, so
 * the state machine literally cannot accept anything that bypassed this
 * function's final step.
 */
import { passGate } from '../core/gate.ts';
import type {
  BudgetRejection,
  FailureClass,
  RecoveryBudget,
  RecoveryContract,
} from '../core/types.ts';
import type { MachineInput } from '../core/machine-types.ts';
import { filterAndRank } from './budget.ts';
import type { PriceTable } from './estimate.ts';
import { selectCandidates, type AutopilotConfig, type NodeContext } from './policy.ts';

export interface SelectionTrace {
  failureClass: FailureClass;
  considered: number;
  permitted: number;
  rejections: BudgetRejection[];
}

export interface SelectionOutcome {
  input: MachineInput;
  trace: SelectionTrace;
}

export function selectRecovery(
  config: AutopilotConfig,
  prices: PriceTable,
  failureClass: FailureClass,
  node: NodeContext,
  budget: RecoveryBudget,
  contracts: ReadonlyMap<string, RecoveryContract>,
): SelectionOutcome {
  // 1. POLICY — what the developer allows, and what this node makes possible.
  const { candidates, inapplicable } = selectCandidates(config, prices, failureClass, node);
  const rejections: BudgetRejection[] = inapplicable.map(({ action, reason }) => ({
    action,
    reason,
  }));

  // 2. BUDGET — affordability across all five dimensions, then ranking.
  const { affordable, rejections: budgetRejections } = filterAndRank(
    candidates,
    budget,
    config.ranking_weights,
  );
  rejections.push(...budgetRejections);

  // 3. GATE — safety. Last, unconditional, and the sole source of the brand.
  const { permitted, rejections: gateRejections } = passGate(affordable, contracts);
  rejections.push(...gateRejections);

  const trace: SelectionTrace = {
    failureClass,
    considered: candidates.length,
    permitted: permitted.length,
    rejections,
  };

  if (permitted.length === 0) {
    return {
      input: {
        kind: 'NO_RECOVERY_AVAILABLE',
        reason: summariseWhyNothing(failureClass, rejections),
        rejections,
      },
      trace,
    };
  }

  return { input: { kind: 'PROPOSALS_READY', proposals: permitted, rejections }, trace };
}

function summariseWhyNothing(failureClass: FailureClass, rejections: BudgetRejection[]): string {
  if (rejections.length === 0) {
    return `no recovery strategy is configured for failure class ${failureClass}`;
  }
  const blocked = rejections.find((r) => r.reason.startsWith('blocked:'));
  if (blocked) return blocked.reason;
  return `no permitted recovery remained for ${failureClass}: ${rejections
    .map((r) => `${r.action} (${r.reason})`)
    .join('; ')}`;
}
