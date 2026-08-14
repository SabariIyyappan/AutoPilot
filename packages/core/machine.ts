/**
 * The Autopilot control loop, as a PURE REDUCER.
 *
 *   step(state, input) -> [nextState, Effect[]]
 *
 * It performs no I/O. The orchestrator interprets the effects. This is what
 * makes the entire control plane unit-testable with no engine, no network,
 * and no mocks.
 *
 * Two invariants are enforced structurally here, not by convention:
 *
 *   1. RECOVERED is reachable ONLY from VERIFYING via a passing verifier.
 *      There is exactly one transition into it, and it is guarded.
 *   2. Only `PermittedProposal` (branded by the side-effect gate) can enter
 *      the machine, so an executor can never run for an unsafe node.
 */
import type {
  Effect,
  MachineInput,
  MachineState,
} from './machine-types.ts';
import {
  isPermitted,
  isTerminal,
  type PermittedProposal,
  type RecoveryAttempt,
  type RecoveryProposal,
} from './types.ts';

export class IllegalTransitionError extends Error {
  constructor(phase: string, input: string) {
    super(`Illegal transition: cannot handle "${input}" while in phase "${phase}"`);
    this.name = 'IllegalTransitionError';
  }
}

export function initialState(runId: string, budget: MachineState['budget']): MachineState {
  return {
    phase: 'RUNNING',
    runId,
    queue: [],
    budget,
    history: [],
    rejections: [],
  };
}

/**
 * Runtime companion to the compile-time gate brand (defence in depth).
 *
 * Deliberately typed on the BASE `RecoveryProposal`, not `PermittedProposal`:
 * the caller's static type already claims these are permitted (that's what
 * `MachineInput`'s PROPOSALS_READY variant declares), so narrowing on the
 * branded type would make TS treat the failure branch as unreachable. This
 * check exists precisely for values that violate that static guarantee —
 * forged JSON, a non-TS caller, a future refactor that slips past the gate.
 */
function assertPermitted(proposals: readonly RecoveryProposal[]): asserts proposals is PermittedProposal[] {
  for (const p of proposals) {
    if (!isPermitted(p)) {
      throw new Error(
        `Proposal for "${p.nodeId}" (${p.action}) reached the machine without passing the side-effect gate`,
      );
    }
  }
}

function consume(
  budget: MachineState['budget'],
  costUsd: number,
  latencyMs: number,
  tokens: number,
): MachineState['budget'] {
  return {
    ...budget,
    remainingCostUsd: budget.remainingCostUsd - costUsd,
    remainingLatencyMs: budget.remainingLatencyMs - latencyMs,
    remainingTokens: budget.remainingTokens - tokens,
    remainingAttempts: budget.remainingAttempts - 1,
  };
}

/**
 * Advance to the next queued proposal, or escalate when the queue is empty.
 * Shared by the "recovery failed" and "verification failed" paths so both
 * exhaust candidates identically.
 */
function advanceOrEscalate(
  state: MachineState,
  reason: string,
): [MachineState, Effect[]] {
  const [next, ...rest] = state.queue;

  if (!next) {
    const escalated: MachineState = {
      ...state,
      phase: 'ESCALATED',
      current: undefined,
      queue: [],
      outcome: { kind: 'ESCALATED', reason },
    };
    return [escalated, [{ kind: 'ESCALATE', reason }, { kind: 'TRACE', entry: { event: 'escalated', reason } }]];
  }

  if (state.budget.remainingAttempts <= 0) {
    const escalated: MachineState = {
      ...state,
      phase: 'ESCALATED',
      current: undefined,
      queue: [],
      outcome: { kind: 'ESCALATED', reason: 'attempt budget exhausted' },
    };
    return [
      escalated,
      [
        { kind: 'ESCALATE', reason: 'attempt budget exhausted' },
        { kind: 'TRACE', entry: { event: 'escalated', reason: 'attempt budget exhausted' } },
      ],
    ];
  }

  return [
    { ...state, phase: 'RECOVERING', current: next, queue: rest },
    [{ kind: 'EXECUTE_RECOVERY', proposal: next }],
  ];
}

export function step(state: MachineState, input: MachineInput): [MachineState, Effect[]] {
  if (isTerminal(state.phase)) {
    throw new IllegalTransitionError(state.phase, input.kind);
  }

  switch (state.phase) {
    case 'RUNNING': {
      if (input.kind !== 'FAILURE_DETECTED') {
        throw new IllegalTransitionError(state.phase, input.kind);
      }
      return [
        {
          ...state,
          phase: 'DIAGNOSING',
          failedNodeId: input.signal.nodeId,
          signal: input.signal,
        },
        [
          { kind: 'TRACE', entry: { event: 'failure_detected', nodeId: input.signal.nodeId, type: input.signal.type } },
          { kind: 'DIAGNOSE', signal: input.signal },
        ],
      ];
    }

    case 'DIAGNOSING': {
      if (input.kind === 'DIAGNOSED') {
        // UNKNOWN is a legitimate outcome, and it escalates rather than guessing.
        if (input.failureClass === 'UNKNOWN') {
          const reason = 'failure class UNKNOWN — no targeted recovery is defined';
          return [
            {
              ...state,
              phase: 'ESCALATED',
              failureClass: input.failureClass,
              outcome: { kind: 'ESCALATED', reason },
            },
            [{ kind: 'ESCALATE', reason }, { kind: 'TRACE', entry: { event: 'escalated', reason } }],
          ];
        }
        return [
          { ...state, failureClass: input.failureClass },
          [
            { kind: 'TRACE', entry: { event: 'diagnosed', failureClass: input.failureClass } },
            { kind: 'SELECT_RECOVERY', failureClass: input.failureClass, budget: state.budget },
          ],
        ];
      }

      if (input.kind === 'PROPOSALS_READY') {
        assertPermitted(input.proposals);
        const withRejections: MachineState = {
          ...state,
          queue: [...input.proposals],
          rejections: [...state.rejections, ...(input.rejections ?? [])],
        };
        return advanceOrEscalate(withRejections, 'no affordable recovery remained');
      }

      if (input.kind === 'NO_RECOVERY_AVAILABLE') {
        return [
          {
            ...state,
            phase: 'ESCALATED',
            rejections: [...state.rejections, ...(input.rejections ?? [])],
            outcome: { kind: 'ESCALATED', reason: input.reason },
          },
          [
            { kind: 'ESCALATE', reason: input.reason },
            { kind: 'TRACE', entry: { event: 'escalated', reason: input.reason } },
          ],
        ];
      }

      throw new IllegalTransitionError(state.phase, input.kind);
    }

    case 'RECOVERING': {
      if (input.kind !== 'RECOVERY_EXECUTED') {
        throw new IllegalTransitionError(state.phase, input.kind);
      }
      const current = state.current;
      if (!current) throw new Error('RECOVERING with no current proposal');

      // Budget is consumed whether or not the attempt succeeded — a failed
      // recovery still cost money and time.
      const budget = consume(state.budget, input.costUsd, input.latencyMs, input.tokens);
      const attempt: RecoveryAttempt = {
        action: current.action,
        nodeId: current.nodeId,
        ok: input.ok,
        verified: false,
        costUsd: input.costUsd,
        latencyMs: input.latencyMs,
        tokens: input.tokens,
        detail: input.detail,
      };
      const withAttempt: MachineState = {
        ...state,
        budget,
        history: [...state.history, attempt],
      };

      if (!input.ok) {
        return advanceOrEscalate(
          { ...withAttempt, current: undefined },
          'all recovery strategies failed to execute',
        );
      }

      // Executed successfully — but that is NOT success. It must be verified.
      return [
        { ...withAttempt, phase: 'VERIFYING' },
        [
          { kind: 'TRACE', entry: { event: 'recovery_executed', action: current.action, costUsd: input.costUsd } },
          { kind: 'VERIFY', proposal: current },
        ],
      ];
    }

    case 'VERIFYING': {
      if (input.kind !== 'VERIFIED') {
        throw new IllegalTransitionError(state.phase, input.kind);
      }

      const history = [...state.history];
      const last = history[history.length - 1];
      if (last) history[history.length - 1] = { ...last, verified: input.result.passed };

      if (input.result.passed) {
        // ── INVARIANT 1: the ONLY transition into RECOVERED, and it is
        //    guarded by a passing verifier. There is no other path. ──
        return [
          {
            ...state,
            phase: 'RECOVERED',
            history,
            current: undefined,
            queue: [],
            outcome: { kind: 'RECOVERED' },
          },
          [
            { kind: 'TRACE', entry: { event: 'verified', verifier: input.result.verifier, passed: true } },
            { kind: 'TRACE', entry: { event: 'recovered' } },
          ],
        ];
      }

      return advanceOrEscalate(
        { ...state, history, current: undefined },
        `recovery verification failed: ${input.result.detail}`,
      );
    }

    default:
      throw new IllegalTransitionError(state.phase, input.kind);
  }
}

/** Drive the machine over a sequence of inputs. Convenience for tests. */
export function run(
  state: MachineState,
  inputs: readonly MachineInput[],
): [MachineState, Effect[]] {
  let s = state;
  const all: Effect[] = [];
  for (const i of inputs) {
    const [next, effects] = step(s, i);
    s = next;
    all.push(...effects);
  }
  return [s, all];
}
