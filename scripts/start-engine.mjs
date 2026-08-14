/**
 * Start the local RocketRide engine on :5565 and wait until it is accepting
 * connections, so `pnpm demo:*` never races a half-started engine.
 *
 * First boot resolves Python dependencies and can take a few minutes;
 * subsequent boots are seconds because the deps are cached.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SERVER_DIR = path.join(ROOT, '.engine', 'server');
const BINARY = process.platform === 'win32' ? 'engine.exe' : 'engine';
const PORT = 5565;

function portOpen() {
  return new Promise((resolve) => {
    const socket = net
      .connect({ port: PORT, host: '127.0.0.1' })
      .on('connect', () => {
        socket.end();
        resolve(true);
      })
      .on('error', () => resolve(false));
    socket.setTimeout(500, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

async function main() {
  if (await portOpen()) {
    console.log(`\nengine already running on :${PORT}\n`);
    return;
  }

  const binary = path.join(SERVER_DIR, BINARY);
  if (!existsSync(binary)) {
    console.error('\nEngine not installed. Run:  pnpm setup\n');
    process.exit(1);
  }

  console.log(`\nstarting engine on :${PORT}`);
  console.log('(first boot resolves Python deps and may take a few minutes)\n');

  const child = spawn(binary, ['./ai/eaas.py', '--host=0.0.0.0'], {
    cwd: SERVER_DIR,
    stdio: 'inherit',
  });

  child.on('exit', (code) => process.exit(code ?? 0));

  // Report readiness without swallowing the engine's own output.
  const started = Date.now();
  const poll = setInterval(async () => {
    if (await portOpen()) {
      clearInterval(poll);
      console.log(`\n engine ready on :${PORT} after ${((Date.now() - started) / 1000).toFixed(0)}s`);
      console.log('   leave this running, then in another terminal:  pnpm demo:d\n');
    }
  }, 2000);
}

main();
