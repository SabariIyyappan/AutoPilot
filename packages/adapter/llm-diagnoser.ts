/**
 * The LLM diagnoser — implemented as a RocketRide pipeline.
 *
 * When the deterministic rules cannot classify a failure, we hand the trace to
 * a small local model and ask it to pick one of the eight failure classes.
 * That classification runs through **RocketRide itself**: we use the platform
 * to diagnose the platform's own failures.
 *
 *   webhook(trace) → prompt(classification rules) → llm_openai_api → response
 *
 * This file lives in `adapter/` because it touches the engine. The contract it
 * satisfies (`LlmClassifier`) is declared in `packages/diagnosis/`, which stays
 * pure — see the seam note there.
 *
 * ── Trust model ───────────────────────────────────────────────────────────
 * The model's output is parsed, not obeyed. `parseFailureClass` accepts only
 * an unambiguous, whole-token match against the enum; prose, invented classes,
 * multiple classes, or empty output all become `undefined` → `UNKNOWN` →
 * escalate. A model may inform a diagnosis; it may never widen what recovery
 * is permitted.
 */
import {
  parseFailureClass,
  type LlmClassifier,
  type LlmDiagnosisInput,
} from '../diagnosis/diagnoser.ts';
import { EngineClient } from './client.ts';
import { extractText } from './normalize.ts';
import type { PipelineConfig } from './pipeline.ts';

export interface LlmDiagnoserOptions {
  /** OpenAI-compatible endpoint of the diagnosing model. */
  baseUrl: string;
  model: string;
  /** Reuse the orchestrator's connected client and its pipeline cache. */
  client: EngineClient;
  /** Abort a diagnosis that takes too long — never block a run on it. */
  timeoutMs?: number;
}

/**
 * Deterministic instruction set. `temperature: 0` plus a constrained,
 * single-token answer format is what keeps this as reproducible as a model
 * can be.
 */
function classificationInstructions(input: LlmDiagnosisInput): string[] {
  return [
    'You are a failure classifier for an AI pipeline runtime.',
    'Classify the failure below into EXACTLY ONE of these classes:',
    input.allowedClasses.join(', '),
    '',
    'Rules:',
    '- Reply with the class name ONLY. No prose, no punctuation, no explanation.',
    '- If the evidence is insufficient or ambiguous, reply exactly: UNKNOWN',
    '- Never invent a class that is not in the list above.',
    '',
    `Failing node: ${input.nodeId}`,
    `Node kind: ${input.isToolNode ? 'external tool / MCP' : 'LLM'}`,
    `Signal type: ${input.signalType}`,
    'Evidence:',
    ...input.evidence.map((e) => `  - ${e}`),
  ];
}

export function buildDiagnosisPipeline(
  opts: Pick<LlmDiagnoserOptions, 'baseUrl' | 'model'>,
  instructions: string[],
): PipelineConfig {
  return {
    description: 'Autopilot failure classifier — diagnoses RocketRide failures using RocketRide.',
    version: 1,
    source: 'in',
    components: [
      {
        id: 'in',
        provider: 'webhook',
        name: 'trace',
        config: { hideForm: true, mode: 'Source', type: 'webhook', parameters: {} },
      },
      {
        id: 'classify',
        provider: 'prompt',
        name: 'classify',
        config: { type: 'prompt', instructions },
        input: [{ lane: 'text', from: 'in' }],
      },
      {
        id: 'diagnoser',
        provider: 'llm_openai_api',
        name: 'diagnoser',
        config: {
          profile: 'custom',
          custom: {
            model: opts.model,
            base_url: opts.baseUrl,
            apikey: 'unused-local-key',
            modelTotalTokens: 2048,
            // Classification, not creativity.
            temperature: 0,
          },
        },
        input: [{ lane: 'questions', from: 'classify' }],
      },
      {
        id: 'out',
        provider: 'response_answers',
        name: 'out',
        config: { laneName: 'answers' },
        input: [{ lane: 'answers', from: 'diagnoser' }],
      },
    ],
  };
}

/** Build a classifier backed by a real RocketRide pipeline. */
export function createLlmClassifier(opts: LlmDiagnoserOptions): LlmClassifier {
  return async (input) => {
    const pipeline = buildDiagnosisPipeline(opts, classificationInstructions(input));

    const timeout = new Promise<undefined>((resolve) =>
      setTimeout(() => resolve(undefined), opts.timeoutMs ?? 45_000),
    );

    const run = (async () => {
      const result = await opts.client.runCached(
        pipeline,
        `Classify this failure for node ${input.nodeId}.`,
        'autopilot-diagnoser',
      );
      if (!result.ok) return undefined;
      return parseFailureClass(extractText(result.result));
    })();

    // Whichever finishes first. A slow diagnoser degrades to UNKNOWN rather
    // than stalling the recovery it was meant to accelerate.
    return Promise.race([run, timeout]);
  };
}
