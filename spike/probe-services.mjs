// Enumerate every registered component/service so we can pick REAL provider
// names instead of guessing from doc prose. Answers Q2 (literal/constant node)
// and grounds the demo pipeline's node choices.
import { RocketRideClient } from 'rocketride';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const fixturesDir = path.resolve(import.meta.dirname, '..', 'fixtures');
mkdirSync(fixturesDir, { recursive: true });

const client = new RocketRideClient({ uri: 'ws://localhost:5565', auth: 'autopilot-spike-dev-key' });

await client.connect();
const services = await client.getServices();
writeFileSync(path.join(fixturesDir, 'services.json'), JSON.stringify(services, null, 2));

const names = Object.keys(services).sort();
console.log(`total services: ${names.length}`);
console.log(names.join('\n'));

await client.disconnect();
