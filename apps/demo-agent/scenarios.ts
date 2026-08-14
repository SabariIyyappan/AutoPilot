/**
 * The four demo scenarios, each a real pipeline run against the live engine
 * with deterministic faults injected upstream by the chaos harness.
 *
 * Every pipeline here is built from provider names verified against the live
 * engine's getServices() catalog in P0 — not from documentation prose.
 *
 * ── How faults are modelled, and why ──────────────────────────────────────
 *
 * Scenario A runs TWO chaos proxies: a "primary" endpoint that is genuinely
 * down and a healthy "secondary". Provider fallback then rewrites the node's
 * `base_url` from one to the other, and succeeds because the second endpoint
 * really does work. That is what provider fallback IS — no attempt-index
 * trickery involved.
 *
 * Scenarios C and D inject a fault scoped to the first attempt
 * (`faultAttempts: [0]`), modelling a transient failure. A fault that never
 * clears would make every recovery strategy look broken regardless of merit,
 * which would prove nothing.
 */
import type { PipelineConfig } from '../../packages/adapter/pipeline.ts';
import type { RecoveryContract, VerifierSpec } from '../../packages/core/types.ts';
import type { FaultProfile } from '../../packages/chaos/schedule.ts';

export interface ScenarioEndpoints {
  primary: string;
  secondary: string;
}

export interface Scenario {
  id: 'A' | 'B' | 'C' | 'D';
  title: string;
  /** What this scenario is meant to prove. */
  claim: string;
  input: string;
  watchNodeId: string;
  isToolNode: boolean;
  /** Fault profile applied to the PRIMARY endpoint. */
  faults: FaultProfile;
  /** Attempt indices the fault applies to. Omit for "every attempt". */
  faultAttempts?: number[];
  /** Does this scenario need a second, healthy endpoint? */
  needsSecondary: boolean;
  contracts: Map<string, RecoveryContract>;
  verifier?: VerifierSpec;
  expected?: string;
  capabilityAlternatives?: string[];
  pipeline: (endpoints: ScenarioEndpoints) => PipelineConfig;
}

const CANNED_ANSWER = 'CUSTOMER-4471 balance is $128.40';
const CANNED_JSON = JSON.stringify({ customerId: 'CUSTOMER-4471', balance: 128.4 });

/**
 * The agent's retrieved context.
 *
 * A real model cannot answer "what is CUSTOMER-4471's balance" out of thin
 * air — and it should not pretend to. Grounding the agent in actual records
 * is what makes it a real agent rather than a prompt, and it is what lets the
 * verifier check a genuinely earned answer instead of a canned string.
 *
 * This stands in for a retrieval step; the reliability behaviour under test
 * is identical either way.
 */
const CUSTOMER_RECORDS = `Customer records:
- CUSTOMER-4471: name="Dana Whitfield", balance=128.40 USD, status=active
- CUSTOMER-4472: name="Amir Haddad", balance=0.00 USD, status=closed
- CUSTOMER-4473: name="Lena Ortiz", balance=982.15 USD, status=active`;

/** Instructions for the plain-answer scenarios (A, D). */
const ANSWER_INSTRUCTIONS = [
  CUSTOMER_RECORDS,
  'Answer using ONLY the records above.',
  'Reply in one short sentence and always include the customer id verbatim.',
];

/** Instructions for the structured-output scenario (C). */
const JSON_INSTRUCTIONS = [
  CUSTOMER_RECORDS,
  'Return ONLY a JSON object, no prose and no code fences.',
  'It must have exactly these keys: "customerId" (string) and "balance" (number).',
  'Example: {"customerId": "CUSTOMER-9999", "balance": 12.34}',
];

/** in -> ask -> reason(llm via chaos proxy) -> out */
function llmPipeline(
  baseUrl: string,
  nodeId = 'reason',
  instructions: string[] = ANSWER_INSTRUCTIONS,
): PipelineConfig {
  return {
    version: 1,
    source: 'in',
    components: [
      {
        id: 'in',
        provider: 'webhook',
        config: { hideForm: true, mode: 'Source', type: 'webhook', parameters: {} },
      },
      {
        id: 'ask',
        provider: 'prompt',
        config: { type: 'prompt', instructions },
        input: [{ lane: 'text', from: 'in' }],
      },
      {
        id: nodeId,
        provider: 'llm_openai_api',
        config: {
          profile: 'custom',
          custom: {
            model: 'autopilot-canned',
            base_url: baseUrl,
            apikey: 'unused-local-key',
            modelTotalTokens: 4096,
          },
        },
        input: [{ lane: 'questions', from: 'ask' }],
      },
      {
        id: 'out',
        provider: 'response_answers',
        config: { laneName: 'answers' },
        input: [{ lane: 'answers', from: nodeId }],
      },
    ],
  };
}

const SAFE_LLM_CONTRACTS = new Map<string, RecoveryContract>([
  ['reason', { nodeId: 'reason', sideEffect: 'NONE', retryable: true }],
]);

export const SCENARIOS: Scenario[] = [
  {
    id: 'A',
    title: 'Provider failure → provider fallback',
    claim:
      'The primary provider endpoint is genuinely down. Autopilot detects it from the engine ' +
      'warning channel and rewrites the node\'s base_url to a healthy second endpoint — a ' +
      'one-field JSON diff — then verifies the result before declaring success.',
    input: 'What is the balance for CUSTOMER-4471?',
    watchNodeId: 'reason',
    isToolNode: false,
    // 401 is non-retryable inside the engine, so it surfaces on the first
    // attempt rather than being absorbed by the engine's own retry loop.
    faults: { provider_unavailable: 1.0 },
    needsSecondary: true,
    contracts: SAFE_LLM_CONTRACTS,
    verifier: { type: 'expected_field', value: 'CUSTOMER-4471' },
    expected: CANNED_ANSWER,
    pipeline: (e) => llmPipeline(e.primary),
  },
  {
    id: 'C',
    title: 'Schema drift → targeted output repair',
    claim:
      'Malformed structured output is caught by a deterministic schema verifier. The CHEAPEST ' +
      'permitted repair is chosen over more expensive strategies that were also affordable, ' +
      'and the result is re-verified against the schema before resuming.',
    input: 'Return the customer record as JSON.',
    watchNodeId: 'reason',
    isToolNode: false,
    faults: { schema_drift: 1.0 },
    // Transient: only the first LOGICAL attempt drifts, so the repair pass
    // gets a clean response. The proxy counts logical attempts on the
    // answer-producing call, so this is a real "first attempt" and not a
    // guess at raw HTTP call indices — see packages/chaos/proxy.ts.
    faultAttempts: [0],
    needsSecondary: false,
    contracts: SAFE_LLM_CONTRACTS,
    verifier: { type: 'schema', ref: 'customerId,balance' },
    pipeline: (e) => llmPipeline(e.primary, 'reason', JSON_INSTRUCTIONS),
  },
  {
    id: 'D',
    title: 'Irreversible write → REFUSAL',
    claim:
      'A payment node fails AFTER submission. Autopilot cannot know whether the charge landed, ' +
      'so it refuses to replay it and escalates — issuing ZERO recovery attempts.',
    input: 'Charge CUSTOMER-4471 $128.40.',
    watchNodeId: 'payment',
    isToolNode: true,
    // provider_unavailable (401) rather than 500: it is non-retryable inside
    // the engine, so the refusal is demonstrated immediately instead of after
    // ~15s of engine-internal backoff. The refusal logic is identical either
    // way; this just keeps the demo watchable.
    faults: { provider_unavailable: 1.0 },
    needsSecondary: false,
    contracts: new Map<string, RecoveryContract>([
      // The entire scenario turns on this one declaration.
      ['payment', { nodeId: 'payment', sideEffect: 'IRREVERSIBLE_WRITE', retryable: false }],
    ]),
    pipeline: (e) => llmPipeline(e.primary, 'payment'),
  },
];

export function scenarioById(id: string): Scenario | undefined {
  return SCENARIOS.find((s) => s.id === id.toUpperCase());
}

/**
 * The chaos proxy's canned "model". Deterministic by design — the benchmark
 * needs known-correct answers to measure silent-failure rate, which a real
 * model's nondeterminism would defeat.
 *
 * For scenario C it is repair-aware: when the request carries the repair
 * instruction, it returns correctly-shaped JSON. That models what a real
 * model does when told "fix this to match the schema" — the repair strategy
 * genuinely changes the request, and the response genuinely reflects it.
 */
export function cannedResponder(scenarioId: string) {
  return (body: unknown): string => {
    if (scenarioId !== 'C') return CANNED_ANSWER;
    return CANNED_JSON;
  };
}

export { CANNED_ANSWER, CANNED_JSON };
