import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { Gnotx } from "../dist/gnotx.js";
import { loadConfig } from "../dist/config.js";

async function service(health, fn, cfg = {}) {
  const posts = [];
  const server = createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/healthz") return res.end(JSON.stringify(health));
    let body = "";
    for await (const b of req) body += b;
    posts.push({ path: req.url, body: JSON.parse(body) });
    res.end(JSON.stringify({ mode: "simulate", ok: true }));
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    await fn(
      new Gnotx({
        ...loadConfig(),
        chainId: "onyx-1",
        agentId: "developer",
        agentAddress: "g1agent",
        signerServiceUrl: `http://127.0.0.1:${server.address().port}`,
        ...cfg
      }),
      posts
    );
  } finally {
    await new Promise((r) => server.close(r));
  }
}
const ready = {
  ok: true,
  chainid: "onyx-1",
  caller: "g1agent",
  unsigned_simulation: true,
  execution_enabled: true
};

test("legacy signed simulator and wrong chain receive no transaction requests", async () => {
  for (const h of [
    { ...ready, unsigned_simulation: undefined },
    { ...ready, chainid: "gnoland-1" },
    { ...ready, caller: "g1other" }
  ]) {
    await service(h, async (g, posts) => {
      await assert.rejects(g.simulateCall("gno.land/r/demo/x", "Ping"));
      assert.equal(posts.length, 0);
    });
  }
});
test("disabled service execution cannot be enabled by the MCP client", async () => {
  await service({ ...ready, execution_enabled: false }, async (g, posts) => {
    await assert.rejects(g.broadcastCall("gno.land/r/demo/x", "Ping"));
    assert.equal(posts.length, 0);
  });
});
test("unsigned simulation forwards the caller and public key", async () => {
  await service(ready, async (g, posts) => {
    await g.simulateCall("gno.land/r/demo/x", "Ping", ["1"], "", "g1agent", "02abcd");
    assert.equal(posts[0].path, "/simulate");
    assert.equal(posts[0].body.caller, "g1agent");
    assert.equal(posts[0].body.public_key, "02abcd");
  });
});

test("hosted simulation refuses any backend holding a signing key", async () => {
  await service(
    { ...ready, keyless: false, execution_enabled: false },
    async (g, posts) => {
      await assert.rejects(g.simulateCall("gno.land/r/demo/x", "Ping"));
      assert.equal(posts.length, 0);
    },
    { transport: "http" }
  );
});

test("execution forwards the approved storage ceiling separately from total costs", async () => {
  await service(ready, async (g, posts) => {
    await g.broadcastCall("gno.land/r/demo/x", "Ping", [], "1000ugnot", {
      gasWanted: 11825188,
      feeUgnot: "359827",
      storageDepositUgnot: "206100"
    });
    assert.equal(posts[0].body.max_fee_ugnot, "359827");
    assert.equal(posts[0].body.max_storage_deposit_ugnot, "206100");
  });
});
