import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { Meter, metered } from "../dist/meter.js";
import { loadConfig } from "../dist/config.js";

test("hosted direct tools require explicit usage authorization; local no-key reads remain public", async () => {
  let status = 200,
    body = { ok: true, allowed: true },
    delay = 0;
  const server = createServer(async (req, res) => {
    for await (const chunk of req) {
    }
    if (delay) await new Promise((r) => setTimeout(r, delay));
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(typeof body === "string" ? body : JSON.stringify(body));
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  const cfg = {
    ...loadConfig(),
    transport: "http",
    requireApiKey: true,
    apiKey: "test-key",
    timeoutMs: 1000,
    apiBase: `http://127.0.0.1:${server.address().port}`
  };
  let handler,
    executed = 0;
  const fake = {
    registerTool: (_name, _cfg, fn) => {
      handler = fn;
    }
  };
  const proxy = metered(fake, new Meter(cfg));
  proxy.registerTool("gno_simulate", {}, () => {
    executed++;
    return { content: [] };
  });
  try {
    await handler({}, {});
    assert.equal(executed, 1);
    for (const response of [{ ok: false, allowed: false }, { ok: true }, { allowed: true }, "not json"]) {
      body = response;
      assert.equal((await handler({}, {})).isError, true);
      assert.equal(executed, 1);
    }
    status = 401;
    body = { reason: "invalid key" };
    assert.equal((await handler({}, {})).isError, true);
    status = 429;
    body = { reason: "quota exceeded" };
    assert.equal((await handler({}, {})).isError, true);
    status = 200;
    body = { ok: true, allowed: true };
    delay = 100;
    cfg.timeoutMs = 20;
    assert.equal((await handler({}, {})).isError, true);
    assert.equal(executed, 1);
    assert.equal(await new Meter({ ...cfg, apiKey: undefined }).check("gno_simulate"), "API key required");
    assert.equal(
      await new Meter({ ...cfg, apiKey: undefined, transport: "stdio" }).check("gno_status"),
      null
    );
    assert.equal(
      await new Meter({ ...cfg, apiKey: undefined, requireApiKey: false }).check("gno_status"),
      null
    );
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
  const offline = { ...cfg, apiBase: "http://127.0.0.1:9" };
  assert.match(await new Meter(offline).check("gno_simulate"), /unavailable/);
  assert.equal(await new Meter({ ...offline, transport: "stdio" }).check("gno_status"), null);
});

test("trusted reservations finalize before output; failed completion withholds data", async () => {
  const calls=[];
  let allowFinish=true;
  const server=createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;
    const body=JSON.parse(raw);calls.push({body,service:req.headers['x-gp-meter-service']});
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify(body.action==='reserve'
      ? {ok:true,allowed:true,accounting_version:2,reservation:'receipt'}
      : {ok:true,allowed:allowFinish}));
  }).listen(0,'127.0.0.1');
  await once(server,'listening');
  const meter=new Meter({...loadConfig(),transport:'http',apiKey:'test',meterServiceToken:'service-test',
    apiBase:`http://127.0.0.1:${server.address().port}`});
  try{
    const result=await meter.execute('gno_status',()=>({content:[{type:'text',text:'useful'}]}));
    assert.equal(result.content[0].text,'useful');
    assert.deepEqual(calls.map(c=>c.body.action),['reserve','finish']);
    assert.equal(calls[1].body.successful,true);
    assert.equal(calls[0].service,'service-test');
    allowFinish=false;
    const withheld=await meter.execute('gno_status',()=>({content:[{type:'text',text:'secret-result'}]}));
    assert.equal(withheld.isError,true);
    assert.doesNotMatch(JSON.stringify(withheld),/secret-result/);
    allowFinish=true;
    await meter.execute('gno_status',()=>({content:[],isError:true}));
    assert.equal(calls.at(-1).body.successful,false);
    await assert.rejects(meter.execute('gno_status',()=>{throw Error('provider down')}));
    assert.equal(calls.at(-1).body.successful,false);
  }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});
