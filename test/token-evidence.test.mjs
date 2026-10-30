import {test} from 'node:test';
import assert from 'node:assert/strict';
import {registerTokenTools} from '../dist/tools/tokens.js';
function tools(rpc,chain='gnoland-1'){
 const handlers={};registerTokenTools({registerTool(name,_config,handler){handlers[name]=handler}},rpc,'gno.land/r/nt/grc20reg/v0',chain);return handlers;
}
const value=result=>JSON.parse(result.content[0].text);
test('absence and upstream failure cannot become empty registry or zero token balance',async()=>{
 const handlers=tools({qrender:async()=>({absent:true}),qeval:async()=>({absent:true})});
 assert.equal((await handlers.gno_token_registry({})).isError,true);
 assert.equal((await handlers.gno_token_metadata({token:'missing'})).isError,true);
 assert.equal((await handlers.gno_token_balance({token:'missing',address:'g1alice'})).isError,true);
 assert.equal((await handlers.gno_grc721({pkgpath:'missing'})).isError,true);
 const failed=tools({qeval:async()=>{throw Error('upstream unavailable')}});
 assert.equal((await failed.gno_grc721({pkgpath:'missing'})).isError,true);
});
test('verified Onyx placeholder correction preserves raw supply and legitimate zero balances',async()=>{
 const rpc={qeval:async expr=>expr.includes('GetName')?'("wrapped GNOT" string)':expr.includes('GetSymbol')?'("wugnot" string)':expr.includes('TotalSupply')?'(737850997 int64)':'(0 int64)'};
 const handlers=tools(rpc,'onyx-1');
 const meta=value(await handlers.gno_token_metadata({token:'gno.land/r/gnoland/wugnot.wugnot'}));
 assert.equal(meta.decimals,6);assert.equal(meta.decimals_onchain,0);assert.equal(meta.total_supply,737850997);
 assert.equal(value(await handlers.gno_token_balance({token:'gno.land/r/gnoland/wugnot.wugnot',address:'g1alice'})).balance_raw,0);
 const unknown=value(await tools(rpc,'unknown-chain').gno_token_metadata({token:'gno.land/r/gnoland/wugnot.wugnot'}));
 assert.equal(unknown.decimals,0);
});
test('a bare realm resolves to its one registry key and native ugnot is pointed elsewhere',async()=>{
 const render='[gns](/r/nt/grc20reg/v0:gno.land/r/gnoswap/gns.GNS) [a](/r/nt/grc20reg/v0:gno.land/r/demo/fac.A) [b](/r/nt/grc20reg/v0:gno.land/r/demo/fac.B)';
 const seen=[];
 const rpc={qrender:async()=>render,qeval:async expr=>{seen.push(expr);return expr.includes('BalanceOf')?'(982581 uint64)':'(1 int64)'}};
 const handlers=tools(rpc);
 assert.equal(value(await handlers.gno_token_balance({token:'gno.land/r/gnoswap/gns',address:'g1alice'})).token,'gno.land/r/gnoswap/gns.GNS');
 assert.ok(seen.every(e=>e.includes('"gno.land/r/gnoswap/gns.GNS"')));
 const several=await handlers.gno_token_metadata({token:'gno.land/r/demo/fac'});
 assert.equal(several.isError,true);assert.match(several.content[0].text,/fac\.A, gno\.land\/r\/demo\/fac\.B/);
 const native=await handlers.gno_token_metadata({token:'ugnot'});
 assert.equal(native.isError,true);assert.match(native.content[0].text,/gno_get_balances/);
});
