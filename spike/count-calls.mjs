// How many HTTP calls does ONE logical LLM invocation actually make?
// Measuring rather than guessing — the answer drives fault scoping.
import { RocketRideClient } from 'rocketride';
import { createServer } from 'node:http';

const calls = [];
const server = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    let parsed = {};
    try { parsed = JSON.parse(body); } catch {}
    calls.push({ index: calls.length, url: req.url, stream: parsed.stream });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'x', object: 'chat.completion', created: 1, model: 'm',
      choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/v1`;

const pipeline = {
  version: 1, source: 'in',
  components: [
    { id: 'in', provider: 'webhook', config: { hideForm: true, mode: 'Source', type: 'webhook', parameters: {} } },
    { id: 'ask', provider: 'prompt', config: { type: 'prompt', instructions: ['Answer.'] }, input: [{ lane: 'text', from: 'in' }] },
    { id: 'reason', provider: 'llm_openai_api', config: { profile: 'custom', custom: { model: 'm', base_url: url, apikey: 'k', modelTotalTokens: 4096 } }, input: [{ lane: 'questions', from: 'ask' }] },
    { id: 'out', provider: 'response_answers', config: { laneName: 'answers' }, input: [{ lane: 'answers', from: 'reason' }] },
  ],
};

const client = new RocketRideClient({ uri: 'ws://localhost:5565', auth: 'autopilot-local-dev' });
await client.connect();
const { token } = await client.use({ pipeline, threads: 1, name: 'count-calls' });
await client.send(token, 'hello', undefined, 'text/plain');
await client.terminate(token);
await client.disconnect();
server.close();

console.log(`TOTAL HTTP CALLS for one logical invocation: ${calls.length}`);
console.log(JSON.stringify(calls, null, 2));
