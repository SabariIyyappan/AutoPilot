/**
 * Ollama setup — deliberately NOT the official installer.
 *
 * The stock Windows installer writes the runtime to
 *   C:\Users\<you>\AppData\Local\Programs\Ollama
 * and models to
 *   C:\Users\<you>\.ollama\models
 * with no way to redirect either. We use the standalone build instead, so
 * everything lands in one explicit, self-contained directory on D:.
 *
 *   binary  ->  <OLLAMA_HOME>/bin
 *   models  ->  <OLLAMA_HOME>/models   (via the OLLAMA_MODELS env var)
 *
 * Override the location with:  AUTOPILOT_OLLAMA_HOME=E:\somewhere pnpm setup:ollama
 *
 * Nothing is written to C:. Idempotent — safe to re-run.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';

export const OLLAMA_HOME =
  process.env.AUTOPILOT_OLLAMA_HOME ?? path.join('D:', 'tools', 'ollama');
export const OLLAMA_BIN = path.join(OLLAMA_HOME, 'bin', 'ollama.exe');
export const OLLAMA_MODELS = path.join(OLLAMA_HOME, 'models');

/**
 * Small on purpose. The diagnoser's job is to pick one of eight enum values
 * from an error trace — that is a classification task, not a reasoning one,
 * and a 3B model at temperature 0 handles it. Keeping the download modest
 * matters more than headroom we would not use.
 */
export const MODEL = process.env.AUTOPILOT_OLLAMA_MODEL ?? 'qwen2.5:3b';

const RELEASE = 'https://github.com/ollama/ollama/releases/latest/download/ollama-windows-amd64.zip';

function log(m) {
  console.log(`  ${m}`);
}

function installRuntime() {
  if (existsSync(OLLAMA_BIN)) {
    log(`runtime already present at ${OLLAMA_BIN}`);
    return;
  }

  mkdirSync(path.join(OLLAMA_HOME, 'bin'), { recursive: true });
  const archive = path.join(OLLAMA_HOME, 'ollama-windows-amd64.zip');

  if (!existsSync(archive)) {
    log('downloading Ollama runtime (~1.4GB, one time)');
    execFileSync('curl', ['-L', '--fail', '--progress-bar', '-o', archive, RELEASE], {
      stdio: 'inherit',
    });
  } else {
    log(`archive present (${(statSync(archive).size / 1e6).toFixed(0)}MB)`);
  }

  log('extracting');
  execFileSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      `Expand-Archive -Path "${archive}" -DestinationPath "${path.join(OLLAMA_HOME, 'bin')}" -Force`,
    ],
    { stdio: 'inherit' },
  );
}

function pullModel() {
  mkdirSync(OLLAMA_MODELS, { recursive: true });
  log(`pulling ${MODEL} into ${OLLAMA_MODELS}`);

  const res = spawnSync(OLLAMA_BIN, ['pull', MODEL], {
    stdio: 'inherit',
    env: { ...process.env, OLLAMA_MODELS },
  });

  if (res.status !== 0) {
    console.error(
      `\nmodel pull failed. Is the Ollama server running?\n` +
        `Start it with:  pnpm ollama\n`,
    );
    process.exit(1);
  }
}

function main() {
  console.log('\nAutopilot — Ollama setup (D: drive, self-contained)\n');
  log(`home:   ${OLLAMA_HOME}`);
  log(`models: ${OLLAMA_MODELS}`);
  console.log('');

  installRuntime();
  pullModel();

  console.log('\nsetup complete. Start the model server with:\n');
  console.log('  pnpm ollama\n');
}

if (import.meta.filename === process.argv[1]) main();
