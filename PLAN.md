# Autopilot

> ⚠️ **This is the PRE-BUILD design document, kept as a record of the original plan.**
>
> Several assumptions here were disproven once the engine was running — most
> importantly, §7's "replace the frontier edge with a **literal node**". RocketRide
> has no literal/constant component, and a node with no inbound data edge is never
> scheduled at all. The shipped mechanism delivers cached values differently.
>
> **For what was actually built, read [README.md](README.md) and
> [docs/architecture.md](docs/architecture.md)** — the latter documents every
> assumption that changed and the evidence that changed it.

---



**A budget-aware reliability harness for production AI agents, built on RocketRide.**

Constraints: $0 spend · ~6 hours build · every result reproducible from a seed.

---

# Part I — The idea

## 1. Problem

Agents don't fail like servers. They fail like this:

- a provider degrades under load
- an MCP tool times out or disappears
- a schema drifts and structured output stops parsing
- retrieved context is stale
- the model returns something plausible and wrong

Today every team solves this the same way: try/catch, retries, a fallback provider, a timeout, a custom validator, and a human on call. It is rebuilt per project, it is invisible in production, and it is untestable.

RocketRide already provides execution, orchestration, observability, and portability — but it has **no reliability semantics**. There is no node-level retry, timeout, error handling, or conditional routing anywhere in the pipeline schema. When a node fails, that is the developer's problem.

## 2. The thesis

> The runtime already knows **what** failed, **where**, what it **cost**, and what **alternatives** are registered.
> That is everything required to make a recovery decision. Autopilot makes that decision — inside a budget the developer declares.

Autopilot is a **control plane**, not an agent. It never improvises. It detects a failure, classifies it, selects the cheapest permitted recovery, verifies the recovery worked, and resumes — or refuses and escalates.

## 3. The developer contract

The entire product surface is one file. The developer writes no recovery code; they declare the envelope recovery may happen inside.

```yaml
# autopilot.config.yaml
budget:
  extra_cost_usd:    0.05
  extra_latency_ms:  4000
  extra_tokens:      12000
  attempts:          3
  max_risk:          MEDIUM

policy:
  PROVIDER_TRANSIENT:   [retry, provider_fallback]
  PROVIDER_UNAVAILABLE: [provider_fallback, model_escalation]
  TOOL_TIMEOUT:         [retry, capability_swap]
  TOOL_UNAVAILABLE:     [capability_swap]
  SCHEMA_MISMATCH:      [output_repair, model_escalation]
  INVALID_TOOL_ARGS:    [output_repair, retry]
  STALE_CONTEXT:        [retrieval_refresh]
  UNKNOWN:              [escalate]

forbidden:
  - replay_irreversible_write
  - retry_external_payment
```

## 4. Four properties that make this more than a retry wrapper

| | |
|---|---|
| **Multidimensional budget** | Cost, latency, tokens, attempts, risk — in real dollars and milliseconds, resolved against a declared price table. Recovery is scheduled against a resource envelope, not counted. |
| **Capability substitution** | When a tool dies, ask the runtime which registered services satisfy the same *capability* — not fall back to a hardcoded backup. |
| **Side-effect contracts** | Every node declares whether it is replayable. Irreversible writes are never autonomously retried. Unclassified nodes default to unsafe. |
| **Mandatory verification** | No recovery counts as success until a verifier passes. This is enforced structurally, not by convention. |

---

# Part II — System architecture

## 5. Platform facts this is built on

Verified against the RocketRide repo and docs. These are load-bearing.

| Capability | Mechanism |
|---|---|
| Free, self-hosted | MIT. `./engine ./ai/eaas.py --host=0.0.0.0`, port **5565**, no auth on localhost. Same engine as Cloud. |
| Per-node execution events | `apaevt_flow` → `{ id, op: "begin"\|"enter"\|"leave"\|"end", pipes, component, trace, result }` — component entry/exit with lane data **and errors**. |
| Timing & resource telemetry | `apaevt_status_update` → `startTime`, `endTime`, `failedCount`, `metrics.*`, `tokens.total`. |
| Capability discovery | `client.getServices()` / `getService(name)`. |
| Task control | `client.use()`, `send()`, `getTaskStatus()`, `terminate()`. |
| **Pipelines are data** | `.pipe` is plain JSON (`components[]` + `control[]`), and `client.use({ pipeline: <object> })` accepts an **in-memory object**. |
| No resume API | There is no checkpoint/resume. → **§7.** |
| Free local models | Ollama node ships in the catalog. |
| MCP | `MCP Client` node; `Pipeline Tool` node exposes an inline pipeline as an agent tool. |

## 6. Component architecture

```
                    ┌──────────────────────────────┐
                    │      Developer's Pipeline    │
                    └──────────────┬───────────────┘
                                   │
                    ┌──────────────▼───────────────┐
                    │   RocketRide Engine (:5565)  │
                    └──────────────┬───────────────┘
                                   │  apaevt_flow / apaevt_status_update
   ══════════════════════════════════════════════════════════════════════
                                   │
                    ┌──────────────▼───────────────┐
                    │   ADAPTER  (only pkg that    │
                    │   imports `rocketride`)      │
                    │   normalize → ExecutionEvent │
                    └──────────────┬───────────────┘
                                   │
   ┌───────────────────────────────▼────────────────────────────────────┐
   │                     AUTOPILOT CONTROL PLANE                        │
   │                        (pure TypeScript)                           │
   │                                                                    │
   │   DETECTOR ──→ DIAGNOSER ──→ POLICY ──→ BUDGET ──→ GATE            │
   │   did it       why?          which      can we     is it           │
   │   fail?                      options?   afford?    safe?           │
   │                                            │                       │
   │                                            ▼                       │
   │                                       EXECUTOR                     │
   │                                    (pipeline rewrite)              │
   │                                            │                       │
   │                                            ▼                       │
   │                                        VERIFIER                    │
   │                                     ┌──────┴──────┐                │
   │                                  PASS            FAIL              │
   │                                     │              │               │
   │                                 RECOVERED    next / ESCALATED      │
   └────────────────────────────────────────────────────────────────────┘
                                   │
                    ┌──────────────▼───────────────┐
                    │  TRACE SINK → runs/*.jsonl   │
                    └──────────────────────────────┘
```

**The seam.** Only `packages/adapter` imports `rocketride`. Everything above the double line is pure TypeScript over an event model, fully testable with the engine switched off. This is both an architectural claim and the reason the build fits in six hours.

## 7. The core mechanism: residual pipeline synthesis

RocketRide cannot resume a run from node N. But pipelines are portable JSON and `use()` accepts an in-memory object. Therefore:

> **Autopilot does not resume a pipeline. It synthesizes a new one.**

**Algorithm.** On failure at node `N` of pipeline `P`:

1. Harvest cached outputs of all completed upstream nodes from `apaevt_flow` `leave` events → `checkpoint.outputs`.
2. Compute the **residual set** = `{N} ∪ descendants(N)` over `P`'s input edges.
3. Emit a new pipeline: residual components only. Every edge crossing the frontier (from a completed node into the residual set) is replaced with a **literal node** carrying the cached value.
4. Apply the **strategy rewrite** to node `N` (table below).
5. `client.use({ pipeline: residual })` and run.

```
original                          residual (synthesized)
────────────────────              ────────────────────────────
retrieve ─┐                       literal(retrieve.out) ─┐
crm ──────┼→ reason → out         literal(crm.out) ──────┼→ reason' → out
                                                            ▲
                                              strategy rewrite applied here
```

**Every recovery strategy is a deterministic JSON diff:**

| Strategy | Rewrite |
|---|---|
| `retry` | identity — re-run unchanged |
| `provider_fallback` | swap the component's `provider` to the next entry in the provider ladder |
| `model_escalation` | swap `config.model` up the declared model ladder |
| `capability_swap` | replace the component with another implementation of the same declared capability |
| `output_repair` | prepend a repair component fed the malformed output + target schema |
| `retrieval_refresh` | reset retrieval config (widen `k`, bust cache) on the upstream retriever, extending the residual set to include it |
| `escalate` | emit nothing; return `ESCALATED` with the checkpoint attached |

This is why recovery is deterministic, diffable, and testable. There is **no recovery model in the loop** — no LLM decides what to do. It is only possible because RocketRide made pipelines data.

## 8. Data model

```ts
// ── observation ────────────────────────────────────────────────
interface ExecutionEvent {
  runId: string;  nodeId: string;  nodeType: string;
  op: 'begin' | 'enter' | 'leave' | 'end';
  startedAt: number;  endedAt?: number;
  input?: unknown;  output?: unknown;  error?: RuntimeError;
  provider?: string;  model?: string;  tool?: string;
  tokens?: number;  costUsd?: number;  latencyMs?: number;
}

// ── detection (did it fail?) ───────────────────────────────────
interface FailureSignal {
  detected: boolean;
  type: 'RUNTIME_ERROR' | 'VALIDATION_ERROR' | 'LOOP'
      | 'STALE_CONTEXT' | 'VERIFIER_REJECTION' | 'RESOURCE_EXHAUSTION';
  evidence: Evidence[];
}

// ── diagnosis (why?) ───────────────────────────────────────────
type FailureClass =
  | 'PROVIDER_TRANSIENT' | 'PROVIDER_UNAVAILABLE'
  | 'TOOL_TIMEOUT'       | 'TOOL_UNAVAILABLE'
  | 'INVALID_TOOL_ARGS'  | 'SCHEMA_MISMATCH'
  | 'STALE_CONTEXT'      | 'UNKNOWN';

// ── selection ──────────────────────────────────────────────────
type RecoveryAction =
  | 'retry' | 'provider_fallback' | 'model_escalation'
  | 'capability_swap' | 'output_repair' | 'retrieval_refresh' | 'escalate';

interface RecoveryProposal {
  action: RecoveryAction;
  expectedCostUsd: number;  expectedLatencyMs: number;  expectedTokens: number;
  risk: 'LOW' | 'MEDIUM' | 'HIGH';
  successPrior: number;          // declared, not learned
  rewrite: PipelineRewrite;      // the JSON diff, precomputed
}

interface RecoveryBudget {
  remainingCostUsd: number;  remainingLatencyMs: number;  remainingTokens: number;
  remainingAttempts: number;  maxRisk: 'LOW' | 'MEDIUM' | 'HIGH';
}

// ── safety ─────────────────────────────────────────────────────
type SideEffect = 'NONE' | 'IDEMPOTENT_WRITE' | 'REVERSIBLE_WRITE' | 'IRREVERSIBLE_WRITE';

interface RecoveryContract {
  nodeId: string;
  sideEffect: SideEffect;        // absent ⇒ IRREVERSIBLE_WRITE (fail closed)
  retryable: boolean;
  capability?: string;           // enables capability_swap
  verifier?: VerifierSpec;
}

// ── state ──────────────────────────────────────────────────────
interface RecoveryCheckpoint {
  runId: string;  failedNodeId: string;
  outputs: Record<string, unknown>;   // completed upstream node outputs
  history: RecoveryAttempt[];
  budget: RecoveryBudget;
}

type Phase = 'RUNNING' | 'FAILED' | 'DIAGNOSING' | 'RECOVERING'
           | 'VERIFYING' | 'RECOVERED' | 'DEGRADED' | 'ESCALATED';
```

## 9. Control loop

The state machine is a **pure reducer** — `step(state, input) → [state, Effect[]]`. It performs no I/O. A thin driver interprets the effects. This makes the entire control plane unit-testable with no engine, no network, and no mocks.

```
        ExecutionEvent
              │
              ▼
        ┌──────────┐   no failure
        │ DETECTOR ├──────────────→ RUNNING
        └────┬─────┘
             │ FailureSignal
             ▼
        ┌──────────┐   UNKNOWN
        │DIAGNOSER ├──────────────→ ESCALATED
        └────┬─────┘
             │ FailureClass
             ▼
        ┌──────────┐   no candidates
        │  POLICY  ├──────────────→ ESCALATED
        └────┬─────┘
             │ RecoveryProposal[]
             ▼
        ┌──────────┐   none affordable
        │  BUDGET  ├──────────────→ ESCALATED   (reason logged)
        └────┬─────┘
             │ ranked, filtered
             ▼
        ┌──────────┐   unsafe side effect
        │   GATE   ├──────────────→ ESCALATED   (0 attempts issued)
        └────┬─────┘
             │ permitted proposal
             ▼
        ┌──────────┐
        │ EXECUTOR │  synthesize residual → client.use()
        └────┬─────┘
             ▼
        ┌──────────┐
        │ VERIFIER │
        └────┬─────┘
         ┌───┴────┐
       PASS      FAIL
         │         │
     RECOVERED   next proposal, or ESCALATED when exhausted
```

**Two structurally enforced invariants:**

1. `RECOVERED` is reachable **only** through a passing `VerificationResult`. There is no other transition into it.
2. The **gate** sits above every executor and cannot be bypassed. `IRREVERSIBLE_WRITE` never reaches an executor.

## 10. Ranking

Budget filters, then ranks:

```
score = successPrior / (w_cost·normCost + w_latency·normLatency + w_risk·riskWeight)
```

Estimates come from `prices.json` + static per-strategy priors. **Declared and honest, not learned.**

Every rejection is recorded with its reason — `"full_replan rejected: $0.14 > $0.10 remaining"` is a product feature, not a debug line.

## 11. Side-effect gate

```
NONE / read        → retry freely
IDEMPOTENT_WRITE   → retry with idempotency key
REVERSIBLE_WRITE   → run compensator, then retry
IRREVERSIBLE_WRITE → never autonomously replay → escalate
```

```yaml
# apps/demo-agent/contracts.yaml
search_docs:
  sideEffect: NONE
  retryable: true
  capability: document.search
  verifier: { type: min_results, value: 3 }

customer_lookup:
  sideEffect: NONE
  retryable: true
  capability: customer.lookup
  verifier: { type: schema, ref: customer.json }

charge_customer:
  sideEffect: IRREVERSIBLE_WRITE
  retryable: false
```

## 12. Determinism model

Faults are injected **at the adapter boundary** — the engine runs for real; results are corrupted or thrown on the way through.

The fault schedule is keyed by a seeded hash:

```
fault(seed, taskId, nodeId, attemptIndex)
```

Because first-attempt faults are keyed at `attemptIndex = 0`, **all four benchmark modes see byte-identical initial faults.** Recovery attempts draw from `attemptIndex > 0`. That is what makes the baseline comparison fair rather than merely repeated.

## 13. Repository structure

```
autopilot/
├── autopilot.config.yaml         # the developer contract (§3)
├── prices.json                   # declared provider prices — all $ math resolves here
│
├── packages/
│   ├── core/                     # types + pure state machine. Zero dependencies.
│   │   ├── types.ts              #   §8 in full
│   │   ├── machine.ts            #   step(state, input) → [state, Effect[]]
│   │   └── checkpoint.ts
│   │
│   ├── adapter/                  # ⚠ ONLY package importing `rocketride`
│   │   ├── client.ts             #   connect / use / setEvents / send / terminate
│   │   ├── normalize.ts          #   apaevt_flow → ExecutionEvent
│   │   ├── residual.ts           #   §7 pipeline synthesis
│   │   ├── rewrites.ts           #   the strategy → JSON-diff table
│   │   └── services.ts           #   getServices() → capability registry
│   │
│   ├── diagnosis/
│   │   ├── detector.ts           #   deterministic signals only
│   │   └── diagnoser.ts          #   rules table → FailureClass
│   │
│   ├── control/
│   │   ├── policy.ts             #   class + config + registry → candidates
│   │   ├── budget.ts             #   filter + rank
│   │   └── estimate.ts           #   prices.json + priors
│   │
│   ├── recovery/
│   │   ├── gate.ts               #   §11 — above every executor
│   │   └── executors/            #   retry, provider-fallback, capability-swap,
│   │                             #   output-repair, escalate
│   ├── verify/
│   │   ├── schema.ts             #   JSON schema / expected field / min results
│   │   └── invariant.ts          #   developer callback
│   │
│   ├── orchestrator/             # the driver: interprets Effects, owns the run loop
│   └── chaos/
│       ├── profile.ts            #   fault probabilities — frozen before P4
│       ├── inject.ts             #   §12 seeded injection
│       └── bench.ts              #   4-mode runner
│
├── apps/
│   ├── demo-agent/
│   │   ├── pipeline.pipe         #   webhook → retrieve → crm(MCP) → reason → payment → out
│   │   ├── contracts.yaml        #   §11
│   │   └── tasks.jsonl           #   tasks with KNOWN-CORRECT outputs
│   └── report/                   #   static Vite+React over runs/*.jsonl. No backend.
│
├── runs/                         # committed JSONL benchmark artifacts
└── docs/
    ├── architecture.md
    └── benchmark.md
```

**Dependency rule, enforced by a lint check:** `core`, `diagnosis`, `control`, `recovery`, `verify` may not import `adapter` or `rocketride`.

---

# Part III — Execution plan

Phases are ordered by dependency, not by clock. Each has one exit criterion. **P0–P7 is the shippable product**; P8 is presentation.

### P0 · Recon spike *(timeboxed — hard stop)*

Boot the engine, run a trivial pipeline, subscribe to `apaevt_flow`, and **dump every raw frame to `fixtures/raw-events.jsonl`**.

```bash
pnpm add rocketride
./engine ./ai/eaas.py --host=0.0.0.0      # :5565, no auth on localhost
rocketride start --pipeline ./hello.pipe
```

**Exit:** real event frames on disk.

> **Cut line — respect it.** If the engine will not boot inside the box, hand-write the fixture from the documented `apaevt_flow` shape and continue. The control plane doesn't care and the adapter is wired last. Do not let engine setup consume the build.

### P1 · Core

`packages/core` — every type in §8, plus `step()` as a pure reducer with illegal transitions throwing. Unit tests, no engine.

**Exit:** `pnpm test core` green; both §9 invariants covered by test.

### P2 · Chaos *(deliberately early — this is the dev loop)*

Seeded injection per §12. Freeze and commit the profile:

```ts
// chaos/profile.ts — COMMIT, THEN DO NOT TOUCH
{ provider_500: 0.05, provider_429: 0.03, mcp_timeout: 0.10,
  invalid_json: 0.08, schema_drift: 0.04, stale_context: 0.04 }
```

`tasks.jsonl` entries must carry **checkable ground truth** — exact IDs, exact totals, never free prose. Without it, silent-failure rate and wrong-recovery rate cannot be measured, and those two metrics are the whole argument.

**Exit:** same seed → byte-identical fault schedule, twice.

> Freezing before P4 is what keeps the benchmark honest. Tuning faults after seeing results is the failure mode reviewers look for.

### P3 · Detection & diagnosis

Detector: HTTP status, timeout, JSON parse failure, schema validation, repeated-call loop, threshold breach. **Never ask a model whether 429 is a failure.**
Diagnoser: rules table → one of eight classes. `UNKNOWN` routes straight to escalation and is a legitimate outcome.

**Exit:** classification accuracy measured against the *known injected fault* — precise, because chaos injected it.

### P4 · Policy & budget

Candidates from class + config + capability registry. Filter on all five budget dimensions, rank per §10, log every rejection with its reason.

**Exit:** table test — failure classes × budget states → expected selection.

### P5 · Gate & executors

Gate first (§11), executors second — enforcing the ordering in code. Five executors, each a residual rewrite from §7's table.

**Exit:** `payment.capture` timeout → `ESCALATED` with a test asserting **zero attempts issued**.

### P6 · Verification & wire-up

Deterministic verifiers plus developer callback. Orchestrator interprets effects and drives the loop end to end.

**Exit:** all four scenarios pass under seeded chaos:

| | Scenario | Path |
|---|---|---|
| **A** | Provider failure | 500 → retry → provider fallback → verify → resume |
| **B** | Capability substitution | MCP timeout → retry fails → capability registry → local index → verify → resume |
| **C** | Schema drift | invalid JSON → cheapest repair → schema verifier → resume |
| **D** | Irreversible write | payment timeout → gate blocks → escalate |

**This is MVP.**

### P7 · Benchmark *(the most important deliverable)*

Four modes, one seed, identical initial faults: `NO_RECOVERY` · `RETRY_ONLY` · `FULL_REPLAN` · `AUTOPILOT`.

Metrics: final success · first-pass success · recovery success · **silent failure rate** · **wrong recovery rate** · mean attempts · recovery cost · added p50/p95 latency · escalation rate.

Headline metric — lead with this, never with "caught N failures":

```
Reliability Gain Per Recovery Dollar  =  additional successful requests ÷ recovery spend
```

≥100 tasks per mode. Raw JSONL committed to `runs/`.

**Exit:** `docs/benchmark.md` with method, seed, table, and an honest limitations section.

### P8 · Report & README

Report: static, reads committed JSONL, **two views only** — reliability summary, and one incident timeline (failure → each attempt with cost/latency/outcome → verification → resume or escalate, budget remaining at each step). Resist a third view.

README: residual synthesis (§7) above the fold, benchmark table, honest limitations.

## 14. Build order

```
core ──┬─→ chaos ─────────┐
       ├─→ diagnosis ─────┤
       ├─→ control ───────┼─→ orchestrator ─→ benchmark ─→ report
       ├─→ gate+executors ┤
       └─→ verify ────────┘
                           ↑
   adapter (rocketride) ───┘   ← wired LAST, against P0 fixtures
```

Wiring the adapter last is the reason this fits the timebox: ~70% of the work runs with no engine in the loop.

## 15. The $0 stack

| Need | Choice |
|---|---|
| Engine | Self-hosted `rocketride-server`, MIT, :5565, no auth on localhost |
| SDK + CLI | `npm install rocketride` |
| Cheap model tier | Ollama node — local, free |
| Escalation tier | Free API tiers (Groq / Google AI Studio / OpenRouter) — gives *real* provider diversity so fallback isn't simulated |
| MCP | A local MCP server you can stall on demand + the `MCP Client` node |
| Substitution target | local `ripgrep` / local index as the alternate capability implementation |
| Storage | JSONL on disk. No database. |
| UI / hosting | Vite + React static → GitHub Pages |
| CI | GitHub Actions free tier |

**Cost honesty:** budgets resolve against `prices.json` (published list prices), not money actually spent. State this plainly in the README — it keeps the arithmetic real while the harness costs nothing to run. Free-tier rate limits are themselves a legitimate `PROVIDER_TRANSIENT` fault source; use them.

## 16. Explicitly not building

Generic LLM observability · an "AI that fixes AI" · LLM-based diagnosis (non-deterministic, costs money, poisons the benchmark — plugin point only) · learned/RL ranking · recovery *depth* as a dimension separate from attempts · auth/teams/billing · more than eight failure classes · a live backend for the UI · multiple example agents.

## 17. Definition of done

- [ ] `core`, `diagnosis`, `control`, `recovery`, `verify` import neither `adapter` nor `rocketride` — enforced by lint
- [ ] Control plane fully unit-tested with the engine switched off
- [ ] Same seed → identical fault schedule → reproducible benchmark
- [ ] Scenarios A–D pass end to end
- [ ] `RECOVERED` unreachable without a passing verifier — proven by test
- [ ] `IRREVERSIBLE_WRITE` never reaches an executor — proven by test
- [ ] Residual synthesis validated against a full re-run
- [ ] Four-mode benchmark, raw JSONL committed
- [ ] Every dollar figure traces to `prices.json`
- [ ] Total spend: $0

## 18. Risks

| Risk | Mitigation |
|---|---|
| Engine setup eats the timebox | P0 cut line: hand-written fixtures, adapter wired last |
| No resume API | Already the design (§7) — the limitation became the mechanism |
| Free-tier rate limits break the benchmark | Ollama locally for bulk runs; free APIs only for the escalation tier |
| Benchmark flatters Autopilot | Fault profile frozen and committed before P4; faults keyed identically across modes (§12) |
| Scope creep | §16 is binding |

## 19. What this demonstrates

1. **A platform argument, not an application.** RocketRide's four properties — execution, orchestration, observability, portability — are usually pitched as four features. Together they are the exact preconditions for a reliability control plane. All four are load-bearing here; nothing else was needed.
2. **Recovery as data transformation.** Pipelines-as-JSON makes recovery a deterministic diff. That is a close reading of the platform, and it works *because* there is no resume API, not despite it.
3. **The refusal.** A system that declines to replay an irreversible write is a reliability system. One that always tries harder is a retry loop.
4. **The seam.** One package touches the runtime; the control plane is provably independent.
