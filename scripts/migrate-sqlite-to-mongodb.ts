import { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { loadEnvFile } from "node:process";
import { databasePath, loadConfig, ROOT } from "../src/config.js";
import { connectMongo, TrackedWalletRepository } from "../src/mongo.js";
import type { Chain, Json } from "../src/types.js";

const envPath=join(ROOT,".env");if(existsSync(envPath))loadEnvFile(envPath);
const mongo=await connectMongo(),config=loadConfig(),counts:Record<string,number>={};
if(!mongo)throw new Error("MongoDB connection was not created");

const rows=(db:DatabaseSync,sql:string):Json[]=>{try{return db.prepare(sql).all() as Json[];}catch{return [];}};
const bulk=async(collection:string,items:Json[],key:(row:Json)=>Json)=>{if(!items.length)return;await mongo.db.collection(collection).bulkWrite(items.map(row=>({updateOne:{filter:key(row),update:{$set:row},upsert:true}})),{ordered:false});counts[collection]=(counts[collection]??0)+items.length;};

const botPath=join(ROOT,"bot.sqlite3");
if(existsSync(botPath)){
  const db=new DatabaseSync(botPath,{readOnly:true});
  try {
    await bulk("subscriptions",rows(db,"SELECT chat_id,chain FROM subscriptions"),row=>({chat_id:row.chat_id,chain:row.chain}));
    await bulk("bot_admins",rows(db,"SELECT user_id,username,granted_by,granted_at FROM bot_admins"),row=>({user_id:row.user_id}));
    await bulk("admin_invites",rows(db,"SELECT token_hash,created_by,created_at,expires_at,claimed_by,claimed_at FROM admin_invites"),row=>({token_hash:row.token_hash}));
  } finally {db.close();}
}

for(const chain of config.enabled_chains as Chain[]){
  const path=databasePath(config,chain);if(!existsSync(path))continue;const db=new DatabaseSync(path,{readOnly:true});
  try {
    await bulk("tracker_profiles",rows(db,"SELECT wallet,passed,score,funder,assessed_at,payload FROM profiles").map(row=>({...row,scope:chain,payload:JSON.parse(row.payload)})),row=>({scope:chain,wallet:row.wallet}));
    await bulk("tracker_alerts",rows(db,"SELECT token,window_start,tier,payload,created_at FROM alerts").map(row=>({...row,scope:chain,payload:JSON.parse(row.payload)})),row=>({scope:chain,token:row.token,window_start:row.window_start}));
    await bulk("trending_prices",rows(db,"SELECT token,sampled_at,price FROM trending_prices").map(row=>({...row,scope:chain})),row=>({scope:chain,token:row.token,sampled_at:row.sampled_at}));
    await bulk("metric_samples",rows(db,"SELECT token,metric,sampled_at,value FROM metric_samples").map(row=>({...row,scope:chain})),row=>({scope:chain,token:row.token,metric:row.metric,sampled_at:row.sampled_at}));
    await bulk("call_performance",rows(db,"SELECT * FROM call_performance").map(row=>({...row,scope:chain})),row=>({scope:chain,token:row.token}));
  } finally {db.close();}
}

const reportDir=join(ROOT,"reports"),gmgnFile=existsSync(reportDir)?readdirSync(reportDir).filter(name=>/^daily-wallet-scan-.*\.json$/.test(name)&&!name.includes("cache")).sort().at(-1):undefined;
if(gmgnFile){const report=JSON.parse(readFileSync(join(reportDir,gmgnFile),"utf8"));await new TrackedWalletRepository(mongo).replace("gmgn",report.generated_at??new Date().toISOString(),report.tracked_wallets??report.qualified_wallets??[]);counts.tracked_wallets_gmgn=(report.tracked_wallets??report.qualified_wallets??[]).length;}
const fomoPath=join(ROOT,"fomo","data","qualified-wallets.json");
if(existsSync(fomoPath)){const report=JSON.parse(readFileSync(fomoPath,"utf8"));await new TrackedWalletRepository(mongo).replace("fomo",report.generated_at??new Date().toISOString(),report.tracked_wallets??report.qualified_wallets??[]);counts.tracked_wallets_fomo=(report.tracked_wallets??report.qualified_wallets??[]).length;}

console.log(JSON.stringify({ok:true,migrated:counts},null,2));
await mongo.close();
