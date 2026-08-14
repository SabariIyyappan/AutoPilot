/**
 * Export the scenario pipelines as real .pipe files.
 *
 * Autopilot builds pipelines programmatically (they're just JSON), but they
 * are ordinary RocketRide documents — so you can open these in the VS Code
 * extension and see the nodes and wiring on the canvas.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'pipelines');
mkdirSync(OUT, { recursive: true });

const PLACEHOLDER = 'http://127.0.0.1:PORT/v1';

function llmPipeline(nodeId, description) {
  return {
    description,
    version: 1,
    source: 'in',
    components: [
      {
        id: 'in',
        provider: 'webhook',
        name: 'input',
        config: { hideForm: true, mode: 'Source', type: 'webhook', parameters: {} },
      },
      {
        id: 'ask',
        provider: 'prompt',
        name: 'ask',
        config: { type: 'prompt', instructions: ['Answer the customer question precisely.'] },
        input: [{ lane: 'text', from: 'in' }],
      },
      {
        id: nodeId,
        provider: 'llm_openai_api',
        name: nodeId,
        config: {
          profile: 'custom',
          custom: {
            model: 'autopilot-canned',
            // Swap this for a real provider and the pipeline is unchanged
            // otherwise — that is the whole point of provider portability.
            base_url: PLACEHOLDER,
            apikey: 'unused-local-key',
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
        input: [{ lane: 'answers', from: nodeId }],
      },
    ],
  };
}

const files = {
  'scenario-a-provider-fallback.pipe': llmPipeline(
    'reason',
    'Scenario A — provider failure. base_url points at the primary endpoint; recovery rewrites it to a healthy secondary.',
  ),
  'scenario-c-schema-repair.pipe': llmPipeline(
    'reason',
    'Scenario C — schema drift. Same shape as A; the failure is in the CONTENT, caught by a verifier.',
  ),
  'scenario-d-irreversible-write.pipe': llmPipeline(
    'payment',
    'Scenario D — the node is named `payment` and declared IRREVERSIBLE_WRITE in contracts, so the gate refuses to replay it.',
  ),
};

for (const [name, pipeline] of Object.entries(files)) {
  writeFileSync(path.join(OUT, name), JSON.stringify(pipeline, null, 2));
  console.log(`  ${name}`);
}

console.log(`\nWrote ${Object.keys(files).length} pipelines to pipelines/`);
console.log('Open any of them in the RocketRide VS Code extension to see the canvas.\n');
console.log(`NOTE: base_url is "${PLACEHOLDER}" — at runtime Autopilot injects the`);
console.log('live chaos-proxy port. Point it at a real provider to use a real model.\n');
