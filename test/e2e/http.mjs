// Streamable HTTP transport: session handshake, tool listing, per-session API key
// forwarding to the REST API, the require-key gate, and /healthz.
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { check, freePort, run, serverEnv, startMock, SERVER_ENTRY } from "./lib.mjs";

const CALLER_KEY = "test-key";
const ACCEPT = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "e2e", version: "0" } },
};

const sseMessages = (text) =>
  text
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => JSON.parse(line.slice(5).trim()));

async function startHttpServer(env) {
  const port = await freePort();
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    stdio: ["ignore", "ignore", "inherit"],
    env: serverEnv({ ...env, GNOPULSE_MCP_TRANSPORT: "http", GNOPULSE_MCP_PORT: String(port) }),
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50; i++) {
    if (await fetch(`${base}/healthz`).then((r) => r.ok, () => false)) break;
    await sleep(100);
  }
  const post = (body, headers = {}) =>
    fetch(`${base}/mcp`, { method: "POST", headers: { ...ACCEPT, ...headers }, body: JSON.stringify(body) });
  return { base, post, close: () => child.kill() };
}

await run(async () => {
  const api = await startMock((req) => ({ data: { path: req.url, received_api_key: req.headers["x-api-key"] ?? null } }));
  const server = await startHttpServer({ GNOPULSE_API_BASE: api.url });
  try {
    const init = await server.post(INITIALIZE, { "X-API-Key": CALLER_KEY });
    const sid = init.headers.get("mcp-session-id");
    const [initMsg] = sseMessages(await init.text());
    check("initialize returns a session id", Boolean(sid));
    check("initialize returns server info", initMsg?.result?.serverInfo?.name === "gnopulse");

    const session = { "mcp-session-id": sid };
    await server.post({ jsonrpc: "2.0", method: "notifications/initialized" }, session);

    const list = await server.post({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, session);
    const tools = sseMessages(await list.text())[0]?.result?.tools ?? [];
    check("tools/list returns tools", tools.length > 0, `${tools.length} tools`);

    const call = await server.post(
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "gno_prices", arguments: {} } },
      session,
    );
    const text = sseMessages(await call.text())[0]?.result?.content?.[0]?.text ?? "{}";
    const echoed = JSON.parse(text);
    check("REST call uses the v2 API", echoed.path === "/api/v2/prices", echoed.path);
    check("session API key is forwarded", echoed.received_api_key === CALLER_KEY, echoed.received_api_key);

    const noSession = await server.post({ jsonrpc: "2.0", id: 4, method: "tools/list", params: {} });
    check("request without a session is rejected", noSession.status === 400, String(noSession.status));

    const health = await (await fetch(`${server.base}/healthz`)).json();
    check("healthz reports the session", health.ok === true && health.sessions === 1, JSON.stringify(health));
  } finally {
    server.close();
  }

  const gated = await startHttpServer({ GNOPULSE_API_BASE: api.url, GNOPULSE_MCP_REQUIRE_KEY: "1" });
  try {
    const anonymous = await gated.post(INITIALIZE);
    check("require-key rejects an anonymous initialize", anonymous.status === 401, String(anonymous.status));
    const keyed = await gated.post(INITIALIZE, { Authorization: `Bearer ${CALLER_KEY}` });
    check("require-key accepts a bearer key", keyed.ok && Boolean(keyed.headers.get("mcp-session-id")), String(keyed.status));
    await keyed.text();
  } finally {
    gated.close();
    api.close();
  }
});
