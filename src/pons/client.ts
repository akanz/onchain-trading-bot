import type { Json } from "../types.js";

export interface PonsLaunchSnapshot {generatedAt:number;active:Json[];graduated:Json[];}

const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
const transient=(error:unknown)=>/ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|ECONNREFUSED|fetch failed|socket hang up|SocketError|other side closed/i.test(String(error));

export class PonsClient {
  readonly baseUrl=process.env.PONS_BASE_URL??"https://www.ponsfamily.com";
  get enabled(){return process.env.PONS_ENABLED!=="false";}
  private async request(path:string):Promise<any>{
    for(let attempt=0;attempt<3;attempt++){try{const response=await fetch(`${this.baseUrl}${path}`,{headers:{Accept:"application/json","User-Agent":"gmgn-profitable-wallet-bot/0.1"},signal:AbortSignal.timeout(30000)});if(!response.ok)throw new Error(`Pons GET ${path.split("?")[0]} failed (${response.status})`);return response.json();}catch(error){if(attempt<2&&transient(error)){await sleep((attempt+1)*1000);continue;}throw error;}}
    throw new Error("Pons request exhausted transient-network retries");
  }
  async launches():Promise<PonsLaunchSnapshot>{
    const pageSize=Math.min(200,Math.max(10,Number(process.env.PONS_ACTIVE_PAGE_SIZE??50))),age=encodeURIComponent(process.env.PONS_LAUNCH_AGE??"7d");
    const [activePayload,graduatedPayload]=await Promise.all([
      this.request(`/api/pons-launches?explore=1&sort=recent&age=${age}&page=1&pageSize=${pageSize}&graduatedPage=1&graduatedPageSize=1&includeGraduated=0&version=all&v=10`),
      this.request("/api/pons-launches/graduations?catalog=1&v=8"),
    ]);
    const active=Array.isArray(activePayload?.active?.items)?activePayload.active.items:[],catalog=Array.isArray(graduatedPayload)?graduatedPayload:[],cutoff=Date.now()-Number(process.env.PONS_GRADUATED_MAX_AGE_SECONDS??604800)*1000;
    const graduated=catalog.filter((row:Json)=>{const time=Date.parse(row.graduatedAt??row.launchedAt??0);return Number.isFinite(time)&&time>=cutoff;});
    return {generatedAt:Number(activePayload?.generatedAt??Date.now()),active,graduated};
  }
}
