/**
 * Drive the MCP server over real stdio JSON-RPC, exactly as Claude Desktop
 * does. Proves the tools work end to end without needing a GUI client.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

const child = spawn(
  process.execPath,
  ['--experimental-strip-types', path.join(ROOT, 'apps', 'mcp-server', 'server.ts')],
  { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] },
);

child.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));

let buffer = '';
const pending = new Map();

child.stdout.on('data', (d) => {
  buffer += d.toString();
  let nl;
  while ((nl = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      const resolve = pending.get(msg.id);
      if (resolve) {
        pending.delete(msg.id);
        resolve(msg);
      }
    } catch {
      // non-JSON line; ignore
    }
  }
});

let nextId = 1;
function rpc(method, params, timeoutMs = 300_000) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout: ${method}`)), timeoutMs);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
}

const line = (s) => console.log(`\n${'━'.repeat(64)}\n${s}\n${'━'.repeat(64)}`);

try {
  await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'autopilot-smoke', version: '1.0.0' },
  });
  notify('notifications/initialized', {});

  const tools = await rpc('tools/list', {});
  line('TOOLS EXPOSED');
  for (const t of tools.result.tools) console.log(`  ${t.name.padEnd(18)} ${t.title ?? ''}`);

  // ── The recoverable tool ────────────────────────────────────────────────
  line('CALL 1 — customer_lookup  (should FAIL internally, then SELF-HEAL)');
  const lookup = await rpc('tools/call', {
    name: 'customer_lookup',
    arguments: { customerId: 'CUSTOMER-4471' },
  });
  const lookupPayload = JSON.parse(lookup.result.content[0].text);
  console.log(JSON.stringify(lookupPayload, null, 2));

  // ── The tool that must refuse ───────────────────────────────────────────
  line('CALL 2 — charge_customer  (irreversible: must REFUSE and escalate)');
  const charge = await rpc('tools/call', {
    name: 'charge_customer',
    arguments: { customerId: 'CUSTOMER-4471', amount: 128.4 },
  });
  const chargePayload = JSON.parse(charge.result.content[0].text);
  console.log(JSON.stringify(chargePayload, null, 2));

  // ── Assertions ──────────────────────────────────────────────────────────
  line('VERDICT');
  const checks = [
    ['lookup returned an answer to the caller', lookupPayload.succeeded === true],
    ['lookup actually failed internally first', lookupPayload._autopilot.failureDetected !== null],
    ['lookup recovered', lookupPayload._autopilot.status === 'RECOVERED'],
    ['lookup shows a real pipeline diff', (lookupPayload._autopilot.pipelineDiff ?? []).length > 0],
    ['charge did NOT fabricate success', chargePayload.succeeded === false],
    ['charge issued ZERO recovery attempts', chargePayload._autopilot.recoveryAttempts === 0],
    ['charge flagged for human review', chargePayload.requiresHumanReview === true],
    [
      'charge was blocked by the side-effect gate',
      (chargePayload._autopilot.rejected ?? []).some((r) => /IRREVERSIBLE_WRITE/.test(r)),
    ],
  ];

  let failed = 0;
  for (const [label, ok] of checks) {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
    if (!ok) failed++;
  }
  console.log(`\n${failed === 0 ? 'ALL CHECKS PASSED' : `${failed} CHECK(S) FAILED`}\n`);
  child.kill();
  process.exit(failed === 0 ? 0 : 1);
} catch (err) {
  console.error(`\nsmoke failed: ${err.message}\n`);
  child.kill();
  process.exit(1);
}
