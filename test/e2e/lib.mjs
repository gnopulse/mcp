// Shared helpers for the end-to-end checks. Every check runs offline: the MCP server
// is pointed at local mock services and at an unreachable RPC endpoint.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SERVER_ENTRY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../dist/index.js");

const OFFLINE = "http://127.0.0.1:9";
const TIMEOUT_MS = 30_000;

let failures = 0;

/** Record and print one assertion. */
export function check(name, passed, detail = "") {
  if (!passed) failures++;
  console.log(`${passed ? "ok  " : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
}

/** Run `fn`, then exit non-zero if any check failed, `fn` threw, or it timed out. */
export async function run(fn) {
  const timer = setTimeout(() => {
    console.error(`FAIL timed out after ${TIMEOUT_MS}ms`);
    process.exit(1);
  }, TIMEOUT_MS);
  try {
    await fn();
  } catch (e) {
    failures++;
    console.error(`FAIL ${e?.stack || e}`);
  }
  clearTimeout(timer);
  console.log(failures ? `${failures} check(s) failed` : "all checks passed");
  process.exit(failures ? 1 : 0);
}

/** Environment for a server under test: inherited GnoPulse/gno settings removed, network offline. */
export function serverEnv(overrides = {}) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !/^(GNOPULSE_|GNOTX_|GNO_)/.test(k)),
  );
  return { ...env, GNO_RPC_URLS: OFFLINE, GNOPULSE_API_BASE: OFFLINE, ...overrides };
}

/** Start a JSON HTTP mock on a random port. `handler(req, body)` returns the response object. */
export async function startMock(handler) {
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(await handler(req, body ? JSON.parse(body) : undefined)));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

/** A free local TCP port. */
export async function freePort() {
  const server = createServer().listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** Spawn the server over stdio and complete the MCP handshake. */
export async function startStdioClient(env) {
  const child = spawn(process.execPath, [SERVER_ENTRY], { stdio: ["pipe", "pipe", "inherit"], env });
  const pending = new Map();
  let nextId = 0;
  let buffer = "";

  child.stdout.on("data", (data) => {
    buffer += data;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      pending.get(msg.id)?.(msg);
      pending.delete(msg.id);
    }
  });

  const send = (msg) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`);
  const request = (method, params = {}) =>
    new Promise((resolve) => {
      const id = ++nextId;
      pending.set(id, resolve);
      send({ id, method, params });
    });

  await request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "e2e", version: "0" },
  });
  send({ method: "notifications/initialized" });

  return {
    request,
    /** Call a tool and parse its JSON text result. */
    async callTool(name, args = {}) {
      const msg = await request("tools/call", { name, arguments: args });
      return JSON.parse(msg.result.content[0].text);
    },
    close: () => child.kill(),
  };
}

/** Spawn the server expecting it to exit; resolves with the exit code and stderr. */
export async function runToExit(env) {
  const child = spawn(process.execPath, [SERVER_ENTRY], { stdio: ["ignore", "ignore", "pipe"], env });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  const [code] = await once(child, "exit");
  return { code, stderr };
}
