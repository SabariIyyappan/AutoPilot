/**
 * Enforces the architectural seam that the whole project rests on:
 *
 *   ONLY packages/adapter may import `rocketride`.
 *
 * The control plane (core, diagnosis, control, recovery, verify) must stay
 * pure TypeScript over the event model, testable with the engine switched
 * off. This check makes that a build failure rather than a code-review
 * convention.
 *
 * Also enforces the fixture policy: no runtime code may read fixtures/.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const CONTROL_PLANE = ['core', 'diagnosis', 'control', 'recovery', 'verify', 'chaos'];

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (full.endsWith('.ts') || full.endsWith('.mjs')) out.push(full);
  }
  return out;
}

const violations = [];

for (const pkg of CONTROL_PLANE) {
  const dir = path.join(ROOT, 'packages', pkg);
  let files;
  try {
    files = walk(dir);
  } catch {
    continue; // package not created yet
  }

  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    const rel = path.relative(ROOT, file);

    if (/from ['"]rocketride['"]|require\(['"]rocketride['"]\)/.test(src)) {
      violations.push(`${rel}: imports 'rocketride' — only packages/adapter may do that`);
    }
    if (/from ['"].*\/adapter\//.test(src)) {
      violations.push(`${rel}: imports from packages/adapter — the control plane must not depend on it`);
    }
    if (!file.endsWith('.test.ts') && /fixtures\//.test(src)) {
      violations.push(`${rel}: references fixtures/ from non-test code — fixtures are test-only scaffolding`);
    }
  }
}

if (violations.length > 0) {
  console.error('SEAM CHECK FAILED:\n');
  for (const v of violations) console.error(`  ${v}`);
  process.exit(1);
}

console.log('seam check passed: control plane is free of rocketride/adapter/fixture dependencies');
