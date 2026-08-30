import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type Page, type Request } from "playwright-core";
import { DATA_ROOT } from "../config.js";
import { readStoredFomoToken, saveFomoToken, tokenExpiry } from "./token-store.js";

export interface FomoSessionBridge {close:()=>Promise<void>;}

const sleep=(milliseconds:number)=>new Promise(resolve=>setTimeout(resolve,milliseconds));

function chromeExecutable():string|undefined {
  const configured=process.env.FOMO_CHROME_PATH;
  const candidates=[configured,"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome","/usr/bin/google-chrome","/usr/bin/google-chrome-stable"].filter((value):value is string=>Boolean(value));
  return candidates.find(existsSync);
}

async function cdpReady(endpoint:string,attempts=1):Promise<boolean> {
  for(let attempt=0;attempt<attempts;attempt++){
    try{if((await fetch(`${endpoint}/json/version`)).ok)return true;}catch{}
    if(attempt+1<attempts)await sleep(250);
  }
  return false;
}

async function connectToOrdinaryChrome(profile:string):Promise<{browser:Browser;chrome:ChildProcess|undefined}|null> {
  const port=Number(process.env.FOMO_BROWSER_DEBUG_PORT??9223);
  if(!Number.isInteger(port)||port<1024||port>65535){console.warn("FOMO_BROWSER_DEBUG_PORT must be an integer from 1024 to 65535");return null;}
  const endpoint=`http://127.0.0.1:${port}`;
  let chrome:ChildProcess|undefined;
  if(!await cdpReady(endpoint)){
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
    if(!await cdpReady(endpoint,60)){chrome.kill();console.warn("Dedicated Fomo Chrome did not expose its local debugging endpoint");return null;}
  }
  try{return {browser:await chromium.connectOverCDP(endpoint),chrome};}
  catch(error){chrome?.kill();console.warn("Could not attach to the dedicated Fomo Chrome session",String(error));return null;}
}

export async function startFomoSessionBridge():Promise<FomoSessionBridge|null> {
  if(process.env.FOMO_BROWSER_SESSION!=="true")return null;
  const tokenFile=process.env.FOMO_TOKEN_FILE??join(DATA_ROOT,".runtime","fomo-token.json"),profile=process.env.FOMO_BROWSER_PROFILE??join(DATA_ROOT,".runtime","fomo-chrome-profile");
  const connection=await connectToOrdinaryChrome(profile);
  if(!connection)return null;
  const {browser,chrome}=connection;
  const context=browser.contexts()[0];
  if(!context){await browser.close();chrome?.kill();console.warn("Dedicated Fomo Chrome session has no browser context");return null;}
  let page:Page=context.pages().find(candidate=>candidate.url().startsWith("https://fomo.family"))??context.pages()[0]??await context.newPage();
  const capture=async(request:Request)=>{
    try{
      if(new URL(request.url()).hostname!=="prod-api.fomo.family")return;
      const authorization=(await request.allHeaders()).authorization??"",token=authorization.match(/^Bearer\s+(.+)$/i)?.[1];
      if(token&&saveFomoToken(tokenFile,token))console.log(`Fomo browser session supplied a refreshed bearer valid until ${new Date((tokenExpiry(token)??0)*1000).toISOString()}`);
    }catch(error){console.warn("Could not capture refreshed Fomo bearer",String(error));}
  };
  const captureRequest=(request:Request)=>void capture(request);
  context.on("request",captureRequest);
  try{if(!page.url().startsWith("https://fomo.family"))await page.goto("https://fomo.family",{waitUntil:"domcontentloaded",timeout:30000});}
  catch(error){console.warn("Fomo session page did not load; Chrome remains open for manual retry",String(error));}
  const refreshBeforeExpiry=Math.max(60,Number(process.env.FOMO_BROWSER_REFRESH_BEFORE_EXPIRY_SECONDS??1800));
  let stopped=false,refreshing=false,timer:NodeJS.Timeout|undefined;
  const stopRefresh=(reason?:string)=>{
    if(stopped)return;
    stopped=true;
    if(timer)clearInterval(timer);
    context.off("request",captureRequest);
    if(reason)console.warn(reason);
  };
  const disconnected=()=>stopRefresh("Fomo browser session closed; automatic bearer refresh is paused until the bot restarts.");
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
      const message=String(error);
      if(/target (?:page, context or browser )?has been closed|browser has been closed|browser.*disconnected|connection closed|context.*closed/i.test(message))disconnected();
      else console.warn("Fomo browser session refresh failed",message);
    }finally{refreshing=false;}
  };
  await refresh();
  if(!stopped){timer=setInterval(()=>void refresh(),300000);timer.unref();console.log("Fomo session bridge attached to ordinary Chrome. Sign in once there; Google credentials remain inside Google/Privy.");}
  return {close:async()=>{stopRefresh();browser.off("disconnected",disconnected);context.off("close",disconnected);if(browser.isConnected())await browser.close();chrome?.kill();}};
}
