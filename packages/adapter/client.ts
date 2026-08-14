/**
 * The ONLY file in the project that talks to the RocketRide SDK.
 *
 * Everything above this line in the architecture (core, diagnosis, control,
 * verify, chaos) is pure TypeScript over our own event model, and
 * scripts/check-seam.mjs makes that a build failure if violated.
 */
import { RocketRideClient } from 'rocketride';
import type { ExecutionEvent } from '../core/types.ts';
import { normalizeFlowFrame, type FlowFrameBody } from './normalize.ts';
import type { PipelineConfig } from './pipeline.ts';

/**
 * Localhost auth: the OSS account module accepts ANY non-empty credential
 * when ROCKETRIDE_APIKEY is unset server-side, but the client must still send
 * something or the server returns "401 No authorization provided" (found in
 * P0 — the hosted docs claim no auth is needed, which is not true).
 */
const LOCAL_DEV_CREDENTIAL = 'autopilot-local-dev';

export interface RunResult {
  ok: boolean;
  /** Raw pipeline result payload from send(). */
  result?: Record<string, unknown>;
  /** Normalized per-node events observed during the run. */
  events: ExecutionEvent[];
  /** Engine warnings — the authoritative failure channel (see P2 findings). */
  warnings: string[];
  errors: string[];
  latencyMs: number;
  error?: string;
}

export interface EngineClientOptions {
  uri?: string;
  runId: string;
}

export class EngineClient {
  private client: RocketRideClient;
  private runId: string;
  private events: ExecutionEvent[] = [];
  /**
   * Pipeline JSON -> live task token.
   *
   * MEASURED (spike/throughput.mjs): `use()` costs ~10.9s because it
   * instantiates the pipeline, while `send()` on an existing task costs
   * ~28ms. Execution is not the expensive part — instantiation is. Caching
   * instances by their JSON makes the benchmark ~400x faster and is what
   * makes a 4-mode x 100-task run practical at all.
   */
  private taskCache = new Map<string, { token: string; warningsSeen: number }>();

  constructor(opts: EngineClientOptions) {
    this.runId = opts.runId;
    this.client = new RocketRideClient({
      uri: opts.uri ?? 'ws://localhost:5565',
      auth: LOCAL_DEV_CREDENTIAL,
      onEvent: async (evt: { event?: string; body?: unknown }) => {
        if (evt.event === 'apaevt_flow' && evt.body) {
          this.events.push(normalizeFlowFrame(evt.body as FlowFrameBody, this.runId));
        }
      },
    });
  }

  async connect(): Promise<void> {
    await this.client.connect();
  }

  async disconnect(): Promise<void> {
    try {
      await this.client.disconnect();
    } catch {
      // Disconnect failures are not interesting — the run is already over.
    }
  }

  /**
   * Execute one pipeline document and collect everything Autopilot needs to
   * reason about what happened.
   */
  async run(pipeline: PipelineConfig, input: string, label = 'autopilot'): Promise<RunResult> {
    this.events = [];
    const started = Date.now();
    let token: string | undefined;

    try {
      const used = await this.client.use({ pipeline, threads: 1, name: label });
      token = used.token;
      await this.client.setEvents(token, ['flow', 'summary']);

      let result: Record<string, unknown> | undefined;
      let ok = true;
      let error: string | undefined;

      try {
        result = (await this.client.send(token, input, undefined, 'text/plain')) as Record<
          string,
          unknown
        >;
      } catch (err) {
        ok = false;
        error = err instanceof Error ? err.message : String(err);
      }

      // Let trailing status frames land before reading final state.
      await new Promise((r) => setTimeout(r, 300));
      const status = await this.client.getTaskStatus(token);

      return {
        ok,
        result,
        events: [...this.events],
        warnings: (status.warnings ?? []) as string[],
        errors: (status.errors ?? []) as string[],
        latencyMs: Date.now() - started,
        error,
      };
    } catch (err) {
      return {
        ok: false,
        events: [...this.events],
        warnings: [],
        errors: [],
        latencyMs: Date.now() - started,
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      if (token) {
        try {
          await this.client.terminate(token);
        } catch {
          // Best-effort cleanup.
        }
      }
    }
  }

  /**
   * Like `run()`, but reuses a live task instance for an identical pipeline.
   *
   * Warnings are cumulative per task, so reusing an instance means a warning
   * from an earlier send would otherwise still be visible on a later one and
   * cause a false failure detection. We therefore track how many warnings
   * we've already accounted for and only surface the delta.
   */
  async runCached(pipeline: PipelineConfig, input: string, label = 'autopilot'): Promise<RunResult> {
    const key = JSON.stringify(pipeline);
    const started = Date.now();
    let entry = this.taskCache.get(key);

    try {
      if (!entry) {
        const used = await this.client.use({ pipeline, threads: 1, name: label });
        await this.client.setEvents(used.token, ['flow', 'summary']);
        entry = { token: used.token, warningsSeen: 0 };
        this.taskCache.set(key, entry);
      }

      this.events = [];
      let result: Record<string, unknown> | undefined;
      let ok = true;
      let error: string | undefined;

      try {
        result = (await this.client.send(entry.token, input, undefined, 'text/plain')) as Record<
          string,
          unknown
        >;
      } catch (err) {
        ok = false;
        error = err instanceof Error ? err.message : String(err);
      }

      const status = await this.client.getTaskStatus(entry.token);
      const allWarnings = (status.warnings ?? []) as string[];
      const fresh = allWarnings.slice(entry.warningsSeen);
      entry.warningsSeen = allWarnings.length;

      return {
        ok,
        result,
        events: [...this.events],
        warnings: fresh,
        errors: (status.errors ?? []) as string[],
        latencyMs: Date.now() - started,
        error,
      };
    } catch (err) {
      return {
        ok: false,
        events: [],
        warnings: [],
        errors: [],
        latencyMs: Date.now() - started,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /** Tear down every cached task instance. */
  async releaseAll(): Promise<void> {
    for (const { token } of this.taskCache.values()) {
      try {
        await this.client.terminate(token);
      } catch {
        // Best-effort.
      }
    }
    this.taskCache.clear();
  }

  /** Registered component catalog — the capability registry's raw source. */
  async services(): Promise<Record<string, unknown>> {
    const res = (await this.client.getServices()) as { services?: Record<string, unknown> };
    return res.services ?? {};
  }
}
