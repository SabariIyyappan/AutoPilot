/**
 * One-command setup for the RocketRide engine.
 *
 * Downloads the MIT-licensed engine release, extracts it to .engine/, and
 * applies one local workaround (documented below). Idempotent — safe to
 * re-run.
 *
 * No API keys, no accounts, no cloud. The engine runs entirely on localhost.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, renameSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const ENGINE_DIR = path.join(ROOT, '.engine');
const SERVER_DIR = path.join(ENGINE_DIR, 'server');
const VERSION = 'server-v3.3.1';

const PLATFORM_ASSET = {
  win32: `rocketride-server-v3.3.1-win64.zip`,
  linux: `rocketride-server-v3.3.1-linux-x64.tar.gz`,
  darwin: `rocketride-server-v3.3.1-darwin-arm64.tar.gz`,
};

/**
 * Node requirement files that pin `onnxruntime-gpu`, which does not resolve
 * on machines without a CUDA-capable setup.
 *
 * The engine's dependency bootstrap globs EVERY requirements file under
 * nodes/** before resolving anything, so one unsatisfiable pin blocks the
 * whole engine from starting — even though none of these nodes are used by
 * Autopilot (Whisper transcription, GLiNER NER, pose estimation, text
 * anonymisation). Renaming them to .disabled is reversible and touches no
 * engine code.
 */
const GPU_ONLY_REQUIREMENTS = [
  'ai/common/models/audio/requirements_whisper.txt',
  'ai/common/models/gliner/requirements_gliner.txt',
  'ai/common/models/vision/requirements_pose.txt',
  'nodes/anonymize/requirements.txt',
  'nodes/audio_transcribe/requirements.txt',
];

function log(msg) {
  console.log(`  ${msg}`);
}

function download() {
  const asset = PLATFORM_ASSET[process.platform];
  if (!asset) {
    console.error(`Unsupported platform: ${process.platform}`);
    process.exit(1);
  }

  mkdirSync(ENGINE_DIR, { recursive: true });
  const archive = path.join(ENGINE_DIR, asset);

  if (!existsSync(archive)) {
    const url = `https://github.com/rocketride-org/rocketride-server/releases/download/${VERSION}/${asset}`;
    log(`downloading ${asset} (~180MB, one time)`);
    execFileSync('curl', ['-L', '--fail', '--progress-bar', '-o', archive, url], {
      stdio: 'inherit',
    });
  } else {
    log(`archive already present (${(statSync(archive).size / 1e6).toFixed(0)}MB)`);
  }

  if (existsSync(path.join(SERVER_DIR, 'ai'))) {
    log('engine already extracted');
    return;
  }

  log('extracting');
  mkdirSync(SERVER_DIR, { recursive: true });
  if (asset.endsWith('.zip')) {
    execFileSync(
      'powershell',
      ['-NoProfile', '-Command', `Expand-Archive -Path "${archive}" -DestinationPath "${SERVER_DIR}" -Force`],
      { stdio: 'inherit' },
    );
  } else {
    execFileSync('tar', ['-xzf', archive, '-C', SERVER_DIR], { stdio: 'inherit' });
  }
}

function disableGpuOnlyRequirements() {
  let disabled = 0;
  for (const rel of GPU_ONLY_REQUIREMENTS) {
    const full = path.join(SERVER_DIR, rel);
    if (existsSync(full)) {
      renameSync(full, `${full}.disabled`);
      disabled++;
    }
  }
  log(
    disabled > 0
      ? `disabled ${disabled} GPU-only requirement file(s) — see comment in this script`
      : 'GPU-only requirement files already disabled',
  );
}

function main() {
  console.log('\nAutopilot — engine setup\n');
  download();
  disableGpuOnlyRequirements();

  const entry = readdirSync(SERVER_DIR).find((f) => f.startsWith('engine'));
  if (!entry) {
    console.error('\nengine binary not found after extraction');
    process.exit(1);
  }

  console.log('\nsetup complete. Start the engine with:\n');
  console.log('  pnpm engine\n');
}

main();
