// P2 live smoke test: prove a chaos-proxy fault reaches the real engine as a
// real apaevt_flow error, and that the no-fault path returns the canned text.
// This is the "a fault visibly reaching the engine" exit criterion for P2.
import { RocketRideClient } from 'rocketride';
import { startFaultProxy } from '../packages/chaos/proxy.ts';

async function runOnce(label, profile) {
  const proxy = await startFaultProxy({
    seed: 42,
    nodeId: 'reason',
    profile,
    taskIdOf: () => 'smoke-task',
    respond: () => 'AUTOPILOT_SMOKE_TEST_OK',
  });

  const pipeline = {
    version: 1,
    source: 'in',
    components: [
      { id: 'in', provider: 'webhook', name: 'input', config: { hideForm: true, mode: 'Source', type: 'webhook', parameters: {} } },
      {
        id: 'ask',
        provider: 'prompt',
        name: 'ask',
        config: { type: 'prompt', instructions: ['Answer the question.'] },
        input: [{ lane: 'text', from: 'in' }],
      },
      {
        id: 'reason',
        provider: 'llm_openai_api',
        name: 'reason',
        config: {
          profile: 'custom',
          custom: {
            model: 'autopilot-smoke',
            base_url: proxy.url,
            apikey: 'unused-dummy-key',
            modelTotalTokens: 4096,
          },
        },
        input: [{ lane: 'questions', from: 'ask' }],
      },
      {
        id: 'out',
        provider: 'response_answers',
        name: 'output',
        config: { laneName: 'answers' },
        input: [{ lane: 'answers', from: 'reason' }],
      },
    ],
  };

  const events = [];
  const client = new RocketRideClient({
    uri: 'ws://localhost:5565',
    auth: 'autopilot-spike-dev-key',
    onEvent: (e) => events.push(e),
  });

  let outcome;
  try {
    await client.connect();
    const { token } = await client.use({ pipeline, threads: 1, name: `smoke-${label}` });
    await client.setEvents(token, ['flow', 'summary']);
    try {
      const result = await client.send(token, 'ping', undefined, 'text/plain');
      outcome = { ok: true, result };
    } catch (err) {
      outcome = { ok: false, error: err?.message ?? String(err) };
    }
    await new Promise((r) => setTimeout(r, 500));
    const status = await client.getTaskStatus(token);
    outcome.status = { errors: status.errors, warnings: status.warnings, failedCount: status.failedCount, exitMessage: status.exitMessage };
    await client.terminate(token);
  } finally {
    await client.disconnect();
    await proxy.close();
  }

  const flowErrors = events
    .filter((e) => e.event === 'apaevt_flow' && e.body?.trace?.error)
    .map((e) => e.body.trace.error);

  console.log(`\n=== ${label} ===`);
  console.log('outcome:', JSON.stringify(outcome).slice(0, 400));
  console.log('apaevt_flow errors observed:', flowErrors.length ? flowErrors : '(none)');
  return { outcome, flowErrors };
}

const noFault = await runOnce('no-fault', {});
const forced500 = await runOnce('forced-provider_500', { provider_500: 1.0 });
const forced401 = await runOnce('forced-provider_unavailable', { provider_unavailable: 1.0 });

console.log('\n=== SUMMARY ===');
console.log('no-fault success text present:', JSON.stringify(noFault.outcome).includes('AUTOPILOT_SMOKE_TEST_OK'));
console.log('provider_500 produced a real engine-visible error:', !forced500.outcome.ok || forced500.flowErrors.length > 0);
console.log('provider_unavailable produced a real engine-visible error:', !forced401.outcome.ok || forced401.flowErrors.length > 0);
