// Measure: does reusing one engine task across sends cut the ~10s per-run cost?
import { RocketRideClient } from 'rocketride';
import { createServer } from 'node:http';

const server = createServer((req, res) => {
  const c=[]; req.on('data',x=>c.push(x));
  req.on('end',()=>{ res.writeHead(200,{'content-type':'application/json'});
    res.end(JSON.stringify({id:'x',object:'chat.completion',created:1,model:'m',
      choices:[{index:0,message:{role:'assistant',content:'OK'},finish_reason:'stop'}],
      usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}));});
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const url=`http://127.0.0.1:${server.address().port}/v1`;

const pipeline={version:1,source:'in',components:[
 {id:'in',provider:'webhook',config:{hideForm:true,mode:'Source',type:'webhook',parameters:{}}},
 {id:'ask',provider:'prompt',config:{type:'prompt',instructions:['Answer.']},input:[{lane:'text',from:'in'}]},
 {id:'reason',provider:'llm_openai_api',config:{profile:'custom',custom:{model:'m',base_url:url,apikey:'k',modelTotalTokens:4096}},input:[{lane:'questions',from:'ask'}]},
 {id:'out',provider:'response_answers',config:{laneName:'answers'},input:[{lane:'answers',from:'reason'}]}]};

const client=new RocketRideClient({uri:'ws://localhost:5565',auth:'autopilot-local-dev'});
await client.connect();

let t=Date.now();
const {token}=await client.use({pipeline,threads:1,name:'throughput'});
console.log(`use() cost: ${Date.now()-t}ms`);

for (let i=0;i<5;i++){
  t=Date.now();
  await client.send(token,`q${i}`,undefined,'text/plain');
  console.log(`  send #${i}: ${Date.now()-t}ms`);
}
await client.terminate(token); await client.disconnect(); server.close();
