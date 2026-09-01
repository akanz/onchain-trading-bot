import { gmgnTraderRoiEvidence, gmgnTraderTags, isCleanGmgnTrendingTrader } from "./gmgn-wallet-analysis.js";
import type { Json } from "./types.js";

export type SurgeKind="SIDEWAYS BREAKOUT"|"DIP REVERSAL"|"MOMENTUM EXPANSION";

export interface SurgeEvent {
  started_at:number;
  ended_at:number;
  kind:SurgeKind;
  price_change_percent:number;
  volume_usd:number;
  volume_ratio:number;
  prior_range_percent:number;
  prior_drawdown_percent:number;
}

const finite=(value:unknown):number|undefined=>{const parsed=Number(value);return Number.isFinite(parsed)?parsed:undefined;};
const seconds=(value:unknown):number=>{const parsed=finite(value)??0;return parsed>10_000_000_000?Math.floor(parsed/1000):Math.floor(parsed);};
const median=(values:number[]):number=>{if(!values.length)return 0;const sorted=[...values].sort((a,b)=>a-b),middle=Math.floor(sorted.length/2);return sorted.length%2?sorted[middle]!:(sorted[middle-1]!+sorted[middle]!)/2;};

/** Detect distinct one-minute volume-confirmed expansions, including consolidations and dip reversals. */
export function detectSurgeEvents(rows:Json[],options:Json={}):SurgeEvent[] {
  const minCandle=finite(options.min_candle_change_percent)??15,minTrailing=finite(options.min_trailing_5m_change_percent)??25,minVolumeRatio=finite(options.min_volume_ratio)??2.5,sidewaysRange=finite(options.max_sideways_range_percent)??18,reversalDrawdown=finite(options.min_reversal_drawdown_percent)??20,mergeSeconds=finite(options.merge_seconds)??180;
  const candles=rows.map(row=>({time:seconds(row.time??row.timestamp),open:finite(row.open),high:finite(row.high),low:finite(row.low),close:finite(row.close),volume:finite(row.volume??row.volume_usd)}))
    .filter((row):row is {time:number;open:number;high:number;low:number;close:number;volume:number}=>row.time>0&&row.open!==undefined&&row.open>0&&row.high!==undefined&&row.low!==undefined&&row.low>0&&row.close!==undefined&&row.close>0&&row.volume!==undefined&&row.volume>=0)
    .sort((a,b)=>a.time-b.time);
  const raw:SurgeEvent[]=[];
  for(let index=5;index<candles.length;index++){
    const candle=candles[index]!,prior5=candles.slice(index-5,index),context=candles.slice(Math.max(0,index-30),index),baselineVolume=median(prior5.map(row=>row.volume)),candleChange=(candle.close/candle.open-1)*100,trailingChange=(candle.close/prior5[0]!.open-1)*100,volumeRatio=baselineVolume>0?candle.volume/baselineVolume:0;
    if(volumeRatio<minVolumeRatio||Math.max(candleChange,trailingChange)<Math.min(minCandle,minTrailing)||!(candleChange>=minCandle||trailingChange>=minTrailing))continue;
    const priorHigh=Math.max(...context.map(row=>row.high)),priorLow=Math.min(...prior5.map(row=>row.low)),priorCloseHigh=Math.max(...prior5.map(row=>row.close)),priorCloseLow=Math.min(...prior5.map(row=>row.close)),priorRange=(priorCloseHigh/priorCloseLow-1)*100,drawdown=(1-candle.open/priorHigh)*100;
    const kind:SurgeKind=drawdown>=reversalDrawdown?"DIP REVERSAL":priorRange<=sidewaysRange?"SIDEWAYS BREAKOUT":"MOMENTUM EXPANSION";
    raw.push({started_at:candle.time,ended_at:candle.time+60,kind,price_change_percent:candleChange,volume_usd:candle.volume,volume_ratio:volumeRatio,prior_range_percent:(Math.max(...prior5.map(row=>row.high))/priorLow-1)*100,prior_drawdown_percent:Math.max(0,drawdown)});
  }
  const merged:SurgeEvent[]=[];
  for(const event of raw){const prior=merged.at(-1);if(!prior||event.started_at-prior.ended_at>mergeSeconds){merged.push({...event});continue;}const first=candles.find(row=>row.time===prior.started_at),last=candles.find(row=>row.time===event.started_at);prior.ended_at=event.ended_at;prior.price_change_percent=first&&last?(last.close/first.open-1)*100:Math.max(prior.price_change_percent,event.price_change_percent);prior.volume_usd+=event.volume_usd;prior.volume_ratio=Math.max(prior.volume_ratio,event.volume_ratio);prior.prior_drawdown_percent=Math.max(prior.prior_drawdown_percent,event.prior_drawdown_percent);if(prior.kind==="MOMENTUM EXPANSION"&&event.kind!=="MOMENTUM EXPANSION")prior.kind=event.kind;}
  return merged;
}

/** A surge wallet needs explicit realized or unrealized position ROI, not only blended total ROI. */
export function profitablePreMoveTrader(row:Json,event:SurgeEvent,minimumRoiPercent=300,maximumLeadSeconds=1800):Json|undefined {
  if(!isCleanGmgnTrendingTrader(row,minimumRoiPercent))return undefined;
  const noisy=new Set(["bundler","rat_trader","dex_bot","sniper"]);if(gmgnTraderTags(row).some(tag=>noisy.has(tag)))return undefined;
  const entered=seconds(row.start_holding_at),evidence=gmgnTraderRoiEvidence(row),realized=finite(evidence.realized_roi_percent),unrealized=finite(evidence.unrealized_roi_percent),positionRoi=Math.max(realized??-Infinity,unrealized??-Infinity);
  if(positionRoi<minimumRoiPercent||entered<event.started_at-maximumLeadSeconds||entered>event.ended_at)return undefined;
  return {wallet:String(row.address),name:row.name??row.twitter_username??undefined,entered_at:entered,buy_usd:finite(row.history_bought_cost)??0,buy_count:finite(row.buy_tx_count_cur)??0,sell_count:finite(row.sell_tx_count_cur)??0,realized_roi_percent:realized,unrealized_roi_percent:unrealized,realized_profit_usd:finite(row.realized_profit)??0,unrealized_profit_usd:finite(row.unrealized_profit)??0,position_roi_percent:positionRoi,tags:gmgnTraderTags(row)};
}

export function assessWalletPerformance(period30:Json={},periodAll:Json={},minimumRoiPercent=200,minimumTrades30d=20):Json {
  const realized30=finite(period30.realized_profit)??0,cost30=finite(period30.realized_profit_cost)??0,realizedAll=finite(periodAll.total_realized_profit??periodAll.realized_profit)??0,costAll=finite(periodAll.total_realized_profit_cost??periodAll.realized_profit_cost)??0,roi30=cost30>0?realized30/cost30*100:undefined,roiAll=costAll>0?realizedAll/costAll*100:undefined,trades30=(finite(period30.buy)??0)+(finite(period30.sell)??0),reasons:string[]=[];
  if(roi30===undefined||roi30<minimumRoiPercent)reasons.push(`30d realized ROI below ${minimumRoiPercent}% or unavailable`);if(roiAll===undefined||roiAll<minimumRoiPercent)reasons.push(`all-time realized ROI below ${minimumRoiPercent}% or unavailable`);if(realized30<=0||realizedAll<=0)reasons.push("realized profit is not positive in both windows");if(trades30<minimumTrades30d)reasons.push(`fewer than ${minimumTrades30d} 30d trades`);
  return {worth_tracking:reasons.length===0,realized_profit_30d:realized30,realized_roi_30d_percent:roi30,realized_profit_all:realizedAll,realized_roi_all_percent:roiAll,trades_30d:trades30,reasons};
}
