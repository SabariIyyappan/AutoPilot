# Benchmark — Method, Results, Limitations

Four recovery strategies, the same tasks, the same seeded faults, against a **live self-hosted RocketRide engine**. The comparison isolates the recovery strategy and nothing else.

```bash
node --experimental-strip-types apps/demo-agent/bench-cli.ts --seed 42 --tasks 100
```

Raw per-run records are committed to `runs/bench-seed42-n100.jsonl` so every number here is reproducible from the repo.

## The four modes

| Mode | Behaviour |
|---|---|
| `NO_RECOVERY` | Control group. Detect the failure and stop. |
| `RETRY_ONLY` | Retry every failure class. No verification. |
| `FULL_REPLAN` | Always escalate to the expensive strategy (`model_escalation`). No verification. |
| `AUTOPILOT` | Targeted, budgeted, **verified** recovery. |

**Why the baselines do not verify.** That is the comparison, not a handicap. Retry-only and full-replan are what teams actually build, and neither checks whether the answer is *correct* — only whether the call succeeded. Giving them a verifier would be giving them Autopilot's central idea for free and would make the comparison meaningless.

## How silent failure is measured honestly

Every task carries known-correct ground truth (an exact customer ID, never free prose). A run is a **silent failure** when the mode *reports success* but the final answer does not match ground truth.

**Ground truth is never shown to any verifier.** It is used only for scoring after the fact, so no mode — Autopilot included — can cheat by reading it. Autopilot's verifier checks a declared JSON schema (`customerId`, `balance` present), which is strictly weaker than knowing the answer.

## Fairness controls

- **Identical faults per task across modes.** The fault schedule is a pure function of `(seed, taskId, nodeId, generation)`, and the harness resets the fault generation at the start of every task. All four modes therefore hit byte-identical initial faults. Without this the benchmark would measure fault luck rather than strategy.
- **The fault profile was frozen before the policy engine was built** (`LLM_PROFILE` in `packages/chaos/schedule.ts`). Tuning a profile after seeing recovery results is exactly how benchmarks become dishonest.
- **Faults are injected upstream of the engine**, not by corrupting events after the fact, so the engine genuinely experiences them — including its own internal retry behaviour.

## Cost model

Dollar figures resolve against `prices.json` (declared provider list prices) applied to measured token counts. **The harness itself costs $0 to run** — a local chaos proxy stands in for the provider — so these are a *model* of cost applied to real call volumes, not money spent. Token counts are themselves estimated from response length, because this engine build does not report per-call usage (see `docs/architecture.md` Q4). Both approximations are stated wherever a figure is shown.

## Headline metric

```
Reliability Gain Per Recovery Dollar
  = (additional correct answers vs. NO_RECOVERY) ÷ (recovery spend)
```

Success rate alone rewards spending without limit. This asks what the spending actually bought.

## Results — seed 42, 100 tasks × 4 modes (400 live runs, 160s)

| mode | first-pass | **final** | **silent failure** | escalation | attempts | $/task | p50 | gain/$ |
|---|---|---|---|---|---|---|---|---|
| NO_RECOVERY | 77.0% | 72.0% | 5.0% | 23.0% | 0.00 | $0.00000 | 37ms | — |
| RETRY_ONLY | 77.0% | 72.0% | 5.0% | 23.0% | 0.23 | $0.00000 | 53ms | 0.0 |
| FULL_REPLAN | 77.0% | 72.0% | 5.0% | 23.0% | 0.23 | $0.00003 | 74ms | 0.0 |
| **AUTOPILOT** | 72.0% | **86.0%** | **0.0%** | 14.0% | 0.43 | $0.00002 | 109ms | 7729.5 |

Raw records: `runs/bench-seed42-n100.jsonl` (400 rows).

### Reading the table

**Retry-only and full-replan are statistically indistinguishable from doing nothing.** Identical final success (72.0%), identical silent-failure rate (5.0%), identical escalation rate. They are not broken — they are doing exactly what they were built to do, and it does not help here. A schema-drifted response is not a runtime error: the HTTP call succeeded, the pipeline reported success, and there is nothing for a retry to trigger on. They retry the failures that were already going to fail, and ship the wrong answers untouched.

**Full replanning costs ~30× more than retry for the same outcome.** This is the cost-blind strategy paying for the privilege of not being better. It is why the headline metric is normalised by spend.

**Autopilot's first-pass rate is LOWER — 72.0% vs 77.0% — and that is correct, not a regression.** It counts a verifier-rejected first pass as a failure, because the answer was wrong. The baselines counted those same runs as successes. The 5-point gap *is* the silent-failure rate, visible from two directions.

**Silent failure 5.0% → 0.0%.** Structurally guaranteed rather than empirically lucky: `RECOVERED` is unreachable in the state machine except through a passing verifier, so a wrong answer cannot be reported as a success. That is the single most important number in this table.

**Added latency is ~72ms at p50** (37ms → 109ms) for +14 points of real reliability.

## Limitations

Stated plainly, because the result is only worth as much as its caveats:

1. **The provider is a deterministic stand-in, not a real model.** This is a deliberate trade: the benchmark needs known-correct answers to measure silent-failure rate at all, and a real model's nondeterminism would defeat that. It does mean these numbers measure the *recovery control plane*, not model quality.
2. **One pipeline shape.** A linear `webhook → prompt → llm → response` pipeline. Results may differ for branching pipelines or agent/tool graphs.
3. **LLM faults only.** `LLM_PROFILE` excludes MCP/tool faults, because injecting `mcp_timeout` into an endpoint with no MCP tool would produce a meaningless error rather than the failure it names. Tool-failure recovery (scenario B) is not covered by this benchmark.
4. **Latency is dominated by engine overhead.** Pipeline instantiation costs ~10.9s versus ~28ms for execution (measured, `spike/throughput.mjs`). The harness caches instances, so reported per-task latency reflects execution, not the one-off instantiation.
5. **Declared success priors, not learned ones.** Ranking uses static priors from `prices.json`. A learned ranker was explicitly excluded from v1.
6. **Single seed reported.** The harness is seed-parameterised; only seed 42 is committed here.

## Reproducing

```bash
.engine/server/engine.exe ./ai/eaas.py --host=0.0.0.0   # engine on :5565
node --experimental-strip-types apps/demo-agent/bench-cli.ts --seed 42 --tasks 100
```

Same seed ⇒ same fault schedule ⇒ same table.
