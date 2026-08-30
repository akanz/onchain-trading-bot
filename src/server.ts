import Fastify from "fastify";
import { parseChain } from "./config.js";
import type { TrackerService } from "./service.js";
import type { TrackerConfig } from "./types.js";
import type { AlertStream } from "./alert-stream.js";

export function createServer(service:TrackerService,config:TrackerConfig,stream:AlertStream) {
  const app=Fastify({logger:true});
  const protect=async(req:any,reply:any)=>{const expected=process.env.WEB_API_TOKEN;if(!expected||req.headers.authorization!==`Bearer ${expected}`)return reply.code(401).send({error:"Unauthorized"});};
  app.get("/health",async()=>({ok:true,chains:config.enabled_chains}));
  app.get("/api/chains",async()=>({chains:config.enabled_chains,default:config.default_chain}));
  app.get("/api/roster/:chain",async(req:any)=>{const chain=parseChain(req.params.chain,config);return {chain,wallets:service.roster(chain)};});
  app.get("/api/alerts/:chain",async(req:any)=>{const chain=parseChain(req.params.chain,config);return {chain,alerts:service.alerts(chain,Math.min(Number(req.query?.limit)||50,200))};});
  app.get("/api/stream",async(req,reply)=>{
    reply.hijack();
    reply.raw.writeHead(200,{
      "Content-Type":"text/event-stream; charset=utf-8",
      "Cache-Control":"no-cache, no-transform",
      "Connection":"keep-alive",
      "X-Accel-Buffering":"no",
    });
    reply.raw.write(`event: ready\ndata: ${JSON.stringify({ok:true,chains:config.enabled_chains})}\n\n`);
    const alert=(payload:unknown)=>reply.raw.write(`event: alert\ndata: ${JSON.stringify(payload)}\n\n`);
    const scan=(payload:unknown)=>reply.raw.write(`event: scan\ndata: ${JSON.stringify(payload)}\n\n`);
    const heartbeat=setInterval(()=>reply.raw.write(": heartbeat\n\n"),15000);
    heartbeat.unref();
    stream.on("alert",alert); stream.on("scan",scan);
    req.raw.once("close",()=>{clearInterval(heartbeat);stream.off("alert",alert);stream.off("scan",scan);});
  });
  app.post("/api/scan/:chain",{preHandler:protect},async(req:any)=>{const raw=req.params.chain;return {alerts:raw==="all"?await service.scanAll():await service.scan(parseChain(raw,config))};});
  app.post("/api/token/:chain/:address/evaluate",{preHandler:protect},async(req:any)=>service.evaluateToken(parseChain(req.params.chain,config),req.params.address));
  return app;
}
