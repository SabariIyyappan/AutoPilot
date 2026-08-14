/**
 * Local fault-injecting MCP server (Streamable HTTP transport).
 *
 * The engine's `mcp_client` node points its `http.endpoint` config directly
 * here, so `mcp_timeout` / `tool_unavailable` are real MCP-protocol failures
 * the engine genuinely experiences — same principle as `proxy.ts` for LLM
 * faults (see docs/architecture.md's determinism model).
 *
 * Implements just enough of MCP over JSON-RPC 2.0 / Streamable HTTP to be a
 * real tool an agent can call: `initialize`, `tools/list`, `tools/call`.
 *
 * NOTE ON LIVE VERIFICATION: unlike proxy.ts (live-smoke-tested against the
 * running engine in P2 — see docs/architecture.md), this server's protocol
 * correctness against the real `mcp_client` node is deferred to P5/P6, when
 * scenario B (capability substitution) is built and the demo pipeline needs
 * a real MCP tool anyway. Same trade-off already made for Q3 in P0: cheap to
 * verify for real once the consuming pipeline exists, not before. Its own
 * JSON-RPC framing is unit-tested here with no engine required.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { fault, type FaultProfile } from './schedule.ts';

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpServerOptions {
  seed: number;
  profile?: FaultProfile;
  nodeId: string;
  tools: ToolDef[];
  /** Deterministic canned result for a tool call, keyed by tool name + args. */
  call: (toolName: string, args: unknown) => unknown;
  taskIdOf: (args: unknown) => string;
  /** How long to hang before responding on a simulated timeout. Kept small for test speed. */
  timeoutHangMs?: number;
  port?: number;
}

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

function jsonRpcResult(id: JsonRpcRequest['id'], result: unknown) {
  return JSON.stringify({ jsonrpc: '2.0', id, result });
}

function jsonRpcError(id: JsonRpcRequest['id'], code: number, message: string) {
  return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
}

function makeAttemptCounter() {
  const counts = new Map<string, number>();
  return (taskId: string) => {
    const n = counts.get(taskId) ?? 0;
    counts.set(taskId, n + 1);
    return n;
  };
}

export function startFaultMcpServer(opts: McpServerOptions) {
  const nextAttempt = makeAttemptCounter();
  const timeoutHangMs = opts.timeoutHangMs ?? 5000;

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'content-type': 'application/json' });
      res.end(jsonRpcError(null, -32600, 'method not allowed'));
      return;
    }

    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let rpc: JsonRpcRequest;
      try {
        rpc = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(jsonRpcError(null, -32700, 'parse error'));
        return;
      }

      res.setHeader('content-type', 'application/json');

      switch (rpc.method) {
        case 'initialize': {
          res.writeHead(200);
          res.end(
            jsonRpcResult(rpc.id, {
              protocolVersion: '2025-06-18',
              capabilities: { tools: {} },
              serverInfo: { name: 'autopilot-chaos-mcp', version: '0.0.0' },
            }),
          );
          return;
        }

        case 'tools/list': {
          res.writeHead(200);
          res.end(jsonRpcResult(rpc.id, { tools: opts.tools }));
          return;
        }

        case 'tools/call': {
          const params = rpc.params ?? {};
          const toolName = String(params.name ?? '');
          const args = params.arguments ?? {};
          const taskId = opts.taskIdOf(args);
          const attemptIndex = nextAttempt(taskId);
          const f = fault(opts.seed, taskId, opts.nodeId, attemptIndex, opts.profile);

          if (f === 'mcp_timeout') {
            // A genuine hang — the client (mcp_client node) must time out on
            // its own end. We do not close the connection ourselves.
            setTimeout(() => {
              if (!res.writableEnded) {
                res.writeHead(200);
                res.end(jsonRpcResult(rpc.id, { content: [{ type: 'text', text: 'late response after simulated timeout' }] }));
              }
            }, timeoutHangMs);
            return;
          }

          if (f === 'tool_unavailable') {
            res.writeHead(200);
            res.end(jsonRpcError(rpc.id, -32001, `tool "${toolName}" is temporarily unavailable`));
            return;
          }

          try {
            const result = opts.call(toolName, args);
            res.writeHead(200);
            res.end(jsonRpcResult(rpc.id, { content: [{ type: 'text', text: JSON.stringify(result) }] }));
          } catch (err) {
            res.writeHead(200);
            res.end(jsonRpcError(rpc.id, -32000, err instanceof Error ? err.message : String(err)));
          }
          return;
        }

        default: {
          res.writeHead(200);
          res.end(jsonRpcError(rpc.id, -32601, `method not found: ${rpc.method}`));
        }
      }
    });
  });

  return new Promise<{ url: string; close: () => Promise<void> }>((resolve) => {
    server.listen(opts.port ?? 0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : opts.port;
      resolve({
        url: `http://127.0.0.1:${port}/mcp`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}
