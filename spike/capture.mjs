// P0 recon spike: connect to a live RocketRide engine, run hello.pipe with
// pipelineTraceLevel:'full', subscribe to flow/summary events, and dump
// everything raw to fixtures/ so we can answer Q1-Q4 from real data.
import { RocketRideClient } from 'rocketride';
import { readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.resolve(__dirname, '..', 'fixtures');
mkdirSync(fixturesDir, { recursive: true });
const rawPath = path.join(fixturesDir, 'raw-events.jsonl');
writeFileSync(rawPath, ''); // truncate

const pipelineFile = process.argv[2] || 'hello.pipe';
const pipeline = JSON.parse(readFileSync(path.join(__dirname, pipelineFile), 'utf8'));

const frames = [];
function record(kind, payload) {
  const line = JSON.stringify({ t: Date.now(), kind, payload });
  frames.push(line);
  appendFileSync(rawPath, line + '\n');
}

const client = new RocketRideClient({
  uri: 'ws://localhost:5565',
  auth: 'autopilot-spike-dev-key', // ROCKETRIDE_APIKEY is unset server-side, so
  // ai/account/oss auth accepts any non-empty credential (see ai/account/oss/__init__.py).
  onEvent: (evt) => record('event', evt),
  onConnected: () => console.log('[spike] connected'),
  onDisconnected: (reason) => console.log('[spike] disconnected:', reason),
});

try {
  await client.connect();

  const useResult = await client.use({
    pipeline,
    threads: 1,
    pipelineTraceLevel: 'full',
    name: 'p0-spike',
  });
  record('use-result', useResult);
  const { token } = useResult;
  console.log('[spike] task token:', token);

  await client.setEvents(token, ['flow', 'summary', 'task', 'output']);

  const sendResult = await client.send(token, 'hello from the spike', undefined, 'text/plain');
  record('send-result', sendResult);
  console.log('[spike] send result:', JSON.stringify(sendResult, null, 2));

  // Give async flow/summary events a moment to arrive after send() resolves.
  await new Promise((r) => setTimeout(r, 2000));

  const status = await client.getTaskStatus(token);
  record('task-status', status);
  console.log('[spike] task status:', JSON.stringify(status, null, 2));

  // --- Q2: enumerate registered services/components for a literal/constant provider ---
  const services = await client.getServices();
  writeFileSync(
    path.join(fixturesDir, 'services.json'),
    JSON.stringify(services, null, 2)
  );
  const names = Object.keys(services).sort();
  console.log('[spike] service count:', names.length);
  console.log('[spike] candidates for literal/constant node:',
    names.filter(n => /literal|const|static|value|passthrough|set|echo/i.test(n)));
  console.log('[spike] full service list written to fixtures/services.json');

  await client.terminate(token);
} catch (err) {
  record('error', { message: err?.message, stack: err?.stack });
  console.error('[spike] ERROR:', err);
  process.exitCode = 1;
} finally {
  await client.disconnect();
  writeFileSync(path.join(fixturesDir, 'raw-events.jsonl'), frames.join('\n') + '\n');
  console.log(`[spike] wrote ${frames.length} frames to ${rawPath}`);
}
