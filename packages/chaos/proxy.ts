/**
 * Local OpenAI-compatible fault-injecting proxy.
 *
 * The engine's `llm_openai_api` node calls this directly (its `base_url`
 * config points here), so faults are real HTTP failures the engine
 * genuinely experiences — not corrupted after the fact. See
 * docs/architecture.md's determinism model for why that distinction matters.
 *
 * Engine retry interaction (found reading ai/common/chat.py during P2):
 *   - HTTP 429/500/502/503/504 are retried INTERNALLY by the engine, up to
 *     5 times with exponential backoff (1s/2s/4s/8s/16s, CONST_CHAT_MAX_RETRIES=5).
 *     Realistic, but slow — useful for scenario A where added latency is
 *     itself a metric we report.
 *   - HTTP 400/401/403/404/422 are NOT retried internally — they surface to
 *     Autopilot on the very first call. `provider_unavailable` deliberately
 *     maps to 401 for this reason: it needs to be visible on attemptIndex 0,
 *     not absorbed by the engine's own retry loop.
 *
 * The no-fault path has TWO modes:
 *
 *   - `forwardTo` SET (demo / MCP server): the request is forwarded to a real
 *     OpenAI-compatible model (Ollama) and its genuine response returned. The
 *     agent is a real LLM agent; only the faults are ours.
 *   - `forwardTo` UNSET (benchmark): a deterministic canned response keyed off
 *     the request. Required, not lazy — measuring silent-failure and
 *     wrong-recovery rates needs known-correct ground truth for every task,
 *     which a real model's nondeterminism destroys. See docs/benchmark.md.
 *
 * Faults take precedence over forwarding in both modes.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { fault, isEngineRetried, type FaultProfile, type FaultType } from './schedule.ts';
import { resolveModelTier } from './upstream.ts';

export interface CannedResponder {
  (requestBody: unknown): string;
}

export interface ProxyOptions {
  seed: number;
  profile?: FaultProfile;
  /** nodeId to key the fault schedule on — one proxy instance per LLM node. */
  nodeId: string;
  /** Extracts a stable taskId from the request (e.g. a header or prompt hash). */
  taskIdOf: (requestBody: unknown) => string;
  respond: CannedResponder;
  /**
   * When set, healthy (non-faulted) requests are FORWARDED to this real
   * OpenAI-compatible endpoint (e.g. Ollama at http://127.0.0.1:11434/v1)
   * and the genuine model response is returned.
   *
   * This is what puts a real LLM in the agent without giving up fault
   * injection: faults are still ours and still seeded, but the success path
   * is a real model rather than a canned string.
   *
   * Left UNSET by the benchmark on purpose. Measuring silent-failure rate
   * requires a known-correct answer for every task, which a real model's
   * nondeterminism destroys. See docs/benchmark.md.
   */
  forwardTo?: string;
  /**
   * Default upstream model, used when the pipeline's requested model is not a
   * known logical tier.
   *
   * The pipeline declares a logical tier (`autopilot-canned`) that the real
   * upstream has never heard of, so it is resolved through MODEL_TIERS before
   * forwarding. That indirection is what makes `model_escalation` REAL: the
   * rewrite changes the tier, the tier resolves to a genuinely different
   * model, and the escalated attempt actually runs on it.
   */
  forwardModel?: string;
  /** Abort a forwarded request after this long. Default 60s. */
  forwardTimeoutMs?: number;
  /**
   * Restrict faulting to specific attempt indices (0-based).
   *
   * Omitted = every attempt is subject to the profile, which is what the
   * BENCHMARK uses (a probabilistic profile across all attempts).
   *
   * `[0]` models a TRANSIENT failure: the first call fails, a retry succeeds.
   * The demo scenarios use this so recovery has something real to recover
   * from — a permanently-down dependency is a different (and less
   * interesting) story, and a fault that never clears would make any
   * recovery strategy look broken regardless of its merit.
   */
  faultAttempts?: number[];
  /** Per-node call counter, so repeated calls within one task advance attemptIndex. */
  port?: number;
}

function faultResponse(type: FaultType, res: ServerResponse): void {
  switch (type) {
    case 'provider_500':
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'internal server error', type: 'server_error' } }));
      return;
    case 'provider_429':
      res.writeHead(429, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'rate limit exceeded', type: 'rate_limit_error' } }));
      return;
    case 'provider_unavailable':
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'invalid api key', type: 'authentication_error' } }));
      return;
    // NOTE both of these return a WELL-FORMED OpenAI envelope whose *content*
    // is wrong. That distinction matters: a malformed envelope is a provider
    // protocol error the engine catches and reports as an LLM error, whereas
    // these model the case Autopilot actually exists for — the call succeeds,
    // the pipeline reports success, and the OUTPUT is bad. That is a silent
    // failure, and only a verifier catches it.
    case 'invalid_json':
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(cannedOpenAIResponse('{"customerId": "CUSTOMER-4471", "balance": '));
      return;
    case 'schema_drift':
      // Parses fine, but the declared fields are gone — a provider or model
      // changing its output shape underneath you.
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        cannedOpenAIResponse(JSON.stringify({ account_ref: 'CUSTOMER-4471', amount_due: 128.4 })),
      );
      return;
    default:
      // mcp_timeout / tool_unavailable / stale_context are not proxy faults
      // (see mcp-server.ts / the retrieval index) — treat as no-op here.
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `unhandled fault type in proxy: ${type}` } }));
  }
}

function cannedOpenAIResponse(text: string): string {
  return JSON.stringify({
    id: 'chatcmpl-canned',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: 'autopilot-canned',
    choices: [
      { index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' },
    ],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  });
}

/**
 * Forward a healthy request to a real OpenAI-compatible model server and
 * return its raw response body.
 *
 * `stream` is forced false: the caller only reaches here on the
 * answer-producing call, and we must not start an SSE stream the engine
 * isn't expecting at this point.
 */
async function forwardUpstream(
  baseUrl: string,
  body: unknown,
  timeoutMs: number,
  model?: string,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...(body as Record<string, unknown>),
        stream: false,
        ...(model ? { model } : {}),
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`upstream returned HTTP ${res.status}`);
    }
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Per-taskId call counters. In-memory, per-process — fine for a local chaos
 * harness that lives for the duration of one benchmark run.
 */
function makeAttemptCounter() {
  const counts = new Map<string, number>();
  return (taskId: string) => {
    const n = counts.get(taskId) ?? 0;
    counts.set(taskId, n + 1);
    return n;
  };
}

export function startFaultProxy(opts: ProxyOptions) {
  const nextAttempt = makeAttemptCounter();
  /** Which pipeline run we are in. See the fault-scope note in the handler. */
  let generation = 0;

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body: unknown = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      } catch {
        // fall through with body = {}
      }

      if (!req.url?.includes('/chat/completions')) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'not found' } }));
        return;
      }

      const taskId = opts.taskIdOf(body);

      // MEASURED (spike/count-calls.mjs): one logical LLM invocation costs
      // THREE HTTP calls against this endpoint —
      //   0: a probe with no `stream` field,
      //   1: `stream: true`  (our canned JSON yields no SSE chunks, so the
      //      engine logs "Streaming disabled ..." and falls back),
      //   2: `stream: false` — the call that actually produces the answer.
      //
      // So the logical attempt index is counted on `stream === false` calls
      // only, and only those are faulted. Keying on raw call count instead
      // would be brittle magic-numbering that breaks the moment the engine
      // changes how many probes it sends.
      const isAnswerCall = (body as { stream?: unknown })?.stream === false;
      if (!isAnswerCall) {
        // Probe / streaming-attempt calls are never faulted, and are always
        // answered locally. Forwarding a `stream: true` call to a real model
        // would return SSE chunks, which would change the engine's control
        // flow (it would stop falling back to the non-streaming call) and
        // move the answer off the call our fault schedule keys on.
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(cannedOpenAIResponse(opts.respond(body)));
        return;
      }

      // Fault scope is the PIPELINE RUN ("generation"), not the HTTP call.
      //
      // MEASURED live: the engine has its OWN retry loop
      // (CONST_CHAT_MAX_RETRIES=5, ai/common/chat.py) and treats a malformed
      // 200 body as retryable. Scoping a transient fault to a single HTTP
      // call therefore gets silently absorbed by the engine and never
      // reaches Autopilot at all.
      //
      // That layering is CORRECT — Autopilot should only ever see failures
      // the engine could not fix itself — so the harness models a fault that
      // persists for a whole run, and clears for the next one. The
      // orchestrator advances the generation before each recovery run.
      nextAttempt(taskId); // keep per-task call accounting for diagnostics
      const inScope = opts.faultAttempts ? opts.faultAttempts.includes(generation) : true;
      const f = inScope ? fault(opts.seed, taskId, opts.nodeId, generation, opts.profile) : null;

      if (f) {
        faultResponse(f, res);
        return;
      }

      // ── Healthy path ────────────────────────────────────────────────────
      if (opts.forwardTo) {
        forwardUpstream(
          opts.forwardTo,
          body,
          opts.forwardTimeoutMs ?? 60_000,
          // Resolve the logical tier the PIPELINE asked for on this request,
          // so an escalated attempt reaches a genuinely different model.
          resolveModelTier(
            (body as { model?: unknown })?.model,
            opts.forwardModel ?? 'qwen2.5:3b',
          ),
        )
          .then((upstream) => {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(upstream);
          })
          .catch((err) => {
            // A dead upstream is a REAL provider failure, not a bug to hide.
            // Surfacing it as a 502 lets the harness see and handle it the
            // same way it would a genuine outage.
            res.writeHead(502, { 'content-type': 'application/json' });
            res.end(
              JSON.stringify({
                error: {
                  message: `upstream model unreachable: ${err instanceof Error ? err.message : String(err)}`,
                  type: 'server_error',
                },
              }),
            );
          });
        return;
      }

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(cannedOpenAIResponse(opts.respond(body)));
    });
  });

  return new Promise<{
    url: string;
    close: () => Promise<void>;
    nextGeneration: () => void;
    resetGeneration: () => void;
  }>((resolve) => {
    server.listen(opts.port ?? 0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : opts.port;
      resolve({
        url: `http://127.0.0.1:${port}/v1`,
        close: () => new Promise((r) => server.close(() => r())),
        /** Advance to the next pipeline run, so transient faults clear. */
        nextGeneration: () => {
          generation += 1;
        },
        /**
         * Reset to generation 0 at the start of a task, so every benchmark
         * mode sees byte-identical initial faults for that task. Without
         * this the four modes would drift apart and the comparison would
         * measure fault luck rather than strategy.
         */
        resetGeneration: () => {
          generation = 0;
        },
      });
    });
  });
}

export { isEngineRetried };
