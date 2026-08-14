/**
 * VERIFICATION — the invariant that separates a reliability system from a
 * retry loop.
 *
 * A recovery that ran is NOT a recovery that worked. `core/machine.ts` makes
 * `RECOVERED` reachable only through a passing result from here, so this
 * module is the sole gatekeeper of success.
 *
 * All verifiers are deterministic. The plan explicitly excludes an LLM judge
 * from v1: it would be non-deterministic, cost money, and make the benchmark
 * irreproducible. `semantic` is left as a documented plugin point.
 */
import type { VerificationResult, VerifierSpec } from '../core/types.ts';

export type CustomVerifier = (output: unknown) => boolean | Promise<boolean>;

export interface VerifyContext {
  /** The node's raw output. */
  output: unknown;
  /** Plain text extracted from the output, when available. */
  text?: string;
  /** Developer-supplied predicate for `type: 'invariant'`. */
  custom?: CustomVerifier;
  /** Expected ground-truth answer, when the task declares one. */
  expected?: string;
}

function pass(verifier: string, detail: string): VerificationResult {
  return { passed: true, verifier, detail };
}
function fail(verifier: string, detail: string): VerificationResult {
  return { passed: false, verifier, detail };
}

/**
 * The engine formats LLM failures into normal-looking output rather than
 * failing the pipeline (live-observed in P2, docs/architecture.md). Any
 * verifier must therefore reject this marker explicitly — otherwise a
 * "recovered" run could carry an error message as its answer. This is the
 * single most important check here.
 */
const LLM_ERROR_MARKER = '**LLM error**';

export async function verify(
  spec: VerifierSpec | undefined,
  ctx: VerifyContext,
): Promise<VerificationResult> {
  // Universal guard, applied before any specific verifier.
  if (ctx.text?.includes(LLM_ERROR_MARKER)) {
    return fail('llm_error_guard', 'output still carries an engine LLM-error marker');
  }

  if (!spec) {
    // No declared verifier: require only that the node produced something
    // non-empty. Deliberately weak, and deliberately still a real check.
    const empty = ctx.output === undefined || ctx.output === null || ctx.text?.trim() === '';
    return empty
      ? fail('non_empty', 'node produced no output')
      : pass('non_empty', 'node produced output');
  }

  switch (spec.type) {
    case 'schema': {
      const text = ctx.text ?? '';
      try {
        const parsed = JSON.parse(text);
        if (spec.ref && typeof parsed === 'object' && parsed !== null) {
          const required = String(spec.ref).split(',').map((s) => s.trim()).filter(Boolean);
          const missing = required.filter((k) => !(k in (parsed as Record<string, unknown>)));
          if (missing.length > 0) {
            return fail('schema', `missing required field(s): ${missing.join(', ')}`);
          }
        }
        return pass('schema', 'output parsed and satisfied the declared schema');
      } catch {
        return fail('schema', 'output is not valid JSON');
      }
    }

    case 'expected_field': {
      const needle = String(spec.value ?? ctx.expected ?? '');
      if (!needle) return fail('expected_field', 'no expected value declared');
      return (ctx.text ?? '').includes(needle)
        ? pass('expected_field', `output contains "${needle}"`)
        : fail('expected_field', `output does not contain expected "${needle}"`);
    }

    case 'min_results': {
      const min = Number(spec.value ?? 1);
      const count = Array.isArray(ctx.output)
        ? ctx.output.length
        : (ctx.text ?? '').trim()
          ? 1
          : 0;
      return count >= min
        ? pass('min_results', `${count} result(s) >= ${min}`)
        : fail('min_results', `${count} result(s) < required ${min}`);
    }

    case 'invariant': {
      if (!ctx.custom) return fail('invariant', 'no custom verifier supplied');
      const ok = await ctx.custom(ctx.output);
      return ok
        ? pass('invariant', 'developer invariant held')
        : fail('invariant', 'developer invariant did not hold');
    }

    default: {
      const _exhaustive: never = spec.type;
      return fail('unknown', `unsupported verifier type: ${String(_exhaustive)}`);
    }
  }
}
