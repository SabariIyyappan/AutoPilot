#!/usr/bin/env node
/**
 * Autopilot MCP Server — the real entry point.
 *
 * A genuine MCP client (Claude Desktop, Claude Code, MCP Inspector) calls a
 * tool. Behind that tool is a real LLM-backed RocketRide pipeline. It fails.
 * Autopilot detects, diagnoses, checks the developer's policy and budget,
 * checks safety, recovers, and verifies — and the caller receives a working
 * answer, never having seen the failure.
 *
 * Except when it must not. `charge_customer` is an irreversible write, so its
 * failure is escalated honestly rather than silently retried.
 *
 * Every response carries an `_autopilot` block so the self-heal is VISIBLE
 * rather than merely invisible — that is what makes this demonstrable.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  chargeCustomer,
  customerLookup,
  startAgentRuntime,
  type AgentRuntime,
  type ToolRun,
} from './agent.ts';

/**
 * Flatten a run into the evidence a caller (or a reviewer) actually wants:
 * what broke, how it was classified and by what, what was rejected and why,
 * and the exact pipeline diff that fixed it.
 */
function autopilotReport(run: ToolRun) {
  const { outcome } = run;
  const t = (event: string) => outcome.trace.find((x) => x.event === event);

  const failure = t('failure_detected');
  const diagnosis = t('diagnosed');
  const selection = t('selection');

  return {
    status: outcome.recovered
      ? 'RECOVERED'
      : outcome.escalated
        ? 'ESCALATED'
        : outcome.firstPassOk
          ? 'OK_FIRST_PASS'
          : outcome.phase,
    failureDetected: failure ? String(failure.type) : null,
    diagnosis: diagnosis ? String(diagnosis.failureClass) : null,
    // 'rules' or 'llm' — shows when the model actually earned its place.
    diagnosedBy: diagnosis ? String(diagnosis.source) : null,
    strategiesConsidered: selection ? Number(selection.considered ?? 0) : 0,
    rejected: outcome.rejections.map((r) => `${r.action}: ${r.reason}`),
    // The core mechanism, made legible: recovery is a JSON diff.
    pipelineDiff: outcome.diffs.flat(),
    recoveryAttempts: outcome.attempts,
    recoveryCostUsd: Number(outcome.totalCostUsd.toFixed(5)),
    totalLatencyMs: outcome.totalLatencyMs,
  };
}

function textResult(payload: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] };
}

async function main() {
  const runtime: AgentRuntime = await startAgentRuntime();

  const server = new McpServer({ name: 'autopilot', version: '1.0.0' });

  server.registerTool(
    'customer_lookup',
    {
      title: 'Look up a customer balance',
      description:
        'Returns a customer balance. The underlying agent pipeline is unreliable; ' +
        'Autopilot detects the failure, recovers, and verifies before answering. ' +
        'The `_autopilot` field reports exactly what happened.',
      inputSchema: { customerId: z.string().describe('e.g. CUSTOMER-4471') },
    },
    async ({ customerId }) => {
      const run = await customerLookup(runtime, customerId);
      return textResult({
        answer: run.succeeded ? (run.outcome.finalText ?? null) : null,
        succeeded: run.succeeded,
        _autopilot: autopilotReport(run),
      });
    },
  );

  server.registerTool(
    'charge_customer',
    {
      title: 'Charge a customer (irreversible)',
      description:
        'Attempts a payment. This node is declared IRREVERSIBLE_WRITE, so if it fails ' +
        'Autopilot REFUSES to retry — it cannot know whether the charge landed — and ' +
        'escalates to a human instead. Demonstrates bounded, safe recovery.',
      inputSchema: {
        customerId: z.string().describe('e.g. CUSTOMER-4471'),
        amount: z.number().describe('amount in USD'),
      },
    },
    async ({ customerId, amount }) => {
      const run = await chargeCustomer(runtime, customerId, amount);
      const report = autopilotReport(run);

      // HONESTY RULE: never dress an unrecovered failure as a success.
      if (!run.succeeded) {
        return textResult({
          succeeded: false,
          error:
            'Payment could not be confirmed and was NOT retried. This operation is ' +
            'irreversible, so Autopilot cannot safely replay it — the charge may or ' +
            'may not have been applied. Escalated for human review.',
          requiresHumanReview: true,
          _autopilot: report,
        });
      }

      return textResult({
        succeeded: true,
        answer: run.outcome.finalText ?? null,
        _autopilot: report,
      });
    },
  );

  const shutdown = async () => {
    await runtime.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // stdio transport: stdout is the protocol channel, so nothing may be
  // printed to it. Diagnostics go to stderr.
  console.error(
    `[autopilot-mcp] ready — model: ${runtime.upstream?.model ?? 'canned (no Ollama detected)'}`,
  );

  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  console.error(`[autopilot-mcp] fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
