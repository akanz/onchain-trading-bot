import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type Page, type Request, type Response } from "playwright-core";
import { DATA_ROOT } from "../config.js";
import { readStoredFomoToken, saveFomoToken, tokenExpiry } from "./token-store.js";
import { saveFomoDiscoverySnapshot, type FomoDiscoveryKind } from "./discovery-store.js";

export interface FomoSessionBridge {readonly connected:boolean;close:()=>Promise<void>;}

const sleep=(milliseconds:number)=>new Promise(resolve=>setTimeout(resolve,milliseconds));
const targetClosed=(error:unknown)=>/target (?:page, context or browser )?has been closed|browser has been closed|browser.*disconnected|connection closed|context.*closed/i.test(String(error));

function chromeExecutable():string|undefined {
  const configured=process.env.FOMO_CHROME_PATH;
  const candidates=[configured,"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome","/usr/bin/google-chrome","/usr/bin/google-chrome-stable"].filter((value):value is string=>Boolean(value));
  return candidates.find(existsSync);
}

async function cdpReady(endpoint:string,attempts=1,signal?:AbortSignal):Promise<boolean> {
  for(let attempt=0;attempt<attempts;attempt++){
    if(signal?.aborted)return false;
    try{if((await fetch(`${endpoint}/json/version`)).ok)return true;}catch{}
    if(attempt+1<attempts)await sleep(250);
  }
  return false;
}

async function connectToOrdinaryChrome(profile:string,signal?:AbortSignal):Promise<{browser:Browser;chrome:ChildProcess|undefined}|null> {
  const port=Number(process.env.FOMO_BROWSER_DEBUG_PORT??9223);
  if(!Number.isInteger(port)||port<1024||port>65535){console.warn("FOMO_BROWSER_DEBUG_PORT must be an integer from 1024 to 65535");return null;}
  const endpoint=`http://127.0.0.1:${port}`;
  let chrome:ChildProcess|undefined;
  if(!await cdpReady(endpoint,1,signal)){
    if(signal?.aborted)return null;
    const executable=chromeExecutable();
    if(!executable){console.warn("Google Chrome was not found; set FOMO_CHROME_PATH to its executable");return null;}
    mkdirSync(profile,{recursive:true});
    chrome=spawn(executable,[
      `--remote-debugging-port=${port}`,
      "--remote-debugging-address=127.0.0.1",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "https://fomo.family"
    ],{stdio:"ignore"});
    chrome.once("error",error=>console.warn("Dedicated Fomo Chrome process failed",String(error)));
    if(!await cdpReady(endpoint,60,signal)){chrome.kill();if(!signal?.aborted)console.warn("Dedicated Fomo Chrome did not expose its local debugging endpoint");return null;}
  }
  try{const browser=await chromium.connectOverCDP(endpoint);if(signal?.aborted){await browser.close().catch(()=>{});chrome?.kill();return null;}return {browser,chrome};}
  catch(error){chrome?.kill();console.warn("Could not attach to the dedicated Fomo Chrome session",String(error));return null;}
}

export async function startFomoSessionBridge(signal?:AbortSignal):Promise<FomoSessionBridge|null> {
  if(process.env.FOMO_BROWSER_SESSION!=="true")return null;
  const tokenFile=process.env.FOMO_TOKEN_FILE??join(DATA_ROOT,".runtime","fomo-token.json"),discoveryFile=process.env.FOMO_DISCOVERY_SNAPSHOT_FILE??join(DATA_ROOT,".runtime","fomo-discovery.json"),profile=process.env.FOMO_BROWSER_PROFILE??join(DATA_ROOT,".runtime","fomo-chrome-profile");
  const connection=await connectToOrdinaryChrome(profile,signal);
  if(!connection)return null;
  const {browser,chrome}=connection;
  const abort=()=>{void browser.close().catch(()=>{});chrome?.kill("SIGTERM");};
  signal?.addEventListener("abort",abort,{once:true});
  const context=browser.contexts()[0];
  if(!context){await browser.close();chrome?.kill();console.warn("Dedicated Fomo Chrome session has no browser context");return null;}
  let page:Page=context.pages().find(candidate=>candidate.url().startsWith("https://fomo.family"))??context.pages()[0]??await context.newPage();
  let stopped=false,closing=false,refreshing=false,timer:NodeJS.Timeout|undefined;
  let resolveDiscovery:()=>void=()=>{};
  const discoveryReady=new Promise<void>(resolve=>{resolveDiscovery=resolve;}),aborted=new Promise<void>(resolve=>signal?.addEventListener("abort",()=>resolve(),{once:true}));
  const capture=async(request:Request)=>{
    try{
      if(stopped)return;
      if(new URL(request.url()).hostname!=="prod-api.fomo.family")return;
      const authorization=(await request.allHeaders()).authorization??"",token=authorization.match(/^Bearer\s+(.+)$/i)?.[1];
      if(token&&saveFomoToken(tokenFile,token))console.log(`Fomo browser session supplied a refreshed bearer valid until ${new Date((tokenExpiry(token)??0)*1000).toISOString()}`);
    }catch(error){if(!stopped&&!targetClosed(error))console.warn("Could not capture refreshed Fomo bearer",String(error));}
  };
  const captureRequest=(request:Request)=>void capture(request);
  const captureDiscovery=async(response:Response)=>{
    try{
      if(stopped)return;
      const url=new URL(response.url());
      if(url.hostname!=="prod-api.fomo.family"||!response.ok())return;
      const kind:FomoDiscoveryKind|undefined=url.pathname==="/proxy/trendingTokens"?"trending":url.pathname==="/proxy/mostHeld"?"most_held":undefined;
      if(!kind)return;
      const payload=await response.json(),rows=payload?.responseObject??payload;
      if(Array.isArray(rows)&&saveFomoDiscoverySnapshot(discoveryFile,kind,rows)){
        console.log(`Fomo browser session captured ${rows.length} mixed-chain ${kind.replace("_","-")} tokens.`);
        if(kind==="trending")resolveDiscovery();
      }
    }catch(error){if(!stopped&&!targetClosed(error))console.warn("Could not capture Fomo discovery response",String(error));}
  };
  const captureResponse=(response:Response)=>void captureDiscovery(response);
  context.on("request",captureRequest);
  context.on("response",captureResponse);
  try{
    if(page.url().startsWith("https://fomo.family"))await page.reload({waitUntil:"domcontentloaded",timeout:30000});
    else await page.goto("https://fomo.family",{waitUntil:"domcontentloaded",timeout:30000});
    await Promise.race([discoveryReady,aborted,sleep(10000)]);
  }
  catch(error){if(!signal?.aborted)console.warn("Fomo session page did not load; Chrome remains open for manual retry",String(error));}
  const refreshBeforeExpiry=Math.max(60,Number(process.env.FOMO_BROWSER_REFRESH_BEFORE_EXPIRY_SECONDS??1800));
  const stopRefresh=(reason?:string)=>{
    if(stopped)return;
    stopped=true;
    if(timer)clearInterval(timer);
    context.off("request",captureRequest);
    context.off("response",captureResponse);
    if(reason)console.warn(reason);
  };
  const disconnected=()=>stopRefresh(closing?undefined:"Fomo browser session closed; the bot will reconnect automatically.");
  browser.on("disconnected",disconnected);
  context.on("close",disconnected);
  const refresh=async()=>{
    if(stopped||refreshing)return;
    refreshing=true;
    try{
      const expiry=tokenExpiry(readStoredFomoToken(tokenFile));
      if(expiry&&expiry-Date.now()/1000>=refreshBeforeExpiry)return;
      if(!browser.isConnected()){disconnected();return;}
      page=context.pages().find(candidate=>!candidate.isClosed()&&candidate.url().startsWith("https://fomo.family"))??await context.newPage();
      if(page.url().startsWith("https://fomo.family"))await page.reload({waitUntil:"domcontentloaded",timeout:30000});
      else await page.goto("https://fomo.family",{waitUntil:"domcontentloaded",timeout:30000});
    }catch(error){
      if(targetClosed(error))disconnected();
      else console.warn("Fomo browser session refresh failed",String(error));
    }finally{refreshing=false;}
  };
  await refresh();
  if(signal?.aborted){stopRefresh();signal.removeEventListener("abort",abort);if(browser.isConnected())await browser.close().catch(()=>{});chrome?.kill("SIGTERM");return null;}
  if(!stopped){timer=setInterval(()=>void refresh(),300000);timer.unref();console.log("Fomo session bridge attached to ordinary Chrome. Sign in once there; Google credentials remain inside Google/Privy.");}
  return {
    get connected(){return !stopped&&browser.isConnected();},
    close:async()=>{
      if(closing)return;
      closing=true;stopRefresh();signal?.removeEventListener("abort",abort);browser.off("disconnected",disconnected);context.off("close",disconnected);
      const closingBrowser=browser.isConnected()?browser.close().catch(()=>{}):Promise.resolve();
      chrome?.kill("SIGTERM");
      await Promise.race([closingBrowser,sleep(1000)]);
    },
  };
}
