/**
 * Start the local Ollama server with models pinned to the D: drive location,
 * and wait until it is actually serving.
 *
 * OLLAMA_MODELS is set explicitly so nothing is written to C:.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import net from 'node:net';
import { OLLAMA_BIN, OLLAMA_MODELS, OLLAMA_HOME } from './setup-ollama.mjs';

const PORT = 11434;

function portOpen() {
  return new Promise((resolve) => {
    const s = net
      .connect({ port: PORT, host: '127.0.0.1' })
      .on('connect', () => {
        s.end();
        resolve(true);
      })
      .on('error', () => resolve(false));
    s.setTimeout(500, () => {
      s.destroy();
      resolve(false);
    });
  });
}

async function main() {
  if (await portOpen()) {
    console.log(`\nollama already serving on :${PORT}\n`);
    return;
  }

  if (!existsSync(OLLAMA_BIN)) {
    console.error(`\nOllama not installed at ${OLLAMA_HOME}. Run:  pnpm setup:ollama\n`);
    process.exit(1);
  }

  console.log(`\nstarting ollama on :${PORT}`);
  console.log(`models: ${OLLAMA_MODELS}\n`);

  const child = spawn(OLLAMA_BIN, ['serve'], {
    stdio: 'inherit',
    env: { ...process.env, OLLAMA_MODELS },
  });
  child.on('exit', (code) => process.exit(code ?? 0));

  const started = Date.now();
  const poll = setInterval(async () => {
    if (await portOpen()) {
      clearInterval(poll);
      console.log(
        `\n ollama ready on :${PORT} after ${((Date.now() - started) / 1000).toFixed(0)}s`,
      );
      console.log('   leave this running.\n');
    }
  }, 1000);
}

main();
