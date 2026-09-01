import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadEnvFile } from "node:process";

const root=resolve(process.env.TRACKER_ROOT??process.cwd()),envPath=join(root,".env");
if(existsSync(envPath))loadEnvFile(envPath);
process.env.FOMO_BROWSER_SESSION="true";

const [{DATA_ROOT},{startFomoSessionBridge},{readStoredFomoToken,tokenExpiry}]=await Promise.all([
  import("../src/config.js"),
  import("../src/fomo/session.js"),
  import("../src/fomo/token-store.js"),
]);
const tokenPath=process.env.FOMO_TOKEN_FILE??join(DATA_ROOT,".runtime","fomo-token.json");
const minimumTtl=Math.max(300,Number(process.env.FOMO_LOCAL_SYNC_MIN_TOKEN_TTL_SECONDS??600));
const timeout=Math.max(10000,Number(process.env.FOMO_LOCAL_SYNC_TOKEN_TIMEOUT_MS??120000));
const sleep=(milliseconds:number)=>new Promise(resolve=>setTimeout(resolve,milliseconds));
const waitForFreshToken=async()=>{
  const deadline=Date.now()+timeout;
  while(Date.now()<deadline){
    const expiry=tokenExpiry(readStoredFomoToken(tokenPath));
    if(expiry&&expiry-Date.now()/1000>=minimumTtl)return expiry;
    await sleep(1000);
  }
  throw new Error(`Fomo did not provide a bearer with at least ${minimumTtl}s remaining within ${Math.round(timeout/1000)}s. Open the dedicated Chrome profile, confirm it is logged in, and retry.`);
};

const bridge=await startFomoSessionBridge();
if(!bridge)throw new Error("The local Fomo browser session could not start");
try{
  const expiry=await waitForFreshToken();
  console.log(`Fresh local Fomo bearer captured; expires at ${new Date(expiry*1000).toISOString()}.`);
  console.log("Starting independent Fomo wallet discovery and qualification…");
  await import("./fomo-wallet-scan.js");
} finally {
  await bridge.close();
}
