import type { Json } from "./types.js";

export interface RunnerMove {
  started_at:number;
  candle_change_percent:number;
  trailing_5m_change_percent:number;
  volume_ratio:number;
}

const finite=(value:unknown):number|undefined=>{const parsed=Number(value);return Number.isFinite(parsed)?parsed:undefined;};
const seconds=(value:unknown):number=>{const parsed=finite(value)??0;return parsed>10_000_000_000?Math.floor(parsed/1000):Math.floor(parsed);};

/** Find the first 1-minute candle where price expansion is confirmed by abnormal volume. */
export function detectRunnerMove(rows:Json[],minCandleChangePercent=20,minVolumeRatio=3,minTrailing5mChangePercent=35):RunnerMove|undefined {
  const candles=rows.map(row=>({time:seconds(row.time??row.timestamp),open:finite(row.open),close:finite(row.close),volume:finite(row.volume??row.volume_usd)}))
    .filter((row):row is {time:number;open:number;close:number;volume:number}=>row.time>0&&row.open!==undefined&&row.open>0&&row.close!==undefined&&row.close>0&&row.volume!==undefined&&row.volume>=0)
    .sort((a,b)=>a.time-b.time);
  for(let index=5;index<candles.length;index++){
    const candle=candles[index]!,prior=candles.slice(index-5,index),priorVolume=prior.reduce((sum,row)=>sum+row.volume,0)/prior.length;
    const candleChange=(candle.close/candle.open-1)*100,trailingChange=(candle.close/prior[0]!.open-1)*100,volumeRatio=priorVolume>0?candle.volume/priorVolume:0;
    if(volumeRatio>=minVolumeRatio&&(candleChange>=minCandleChangePercent||trailingChange>=minTrailing5mChangePercent))return {started_at:candle.time,candle_change_percent:candleChange,trailing_5m_change_percent:trailingChange,volume_ratio:volumeRatio};
  }
  return undefined;
}

/** First acquisition must precede the move, but not by so long that it is unrelated. */
export function enteredBeforeMove(trader:Json,moveStartedAt:number,maximumLeadSeconds=21600):boolean {
  const entered=seconds(trader.start_holding_at);
  return entered>0&&entered<=moveStartedAt&&entered>=moveStartedAt-maximumLeadSeconds;
}
