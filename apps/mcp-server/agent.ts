/**
 * The agent that sits behind the MCP tools.
 *
 * This is a REAL agentic pipeline — webhook → prompt → LLM → response, running
 * on a live RocketRide engine against a real local model. Autopilot wraps it
 * so that when it fails, the MCP caller receives a recovered result instead of
 * an error, or an honest escalation when recovery is not permitted.
 */
import path from 'node:path';
import { startFaultProxy } from '../../packages/chaos/proxy.ts';
import { detectUpstream, type UpstreamModel } from '../../packages/chaos/upstream.ts';
import { EngineClient } from '../../packages/adapter/client.ts';
import { createLlmClassifier } from '../../packages/adapter/llm-diagnoser.ts';
import { loadConfig, loadPrices } from '../../packages/control/config.ts';
import type { AutopilotConfig } from '../../packages/control/policy.ts';
import type { PriceTable } from '../../packages/control/estimate.ts';
import type { PipelineConfig } from '../../packages/adapter/pipeline.ts';
import type { RecoveryContract, VerifierSpec } from '../../packages/core/types.ts';
import { runWithAutopilot, type RunOutcome } from '../../packages/orchestrator/orchestrator.ts';
import type { FaultProfile } from '../../packages/chaos/schedule.ts';

const ROOT = path.resolve(import.meta.dirname, '..', '..');

const CUSTOMER_RECORDS = `Customer records:
- CUSTOMER-4471: name="Dana Whitfield", balance=128.40 USD, status=active
- CUSTOMER-4472: name="Amir Haddad", balance=0.00 USD, status=closed
- CUSTOMER-4473: name="Lena Ortiz", balance=982.15 USD, status=active`;

export interface AgentRuntime {
  config: AutopilotConfig;
  prices: PriceTable;
  client: EngineClient;
  primaryUrl: string;
  secondaryUrl: string;
  upstream?: UpstreamModel;
  nextGeneration: () => void;
  resetGeneration: () => void;
  close: () => Promise<void>;
}

/**
 * Boot everything the tools need, once, and keep it warm.
 *
 * Pipeline instantiation costs ~10.9s against ~28ms for execution (measured),
 * so a per-call setup would make every tool call unusably slow. The MCP
 * server is long-lived, so we pay that cost at startup instead.
 */
export async function startAgentRuntime(seed = 42): Promise<AgentRuntime> {
  const config = loadConfig(path.join(ROOT, 'autopilot.config.yaml'));
  const prices = loadPrices(path.join(ROOT, 'prices.json'));
  const upstream = await detectUpstream();
  const forward = upstream ? { forwardTo: upstream.baseUrl, forwardModel: upstream.model } : {};

  // The endpoint that faults, and a genuinely healthy one to fail over to.
  const primary = await startFaultProxy({
    seed,
    nodeId: 'reason',
    profile: { provider_unavailable: 1.0 },
    faultAttempts: [0], // transient: the recovery attempt succeeds
    taskIdOf: () => 'mcp',
    respond: () => 'CUSTOMER-4471 balance is 128.40 USD',
    ...forward,
  });

  const secondary = await startFaultProxy({
    seed,
    nodeId: 'reason',
    profile: {},
    taskIdOf: () => 'mcp-secondary',
    respond: () => 'CUSTOMER-4471 balance is 128.40 USD',
    ...forward,
  });

  const client = new EngineClient({ runId: 'mcp-server' });
  await client.connect();

  return {
    config,
    prices,
    client,
    primaryUrl: primary.url,
    secondaryUrl: secondary.url,
    upstream,
    nextGeneration: () => {
      primary.nextGeneration();
      secondary.nextGeneration();
    },
    resetGeneration: () => {
      primary.resetGeneration();
      secondary.resetGeneration();
    },
    close: async () => {
      await client.releaseAll();
      await client.disconnect();
      await primary.close();
      await secondary.close();
    },
  };
}

function agentPipeline(baseUrl: string, nodeId: string, instructions: string[]): PipelineConfig {
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
            model: 'autopilot-canned', // logical tier; resolved by the proxy
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

export interface ToolRun {
  outcome: RunOutcome;
  /** True when the caller is receiving a genuine answer. */
  succeeded: boolean;
}

async function runTool(
  rt: AgentRuntime,
  opts: {
    taskId: string;
    input: string;
    nodeId: string;
    instructions: string[];
    contracts: Map<string, RecoveryContract>;
    verifier?: VerifierSpec;
    isToolNode?: boolean;
    faults?: FaultProfile;
  },
): Promise<ToolRun> {
  rt.resetGeneration();

  const outcome = await runWithAutopilot(opts.taskId, opts.input, {
    config: rt.config,
    prices: rt.prices,
    contracts: opts.contracts,
    pipeline: agentPipeline(rt.primaryUrl, opts.nodeId, opts.instructions),
    watchNodeId: opts.nodeId,
    isToolNode: opts.isToolNode,
    verifier: opts.verifier,
    providerEndpoints: { primary: rt.primaryUrl, secondary: rt.secondaryUrl },
    onBeforeRecoveryRun: rt.nextGeneration,
    sharedClient: rt.client,
    // The LLM diagnoser — itself a RocketRide pipeline — is consulted only
    // when the deterministic rules cannot classify the failure.
    llmClassifier: rt.upstream
      ? createLlmClassifier({
          baseUrl: rt.upstream.baseUrl,
          model: rt.upstream.model,
          client: rt.client,
        })
      : undefined,
  });

  return { outcome, succeeded: outcome.firstPassOk || outcome.recovered };
}

/** The recoverable tool: fails, self-heals, caller sees success. */
export function customerLookup(rt: AgentRuntime, customerId: string): Promise<ToolRun> {
  return runTool(rt, {
    taskId: `lookup-${customerId}`,
    input: `What is the balance for ${customerId}?`,
    nodeId: 'reason',
    instructions: [
      CUSTOMER_RECORDS,
      'Answer using ONLY the records above.',
      'Reply in one short sentence and always include the customer id verbatim.',
    ],
    contracts: new Map([['reason', { nodeId: 'reason', sideEffect: 'NONE', retryable: true }]]),
    verifier: { type: 'expected_field', value: customerId },
  });
}

/**
 * The tool that must NOT self-heal.
 *
 * `charge_customer` is declared IRREVERSIBLE_WRITE, so when it fails the gate
 * refuses every recovery strategy and the caller gets an honest escalation.
 * Returning a fabricated success here would be worse than no harness at all.
 */
export function chargeCustomer(
  rt: AgentRuntime,
  customerId: string,
  amount: number,
): Promise<ToolRun> {
  return runTool(rt, {
    taskId: `charge-${customerId}`,
    input: `Charge ${customerId} $${amount.toFixed(2)}.`,
    nodeId: 'payment',
    isToolNode: true,
    instructions: [
      CUSTOMER_RECORDS,
      'Confirm the charge in one short sentence, including the customer id.',
    ],
    contracts: new Map([
      ['payment', { nodeId: 'payment', sideEffect: 'IRREVERSIBLE_WRITE', retryable: false }],
    ]),
  });
}
