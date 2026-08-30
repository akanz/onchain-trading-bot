import type { Json } from "./types.js";

type Candle={time:number;open:number;high:number;low:number;close:number;volume:number};
const finite=(value:unknown)=>{const parsed=Number(value);return Number.isFinite(parsed)?parsed:undefined;};
const mean=(values:number[])=>values.length?values.reduce((sum,value)=>sum+value,0)/values.length:undefined;
const sum=(values:number[])=>values.reduce((total,value)=>total+value,0);
const change=(candles:Candle[])=>candles.length&&candles[0]!.open>0?(candles.at(-1)!.close/candles[0]!.open-1)*100:undefined;
const volume=(candles:Candle[])=>sum(candles.map(candle=>candle.volume));
const slice=(candles:Candle[],bars:number)=>candles.slice(-Math.min(bars,candles.length));

export function normalizeTrendingCandles(rows:Json[]):Candle[]{
  return rows.map(row=>({time:Number(row.time),open:Number(row.open),high:Number(row.high),low:Number(row.low),close:Number(row.close),volume:Math.max(Number(row.volume)||0,0)}))
    .filter(row=>Number.isFinite(row.time)&&row.open>0&&row.high>0&&row.low>0&&row.close>0)
    .sort((a,b)=>a.time-b.time);
}

export function analyzeTrendingCandles(rows:Json[],market:Json,minVolume5m=25000):Json {
  const candles=normalizeTrendingCandles(rows),last=candles.at(-1),last5=slice(candles,1),last15=slice(candles,3),last30=slice(candles,6),last60=slice(candles,12),previous=candles.slice(0,-1),previousMean=mean(previous.slice(-11).map(row=>row.volume));
  if(candles.length<8||!last)return {multiwindow_passed:false,multiwindow_score:0,multiwindow_grade:"INSUFFICIENT",pattern:"not enough candles",candle_count:candles.length,multiwindow_reasons:["fewer than 8 usable 5m candles"]};
  const closes=candles.map(row=>row.close),highs=last60.map(row=>row.high),lows=last60.map(row=>row.low),volumes30=last30.map(row=>row.volume),shortMean=mean(closes.slice(-9))!,longMean=mean(closes.slice(-Math.min(21,closes.length)))!;
  const trendUp=shortMean>longMean?"up":shortMean<longMean?"down":"flat",slope=(last.close/last60[0]!.open-1),volatility=mean(last60.map(row=>(row.high-row.low)/row.close))!,rangeHigh=Math.max(...highs),rangeLow=Math.min(...lows),drawdown=(rangeHigh-last.close)/rangeHigh,upFromLow=(last.close-rangeLow)/rangeLow,volRatio=previousMean&&previousMean>0?last.volume/previousMean:undefined,volumeMean30=mean(volumes30)!,variance30=mean(volumes30.map(value=>(value-volumeMean30)**2))!,volumeCv30=volumeMean30>0?Math.sqrt(variance30)/volumeMean30:undefined;
  let pattern="Sideways consolidation";
  if(slope>.25&&drawdown<.12)pattern="Vertical run-up";
  else if(slope>.08&&drawdown<.25)pattern="Uptrend channel";
  else if(drawdown>.55&&slope<-.10)pattern="Breakdown";
  else if(drawdown>.55&&slope>.02)pattern="Bounce off the lows";
  else if(drawdown>.35&&Math.abs(slope)<.08)pattern="Distribution at highs";
  else if(slope<-.20)pattern="Slow bleed";
  else if(Math.abs(slope)<.05&&volatility<.05&&upFromLow<.20)pattern="Basing at lows";
  else if(Math.abs(slope)<.08&&volatility>.08)pattern="Wide chop";
  else if(trendUp==="up")pattern="Bullish consolidation";
  else if(trendUp==="down")pattern="Bearish consolidation";

  const volume5=finite(market.volume)??volume(last5),volume15=volume(last15),volume30=volume(last30),volume60=volume(last60),liquidity=finite(market.liquidity)??0,turnover15=liquidity>0?volume15/liquidity:undefined,return5=change(last5),return15=change(last15),return30=change(last30),return60=change(last60),buys=finite(market.buys)??0,sells=finite(market.sells)??0,buySellRatio=sells>0?buys/sells:buys>0?Infinity:undefined;
  let score=0;const reasons:string[]=[];
  const add=(points:number,reason:string)=>{score+=points;reasons.push(`${points>=0?"+":""}${points} ${reason}`);};
  add(Math.min(15,Math.round(15*volume5/Math.max(minVolume5m,1))),`5m volume $${Math.round(volume5).toLocaleString()}`);
  if(volume15>=minVolume5m*2)add(10,"15m volume persisted");else add(Math.round(10*volume15/Math.max(minVolume5m*2,1)),"15m volume developing");
  if(volume30>=minVolume5m*3)add(5,"30m participation persisted");
  if(volRatio!==undefined){if(volRatio>=.7&&volRatio<=4)add(8,`latest volume ${volRatio.toFixed(1)}x baseline`);else if(volRatio>.3)add(3,`latest volume ${volRatio.toFixed(1)}x baseline`);else add(-5,"latest volume is fading");}
  if(volumeCv30!==undefined){if(volumeCv30<=1)add(7,"30m volume is distributed across candles");else if(volumeCv30<=1.75)add(3,"30m volume is moderately uneven");else add(-4,"30m volume is concentrated in a spike");}
  if(turnover15!==undefined){if(turnover15>=.05&&turnover15<=3)add(5,"healthy 15m volume/liquidity turnover");else if(turnover15>3)add(1,"very high turnover; watch churn");}
  if(drawdown<=.15)add(10,"holding near the 1h range high");else if(drawdown<=.30)add(6,"contained 1h drawdown");else if(drawdown<=.45)add(2,"recoverable but material drawdown");else add(-10,"deep drawdown from the 1h high");
  if(volatility<=.08)add(10,"stable intrabar ranges");else if(volatility<=.15)add(6,"manageable volatility");else if(volatility<=.25)add(2,"high but bounded volatility");else add(-8,"extreme candle volatility");
  if(return30!==undefined){if(return30>=-15)add(5,"30m structure is intact");else if(return30<-30)add(-8,"30m structure is breaking down");}
  if(return60!==undefined){if(return60>=-25)add(5,"1h structure is intact");else add(-5,"1h structure remains weak");}
  if(["Basing at lows","Bullish consolidation","Sideways consolidation"].includes(pattern))add(8,pattern.toLowerCase());
  else if(pattern==="Uptrend channel")add(6,"controlled uptrend");
  else if(pattern==="Vertical run-up")add(-8,"vertical move creates chase risk");
  else if(["Breakdown","Slow bleed"].includes(pattern))add(-15,pattern.toLowerCase());
  else if(pattern==="Distribution at highs")add(-8,"possible distribution at highs");
  const smart=finite(market.smart_degen_count??market.smart_money_count)??0,renowned=finite(market.renowned_count)??0;
  if(smart>=3)add(8,`${smart} smart-money wallets`);else if(smart>0)add(3,`${smart} smart-money wallet${smart===1?"":"s"}`);
  if(renowned>0)add(2,`${renowned} renowned wallet${renowned===1?"":"s"}`);
  if(buySellRatio!==undefined){if(buySellRatio>=.8)add(3,"5m buyers are not overwhelmed by sellers");else if(buySellRatio<.5)add(-3,"5m sells materially exceed buys");}
  if((finite(market.market_cap)??Infinity)<=500000)add(3,"early market-cap range");
  score=Math.max(0,Math.min(100,score));
  const minScore=Number(process.env.TRENDING_MIN_STABILITY_SCORE??60),minVolume15=Number(process.env.TRENDING_MIN_VOLUME_15M_USD??minVolume5m*2),maxDrawdown=Number(process.env.TRENDING_MAX_DRAWDOWN_1H_PERCENT??45)/100,maxVolatility=Number(process.env.TRENDING_MAX_VOLATILITY_1H_RATIO??.30),minReturn30=Number(process.env.TRENDING_MIN_RETURN_30M_PERCENT??-30),hardPattern=["Breakdown","Slow bleed"].includes(pattern);
  const passed=score>=minScore&&volume15>=minVolume15&&drawdown<=maxDrawdown&&volatility<=maxVolatility&&(return30??-Infinity)>=minReturn30&&!hardPattern;
  return {multiwindow_passed:passed,multiwindow_score:score,multiwindow_grade:score>=80?"A":score>=65?"B":score>=50?"C":"D",pattern,candle_count:candles.length,trend_up:trendUp,slope_percent:slope*100,volatility_1h_ratio:volatility,drawdown_1h_percent:drawdown*100,up_from_low_1h_percent:upFromLow*100,volume_ratio_5m:volRatio,volume_cv_30m:volumeCv30,volume_turnover_15m:turnover15,volume_5m:volume5,volume_15m:volume15,volume_30m:volume30,volume_1h:volume60,price_change_5m:return5,price_change_15m:return15,price_change_30m:return30,price_change_1h:return60,buy_sell_ratio_5m:buySellRatio,multiwindow_reasons:reasons};
}
