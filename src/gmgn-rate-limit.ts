import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const sleep=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
const positive=(value:unknown,fallback:number)=>{const parsed=Number(value);return Number.isFinite(parsed)&&parsed>0?parsed:fallback;};

export function gmgnRequestWeight(args:string[]):number {
  const [group,command]=args;
  if(group==="token"&&(command==="holders"||command==="traders"))return 5;
  if(group==="market"&&(command==="signal"||command==="trenches"||command==="hot-searches"))return 3;
  if(group==="market"&&command==="kline")return 2;
  if(group==="market"&&(command==="trending"||command==="search"))return 1;
  if(group==="track"&&(command==="follow-wallet"||command==="follow-tokens"))return 3;
  if(group==="track"&&(command==="follow-token-groups"||command==="kol"||command==="smartmoney"))return 1;
  if(group==="token"&&(command==="info"||command==="security"||command==="pool"))return 1;
  return 5;
}

export function parseRateLimitReset(message:string,now=Date.now()):number {
  const unix=message.match(/(?:"?reset_at"?\s*[:=]\s*)(\d{10,13})/i)?.[1];
  if(unix){const value=Number(unix);return value<1e12?value*1000:value;}
  const remaining=message.match(/~?\s*(\d+)s\s+remaining/i)?.[1];
  if(remaining)return now+Number(remaining)*1000;
  const dateText=message.match(/Rate limit resets at\s+(.+?)(?:\s+\(|\.|$)/i)?.[1];
  if(dateText){const parsed=Date.parse(dateText);if(Number.isFinite(parsed))return parsed;}
  return now+300_000;
}

export class GmgnCooldownError extends Error {
  constructor(readonly resetAt:number){super(`GMGN cooldown active until ${new Date(resetAt).toISOString()}; no request was sent`);this.name="GmgnCooldownError";}
}

interface GateOptions {
  ratePerSecond?:number;
  capacity?:number;
  cooldownBufferMs?:number;
  stateFile?:string;
  now?:()=>number;
  sleep?:(ms:number)=>Promise<void>;
}

export class GmgnRateGate {
  private readonly ratePerSecond:number;
  private readonly capacity:number;
  private readonly cooldownBufferMs:number;
  private readonly stateFile:string|undefined;
  private readonly now:()=>number;
  private readonly sleeper:(ms:number)=>Promise<void>;
  private tokens:number;
  private lastRefill:number;
  private tail:Promise<void>=Promise.resolve();
  private generation=0;
  private blockedUntil=0;

  constructor(options:GateOptions={}){
    this.ratePerSecond=positive(options.ratePerSecond??process.env.GMGN_RATE_LIMIT_UNITS_PER_SECOND,8);
    this.capacity=Math.max(5,positive(options.capacity??process.env.GMGN_RATE_LIMIT_BURST_UNITS,8));
    this.cooldownBufferMs=Math.max(0,positive(options.cooldownBufferMs??process.env.GMGN_RATE_LIMIT_COOLDOWN_BUFFER_MS,2000));
    this.stateFile=options.stateFile;
    this.now=options.now??Date.now;
    this.sleeper=options.sleep??sleep;
    this.tokens=this.capacity;
    this.lastRefill=this.now();
    this.loadCooldown();
  }

  get cooldownUntil():number{return this.blockedUntil>this.now()?this.blockedUntil:0;}
  get cooldownRemainingMs():number{return Math.max(0,this.cooldownUntil-this.now());}

  assertAvailable():void {if(this.cooldownUntil)throw new GmgnCooldownError(this.blockedUntil);}

  blockUntil(resetAt:number):number {
    const target=Math.max(resetAt+this.cooldownBufferMs,this.now()+this.cooldownBufferMs);
    if(target>this.blockedUntil){this.blockedUntil=target;this.generation++;this.persistCooldown();}
    return this.blockedUntil;
  }

  async schedule<T>(weight:number,task:()=>Promise<T>):Promise<T> {
    const queuedGeneration=this.generation;
    const operation=this.tail.then(async()=>{
      if(queuedGeneration!==this.generation)throw new GmgnCooldownError(this.blockedUntil);
      this.assertAvailable();
      await this.acquire(Math.min(Math.max(1,weight),this.capacity));
      if(queuedGeneration!==this.generation)throw new GmgnCooldownError(this.blockedUntil);
      this.assertAvailable();
      return task();
    });
    this.tail=operation.then(()=>undefined,()=>undefined);
    return operation;
  }

  private refill():void {
    const current=this.now(),elapsed=Math.max(0,current-this.lastRefill)/1000;
    this.tokens=Math.min(this.capacity,this.tokens+elapsed*this.ratePerSecond);
    this.lastRefill=current;
  }

  private async acquire(weight:number):Promise<void> {
    for(;;){
      this.refill();
      if(this.tokens>=weight){this.tokens-=weight;return;}
      await this.sleeper(Math.max(1,Math.ceil((weight-this.tokens)/this.ratePerSecond*1000)));
    }
  }

  private loadCooldown():void {
    if(!this.stateFile)return;
    try {const parsed=JSON.parse(readFileSync(this.stateFile,"utf8"));const resetAt=Number(parsed.reset_at_ms);if(Number.isFinite(resetAt)&&resetAt>this.now())this.blockedUntil=resetAt;}
    catch {/* Missing or malformed runtime state is safe to ignore. */}
  }

  private persistCooldown():void {
    if(!this.stateFile)return;
    try {mkdirSync(dirname(this.stateFile),{recursive:true});writeFileSync(this.stateFile,JSON.stringify({reset_at_ms:this.blockedUntil,updated_at:new Date(this.now()).toISOString()}),{encoding:"utf8",mode:0o600});}
    catch(error){console.warn("Could not persist GMGN cooldown state",String(error));}
  }
}
