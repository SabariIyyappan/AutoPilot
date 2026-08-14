/**
 * The side-effect gate. This is the ONLY place a `PermittedProposal` can be
 * constructed (the brand field is only assignable here), so an executor can
 * never run for a node whose safety hasn't been checked — not by convention,
 * by construction.
 *
 * NONE / read        -> retry freely
 * IDEMPOTENT_WRITE    -> retry with idempotency key
 * REVERSIBLE_WRITE     -> compensate, then retry
 * IRREVERSIBLE_WRITE  -> never autonomously replay -> escalate, 0 attempts issued
 */
import {
  defaultContract,
  GATE_BRAND,
  type BudgetRejection,
  type PermittedProposal,
  type RecoveryContract,
  type RecoveryProposal,
} from './types.ts';

export interface GateResult {
  permitted: PermittedProposal[];
  rejections: BudgetRejection[];
}

function isMutating(action: RecoveryProposal['action']): boolean {
  // retry, provider_fallback, model_escalation, capability_swap, output_repair,
  // retrieval_refresh all cause the target node to run again — i.e. they are
  // all re-executions of whatever the node itself does. retrieval_refresh /
  // output_repair / capability_swap / provider_fallback / model_escalation are
  // read-shaped by construction in this project (LLM calls, tool calls, repairs).
  // 'escalate' performs no node re-execution at all.
  return action !== 'escalate';
}

export function passGate(
  proposals: readonly RecoveryProposal[],
  contracts: ReadonlyMap<string, RecoveryContract>,
): GateResult {
  const permitted: PermittedProposal[] = [];
  const rejections: BudgetRejection[] = [];

  for (const proposal of proposals) {
    const contract = contracts.get(proposal.nodeId) ?? defaultContract(proposal.nodeId);

    if (proposal.action === 'escalate') {
      permitted.push(brand(proposal, 'escalation always permitted — no node re-execution'));
      continue;
    }

    if (!isMutating(proposal.action)) {
      permitted.push(brand(proposal, 'non-mutating action'));
      continue;
    }

    switch (contract.sideEffect) {
      case 'NONE':
        permitted.push(brand(proposal, 'side effect NONE — safe to retry freely'));
        break;
      case 'IDEMPOTENT_WRITE':
        permitted.push(brand(proposal, 'side effect IDEMPOTENT_WRITE — safe with idempotency key'));
        break;
      case 'REVERSIBLE_WRITE':
        permitted.push(brand(proposal, 'side effect REVERSIBLE_WRITE — compensator required before retry'));
        break;
      case 'IRREVERSIBLE_WRITE':
        rejections.push({
          action: proposal.action,
          reason: `blocked: "${proposal.nodeId}" is IRREVERSIBLE_WRITE — autonomous recovery refused`,
        });
        break;
      default: {
        const _exhaustive: never = contract.sideEffect;
        throw new Error(`unhandled side effect: ${_exhaustive}`);
      }
    }
  }

  return { permitted, rejections };
}

function brand(proposal: RecoveryProposal, gateReason: string): PermittedProposal {
  const permitted = { ...proposal, gateReason, [GATE_BRAND]: true as const };
  return Object.freeze(permitted);
}
