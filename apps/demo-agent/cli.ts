/**
 * `autopilot run --scenario X --seed N`
 *
 * The primary demo interface. Runs one scenario end to end against the LIVE
 * RocketRide engine with deterministic faults injected upstream, and prints
 * the recovery timeline: what failed, what was considered, what was rejected
 * and why, what JSON diff was applied, and whether it verified.
 */
import path from 'node:path';
import { startFaultProxy } from '../../packages/chaos/proxy.ts';
import { budgetFromConfig, loadConfig, loadPrices } from '../../packages/control/config.ts';
import { runWithAutopilot } from '../../packages/orchestrator/orchestrator.ts';
import { scenarioById, SCENARIOS, cannedResponder } from './scenarios.ts';

const ROOT = path.resolve(import.meta.dirname, '..', '..');

const C = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
};

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

async function main() {
  const scenarioId = arg('scenario');
  const seed = Number(arg('seed', '42'));

  if (!scenarioId) {
    console.log(C.bold('\nAutopilot — available scenarios\n'));
    for (const s of SCENARIOS) {
      console.log(`  ${C.cyan(s.id)}  ${s.title}`);
      console.log(`     ${C.dim(s.claim)}\n`);
    }
    console.log(C.dim('  usage: autopilot run --scenario A --seed 42\n'));
    return;
  }

  const scenario = scenarioById(scenarioId);
  if (!scenario) {
    console.error(C.red(`unknown scenario "${scenarioId}"`));
    process.exit(1);
  }

  const config = loadConfig(path.join(ROOT, 'autopilot.config.yaml'));
  const prices = loadPrices(path.join(ROOT, 'prices.json'));
  const budget = budgetFromConfig(config);

  // PRIMARY endpoint — the one that faults. Real HTTP, real failures, $0.
  const primary = await startFaultProxy({
    seed,
    nodeId: scenario.watchNodeId,
    profile: scenario.faults,
    faultAttempts: scenario.faultAttempts,
    taskIdOf: () => `scenario-${scenario.id}`,
    respond: cannedResponder(scenario.id),
  });

  // SECONDARY endpoint — genuinely healthy. Provider fallback rewrites the
  // node's base_url to this, and succeeds because it really does work.
  const secondary = scenario.needsSecondary
    ? await startFaultProxy({
        seed,
        nodeId: scenario.watchNodeId,
        profile: {}, // never faults
        taskIdOf: () => `scenario-${scenario.id}-secondary`,
        respond: cannedResponder(scenario.id),
      })
    : undefined;

  const endpoints = { primary: primary.url, secondary: secondary?.url ?? primary.url };

  console.log(C.bold(`\n━━━ SCENARIO ${scenario.id}: ${scenario.title} ━━━\n`));
  console.log(`${C.dim('claim')}   ${scenario.claim}\n`);
  console.log(`${C.dim('seed')}    ${seed}`);
  console.log(`${C.dim('faults')}  ${JSON.stringify(scenario.faults)}`);
  console.log(
    `${C.dim('budget')}  $${budget.remainingCostUsd} / ${budget.remainingLatencyMs}ms / ` +
      `${budget.remainingAttempts} attempts / max risk ${budget.maxRisk}\n`,
  );

  try {
    const outcome = await runWithAutopilot(`scenario-${scenario.id}`, scenario.input, {
      config,
      prices,
      contracts: scenario.contracts,
      pipeline: scenario.pipeline(endpoints),
      watchNodeId: scenario.watchNodeId,
      isToolNode: scenario.isToolNode,
      verifier: scenario.verifier,
      expected: scenario.expected,
      capabilityAlternatives: scenario.capabilityAlternatives,
      providerEndpoints: { primary: endpoints.primary, secondary: endpoints.secondary },
      onBeforeRecoveryRun: () => {
        primary.nextGeneration();
        secondary?.nextGeneration();
      },
    });

    printTimeline(outcome);
  } finally {
    await primary.close();
    await secondary?.close();
  }
}

function printTimeline(o: Awaited<ReturnType<typeof runWithAutopilot>>) {
  console.log(C.bold('TIMELINE\n'));

  for (const t of o.trace) {
    switch (t.event) {
      case 'first_pass':
        console.log(`  ${C.dim('1.')} first pass          ${t.ok ? 'completed' : 'failed'} ${C.dim(`(${t.latencyMs}ms)`)}`);
        break;
      case 'failure_detected': {
        const ev = (t.evidence as Array<{ kind: string; detail: string }>) ?? [];
        const status = ev.find((e) => e.kind === 'http_status')?.detail;
        console.log(`  ${C.dim('2.')} ${C.red('FAILURE DETECTED')}    ${t.type}${status ? ` (HTTP ${status})` : ''}`);
        break;
      }
      case 'diagnosed':
        console.log(`  ${C.dim('3.')} diagnosed           ${C.yellow(String(t.failureClass))}`);
        break;
      case 'selection': {
        console.log(`  ${C.dim('4.')} considered ${t.considered} strateg${t.considered === 1 ? 'y' : 'ies'}, ${t.permitted} permitted`);
        for (const r of (t.rejections as Array<{ action: string; reason: string }>) ?? []) {
          console.log(`       ${C.red('✗')} ${r.action.padEnd(20)} ${C.dim(r.reason)}`);
        }
        break;
      }
      case 'recovery_attempt':
        console.log(`  ${C.dim('5.')} ${C.cyan('RECOVERY')}            ${t.action}`);
        console.log(`       ${C.dim(`gate: ${t.gateReason}`)}`);
        break;
      case 'residual_synthesized': {
        console.log(`       ${C.dim('pipeline diff:')}`);
        for (const d of (t.diff as string[]) ?? []) console.log(`         ${C.green(d)}`);
        const skipped = (t.skipped as string[]) ?? [];
        if (skipped.length) console.log(`       ${C.dim(`skipped (already succeeded): ${skipped.join(', ')}`)}`);
        break;
      }
      case 'synthesis_refused':
        console.log(`       ${C.red('synthesis refused')} ${C.dim(String(t.detail))}`);
        break;
      case 'verified':
        console.log(`  ${C.dim('6.')} verifier ${t.verifier}      ${t.passed ? C.green('PASS') : C.red('FAIL')} ${C.dim(String(t.detail))}`);
        break;
      case 'first_pass_verified':
        console.log(`  ${C.dim('2.')} verifier ${t.verifier}      ${t.passed ? C.green('PASS') : C.red('FAIL')}`);
        break;
    }
  }

  console.log(C.bold('\nOUTCOME\n'));
  const verdict = o.recovered
    ? C.green('RECOVERED')
    : o.escalated
      ? C.yellow('ESCALATED')
      : C.dim(o.phase);
  console.log(`  status              ${verdict}`);
  console.log(`  recovery attempts   ${o.attempts}`);
  console.log(`  recovery cost       $${o.totalCostUsd.toFixed(4)}`);
  console.log(`  total latency       ${o.totalLatencyMs}ms`);
  if (o.finalText) console.log(`  final answer        ${C.dim(o.finalText.slice(0, 80))}`);

  // Only claim "refusal" when the gate ACTUALLY blocked on a side effect —
  // an escalation for any other reason (unknown diagnosis, exhausted budget)
  // is a different outcome and must not be dressed up as one.
  const blockedBySideEffect = o.rejections.some((r) => /IRREVERSIBLE_WRITE/.test(r.reason));
  if (o.escalated && o.attempts === 0 && blockedBySideEffect) {
    console.log(
      `\n  ${C.bold(C.yellow('This is the refusal.'))} Zero attempts were issued — Autopilot declined\n` +
        `  to act rather than risk replaying an irreversible side effect.`,
    );
  }
  console.log('');
}

main().catch((err) => {
  console.error(C.red(`\nfailed: ${err instanceof Error ? err.message : String(err)}\n`));
  process.exit(1);
});
