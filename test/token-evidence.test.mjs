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
