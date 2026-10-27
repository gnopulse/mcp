import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {registerReadTools} from '../dist/tools/read.js';
import {registerV2Tools} from '../dist/tools/v2.js';
import {registerChainTools} from '../dist/tools/chain.js';
import {registerTokenTools} from '../dist/tools/tokens.js';
import {registerExecutionTools} from '../dist/tools/execution.js';

const manifest=JSON.parse(fs.readFileSync(new URL('../capabilities.json',import.meta.url)));
function registered(readOnly){
 const names=[];const server={registerTool(name){names.push(name)}};
 registerReadTools(server,{});registerV2Tools(server,{});registerChainTools(server,{});
 registerTokenTools(server,{},'gno.land/r/nt/grc20reg/v0');
 registerExecutionTools(server,{gnotx:{},rpc:{},policy:{},signer:null,approvals:{},chainId:'gnoland-1',readOnly,simulationAvailable:true});
 return names.sort();
}
test('versioned capability manifest matches registered tools and transport restrictions',()=>{
 assert.deepEqual(registered(false),manifest.tools.map(t=>t.name).sort());
 assert.deepEqual(registered(true),manifest.tools.filter(t=>t.transport!=='local only').map(t=>t.name).sort());
});
