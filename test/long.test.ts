import assert from "node:assert/strict";
import test from "node:test";
import { normalizeLongAsset, qualifyLongAssets } from "../src/long/analysis.js";
import { LongClient, longAssetRows } from "../src/long/client.js";

const now=2_000_000,address="0x1111111111111111111111111111111111111111";

test("normalizes Long Robinhood assets and keeps only fresh bounded launches",()=>{
  const row={tokenAddress:address,name:"Fresh",ticker:"NEW",fdvUsd:20_000,createdAt:new Date((now-120)*1000).toISOString(),volume24hUsd:8_000,tradeCount:12,status:"active"},normalized=normalizeLongAsset(row,now)!;
  assert.equal(normalized.chain,"robinhood");assert.equal(normalized.symbol,"NEW");assert.equal(normalized.market_cap,20_000);assert.equal(normalized.long_launch_age_seconds,120);
  const qualified=qualifyLongAssets([row,{...row,tokenAddress:"0x2222222222222222222222222222222222222222",createdAt:new Date((now-30_000)*1000).toISOString()},{...row,tokenAddress:"0x3333333333333333333333333333333333333333",fdvUsd:2_000_000}],now,false);
  assert.equal(qualified.length,1);assert.deepEqual(qualified[0]?.degen_signal_labels,["LONG NEW LAUNCH"]);
});

test("Long payload parser accepts the live assets envelope and GraphQL-style nesting",()=>{
  assert.equal(longAssetRows({assets:[{address}]}).length,1);
  assert.equal(longAssetRows({data:{assets:[{address}]}}).length,1);
  assert.equal(longAssetRows({data:{graphqlRequest:{nodes:[{tokenAddress:address}]}}}).length,1);
  assert.deepEqual(longAssetRows({data:{unrelated:true}}),[]);
});

test("Long client uses the live Robinhood asset catalog without authentication",async()=>{
  const previous={url:process.env.LONG_API_URL,method:process.env.LONG_API_METHOD};process.env.LONG_API_URL="https://api.long.xyz/v1/assets";process.env.LONG_API_METHOD="GET";let requested="";
  try{const client=new LongClient(async input=>{requested=String(input);return new Response(JSON.stringify({assets:[{tokenAddress:address}]}),{status:200,headers:{"content-type":"application/json"}});});const snapshot=await client.assets();assert.equal(snapshot.assets.length,1);assert.match(requested,/chainId=4663/);assert.match(requested,/status=all/);}
  finally{if(previous.url===undefined)delete process.env.LONG_API_URL;else process.env.LONG_API_URL=previous.url;if(previous.method===undefined)delete process.env.LONG_API_METHOD;else process.env.LONG_API_METHOD=previous.method;}
});
