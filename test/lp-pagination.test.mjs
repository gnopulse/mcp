import {test} from 'node:test';
import assert from 'node:assert/strict';
import {registerV2Tools} from '../dist/tools/v2.js';

for (const [eventsMore,contributorsMore] of [[true,false],[false,true],[false,false],[true,true]]) {
 test(`LP event continuation ${eventsMore} is independent of contributor continuation ${contributorsMore}`,async()=>{
  let handler;const calls=[];
  const data={offset:500,limit:500,count:contributorsMore?1200:430,event_count:1758,
   has_more:contributorsMore,events_has_more:eventsMore,next_cursor:eventsMore?'event-page-3':null,
   providers:[],events:[],current_owners:[]};
  registerV2Tools({registerTool(name,_config,fn){if(name==='gno_pool_lp_providers')handler=fn;}},
   {getV2:async(path,query)=>{calls.push({path,query});return{data,meta:{quota:{remaining:10}}};}});
  const result=JSON.parse((await handler({pool:'pool',limit:500,offset:500,before:'event-page-2'})).content[0].text);
  assert.equal(result.has_more,eventsMore);
  assert.equal(result.next_cursor,eventsMore?'event-page-3':null);
  assert.equal(result.contributors_has_more,contributorsMore);
  assert.equal(result.next_offset,contributorsMore?1000:null);
  assert.deepEqual(result.items,data);
  assert.deepEqual(calls[0].query,{limit:500,offset:500,before:'event-page-2'});
 });
}
