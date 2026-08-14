/** Inputs, effects and state for the control-loop reducer. */
import type {
  BudgetRejection,
  FailureClass,
  FailureSignal,
  PermittedProposal,
  Phase,
  RecoveryAttempt,
  RecoveryBudget,
  VerificationResult,
} from './types.ts';

export interface MachineState {
  phase: Phase;
  runId: string;
  failedNodeId?: string;
  signal?: FailureSignal;
  failureClass?: FailureClass;
  /** Remaining ranked candidates, already budget-filtered and gate-approved. */
  queue: PermittedProposal[];
  current?: PermittedProposal;
  budget: RecoveryBudget;
  history: RecoveryAttempt[];
  /** Every rejected candidate with its reason — a demo asset, not a debug log. */
  rejections: BudgetRejection[];
  outcome?: { kind: 'RECOVERED' | 'ESCALATED' | 'DEGRADED'; reason?: string };
}

export type MachineInput =
  | { kind: 'FAILURE_DETECTED'; signal: FailureSignal }
  | { kind: 'DIAGNOSED'; failureClass: FailureClass }
  | { kind: 'PROPOSALS_READY'; proposals: PermittedProposal[]; rejections?: BudgetRejection[] }
  | { kind: 'NO_RECOVERY_AVAILABLE'; reason: string; rejections?: BudgetRejection[] }
  | {
      kind: 'RECOVERY_EXECUTED';
      ok: boolean;
      costUsd: number;
      latencyMs: number;
      tokens: number;
      detail?: string;
    }
  | { kind: 'VERIFIED'; result: VerificationResult };

export type Effect =
  | { kind: 'DIAGNOSE'; signal: FailureSignal }
  | { kind: 'SELECT_RECOVERY'; failureClass: FailureClass; budget: RecoveryBudget }
  | { kind: 'EXECUTE_RECOVERY'; proposal: PermittedProposal }
  | { kind: 'VERIFY'; proposal: PermittedProposal }
  | { kind: 'ESCALATE'; reason: string }
  | { kind: 'TRACE'; entry: Record<string, unknown> };
