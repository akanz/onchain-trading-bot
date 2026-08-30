import { addressKey, marketSnapshot, passesMarketGate, validTokenAddress } from "./signals.js";
import type { Chain, Json } from "./types.js";

const finite=(value:unknown):number|undefined=>{const number=Number(value);return Number.isFinite(number)?number:undefined;};
const signalLabel=(type:number)=>type===6?"PRICE SURGE":type===7?"NEW ATH":type===12?"SMART MONEY":undefined;

export function buildDegenRows(chain:Chain,trending:Json[],signals:Json[],tokenConfig:Json,maxMarketCap=100_000,now=Math.floor(Date.now()/1000)):Json[] {
  const rows=new Map<string,Json>();
  const merge=(market:Json,source:string,microcapOnly=false)=>{
    const address=String(market.address??"");
    if(!validTokenAddress(chain,address))return;
    const marketCap=finite(market.market_cap);
    if(microcapOnly&&(marketCap===undefined||marketCap<=0||marketCap>maxMarketCap))return;
    const key=addressKey(address),current=rows.get(key)??{...market,chain,address,degen_sources:[],degen_signal_labels:[]};
    Object.assign(current,market);
    current.is_microcap=marketCap!==undefined&&marketCap>0&&marketCap<=maxMarketCap;
    if(!current.degen_sources.includes(source))current.degen_sources.push(source);
    rows.set(key,current);
  };

  for(const row of trending){
    if(row.quality_passed===true)continue;
    merge({...row,filtered_out:true},"FILTERED TRENDING");
  }
  for(const row of signals){
    const type=Number(row.signal_type),label=signalLabel(type),triggerAt=Number(row.trigger_at??0);
    if(!label||!triggerAt||triggerAt<now-Number(process.env.SIGNAL_LOOKBACK_SECONDS??1800))continue;
    const market:Json={...marketSnapshot(row),chain,signal_type:type,trigger_at:triggerAt,trigger_mc:finite(row.trigger_mc),signal_times:finite(row.signal_times)};
    const gate=passesMarketGate(market,tokenConfig);
    market.quality_passed=gate.passed;
    market.quality_reasons=gate.reasons;
    merge(market,label,true);
    const merged=rows.get(addressKey(String(market.address??"")));
    if(merged&&!merged.degen_signal_labels.includes(label))merged.degen_signal_labels.push(label);
  }
  return [...rows.values()].sort((a,b)=>{
    const priority=(row:Json)=>row.degen_signal_labels?.includes("PRICE SURGE")?4:row.degen_signal_labels?.includes("NEW ATH")?3:row.degen_signal_labels?.includes("SMART MONEY")?2:1;
    const momentum=(row:Json)=>finite(row.price_change_percent5m??row.price_change_percent)??-Infinity;
    const turnover=(row:Json)=>{const volume=finite(row.volume)??0,mc=finite(row.market_cap)??1;return volume/mc;};
    return Number(b.is_microcap)-Number(a.is_microcap)||priority(b)-priority(a)||momentum(b)-momentum(a)||turnover(b)-turnover(a)||(finite(b.volume)??0)-(finite(a.volume)??0);
  });
}
