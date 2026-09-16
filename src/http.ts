/**
 * Streamable HTTP transport for a hosted server. Each session binds the API key
 * presented on its initialize request, so API usage is metered per caller.
 * Serves the MCP endpoint at both `/` and `/mcp`, plus `/healthz`. Sessions are bounded
 * in number and closed after an idle timeout (see sessions.ts).
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { withApiKey, type Config } from "./config.js";
import { buildMcpServer, type SharedDeps } from "./server.js";
import { SessionStore } from "./sessions.js";

const MAX_BODY_BYTES = 4 * 1024 * 1024;
const SWEEP_INTERVAL_MS = 60 * 1000;

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text) return resolve(undefined);
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

/** The caller's API key from `X-API-Key` or `Authorization: Bearer`. */
function apiKeyFrom(req: IncomingMessage): string | undefined {
  const header = req.headers["x-api-key"];
  if (typeof header === "string" && header) return header;
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) return auth.slice("Bearer ".length).trim() || undefined;
  return undefined;
}

function sendJsonRpcError(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }));
}

export async function startHttpServer(baseCfg: Config, deps: SharedDeps): Promise<void> {
  const sessions = new SessionStore<StreamableHTTPServerTransport>();
  setInterval(() => sessions.sweep(), SWEEP_INTERVAL_MS).unref();

  async function openSession(req: IncomingMessage, res: ServerResponse, body: unknown): Promise<void> {
    const key = apiKeyFrom(req);
    if (baseCfg.requireApiKey && !key) {
      sendJsonRpcError(res, 401, "API key required (send X-API-Key or Authorization: Bearer)");
      return;
    }
    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => {
        sessions.add(sid, transport);
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
    };
    await buildMcpServer(withApiKey(baseCfg, key), deps).connect(transport);
    await transport.handleRequest(req, res, body);
  }

  const httpServer = createServer(async (req, res) => {
    const { pathname } = new URL(req.url ?? "/", "http://localhost");

    if (pathname === "/healthz") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, sessions: sessions.size }));
      return;
    }
    if (pathname !== "/mcp" && pathname !== "/") {
      res.writeHead(404).end();
      return;
    }

    const sessionId = req.headers["mcp-session-id"];
    const findSession = () => (typeof sessionId === "string" ? sessions.get(sessionId) : undefined);

    try {
      switch (req.method) {
        case "POST": {
          const body = await readJsonBody(req);
          const session = findSession();
          if (session) {
            await session.handleRequest(req, res, body);
          } else if (!sessionId && isInitializeRequest(body)) {
            await openSession(req, res, body);
          } else {
            sendJsonRpcError(res, 400, "No valid session ID, and not an initialize request");
          }
          return;
        }
        case "GET":
        case "DELETE": {
          const session = findSession();
          if (!session) {
            sendJsonRpcError(res, 400, "Missing or unknown mcp-session-id");
            return;
          }
          await session.handleRequest(req, res);
          return;
        }
        default:
          res.writeHead(405).end();
      }
    } catch (e) {
      if (!res.headersSent) sendJsonRpcError(res, 500, e instanceof Error ? e.message : String(e));
    }
  });

  await new Promise<void>((resolve) => httpServer.listen(baseCfg.httpPort, baseCfg.httpHost, resolve));
  process.stderr.write(
    `gnopulse-mcp HTTP on http://${baseCfg.httpHost}:${baseCfg.httpPort}/mcp (require-key=${baseCfg.requireApiKey})\n`,
  );
}
