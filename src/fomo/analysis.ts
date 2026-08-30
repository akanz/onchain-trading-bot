import { wilsonLowerBound } from "../scoring.js";
import type { Json } from "../types.js";

const n=(value:unknown)=>{const parsed=Number(value);return Number.isFinite(parsed)?parsed:0;};
export function fomoProfileInsights(row:Json):Json {
  const holdings:Json[]=row.topHoldings??[],rois=holdings.map(holding=>{const value=n(holding.value),pnl=n(holding.pnl),explicitCost=n(holding.costBasis),cost=explicitCost>0?explicitCost:value-pnl;return cost>0?pnl/cost:null;}).filter((value):value is number=>value!==null&&Number.isFinite(value));
  const profitable=holdings.filter(holding=>n(holding.pnl)>0).length,networks=new Set(holdings.map(holding=>n(holding.networkId)).filter(Boolean));
  const pnl24h=n(row.pnl24h??row.leaderboard_pnl?.["24h"]),pnl7d=n(row.pnl7d??row.leaderboard_pnl?.["7d"]),pnl30d=n(row.pnl30d??row.leaderboard_pnl?.["30d"]),allTimePnl=n(row.totalPnL??row.leaderboard_pnl?.all),leaderboardPnl=Math.max(pnl24h,pnl7d,pnl30d,allTimePnl),totalVolume=n(row.totalVolume),medianRoi=rois.length?[...rois].sort((a,b)=>a-b)[Math.floor(rois.length/2)]!:null;
  return {fomo_total_pnl:allTimePnl||leaderboardPnl,fomo_pnl_24h:pnl24h,fomo_pnl_7d:pnl7d,fomo_pnl_30d:pnl30d,fomo_leaderboard_pnl:leaderboardPnl,fomo_total_volume:totalVolume,fomo_pnl_efficiency:totalVolume>0?leaderboardPnl/totalVolume:0,fomo_trades:n(row.numTrades),fomo_swaps:n(row.swapCount),fomo_followers:n(row.followers),profitable_top_holding_rate:holdings.length?profitable/holdings.length:0,median_top_holding_roi:medianRoi,network_count:networks.size,top_holding_value:holdings.reduce((sum,holding)=>sum+n(holding.value),0),leaderboard_periods:row.leaderboard_periods??[],leaderboard_ranks:row.leaderboard_ranks??{}};
}

export function passesFomoProfile(row:Json):boolean {
  const insight=fomoProfileInsights(row);
  return !row.private&&!row.isRestricted&&insight.fomo_leaderboard_pnl>=Number(process.env.FOMO_MIN_LEADERBOARD_PNL_USD??1000)&&insight.fomo_total_volume>=Number(process.env.FOMO_MIN_LEADERBOARD_VOLUME_USD??5000)&&insight.fomo_trades>=Number(process.env.FOMO_MIN_LEADERBOARD_TRADES??30)&&insight.profitable_top_holding_rate>=Number(process.env.FOMO_MIN_PROFITABLE_TOP_HOLDINGS_RATE??.5);
}

export function gmgnProfitGate(p7:Json,p30:Json,pall:Json,stats:Json,cfg:Json):Json {
  const rp7=n(p7.realized_profit),rp30=n(p30.realized_profit),rpall=n(pall.total_realized_profit??pall.realized_profit),cost30=Math.max(n(p30.realized_profit_cost),1),costAll=Math.max(n(pall.total_realized_profit_cost??pall.realized_profit_cost),1),roi30=rp30/cost30,roiAll=rpall/costAll,trades30=n(p30.buy)+n(p30.sell);
  const tokenCount=n(stats.pnl_stat?.token_num),winrate=n(stats.pnl_stat?.winrate),wilson=wilsonLowerBound(Math.round(winrate*tokenCount),tokenCount);
  const passed=rp7>=cfg.min_realized_profit_7d&&rp30>=cfg.min_realized_profit_30d&&rpall>=cfg.min_realized_profit_all&&roi30>=cfg.min_roi_30d&&roiAll>=cfg.min_roi_all&&trades30>=cfg.min_trades_30d&&trades30<=cfg.max_trades_30d&&tokenCount>=cfg.min_tokens_30d&&tokenCount<=cfg.max_tokens_30d&&winrate>=cfg.min_win_rate_30d&&wilson>=cfg.min_wilson_win_rate_30d;
  return {passed,rp7,rp30,rpall,roi30,roiAll,trades30,tokenCount,winrate,wilson};
}

export function fomoTradeGate(data:Json,cfg:Json):Json {
  const closed:Json[]=(data.closedTrades??[]).map((row:Json)=>row.trade??row),active:Json[]=(data.activeTrades??[]).map((row:Json)=>row.trade??row),cutoff=Date.now()-30*86400000,recent=closed.filter(row=>Date.parse(row.closedAt??row.updatedAt??0)>=cutoff);
  const realized=recent.reduce((sum,row)=>sum+n(row.realizedPnlUsd),0),cost=recent.reduce((sum,row)=>sum+n(row.totalCostBasis),0),wins=recent.filter(row=>n(row.realizedPnlUsd)>0).length,winrate=recent.length?wins/recent.length:0,wilson=wilsonLowerBound(wins,recent.length),roi=realized/Math.max(cost,1),sizes=recent.map(row=>n(row.totalCostBasis)).filter(Boolean).sort((a,b)=>a-b),medianCost=sizes.length?sizes[Math.floor(sizes.length/2)]!:0,uniqueActive=new Set(active.map(row=>`${row.networkId}:${row.tokenAddress}`).filter(Boolean)).size;
  const passed=recent.length>=Number(process.env.FOMO_MIN_CLOSED_TRADE_SAMPLE??10)&&realized>=Number(process.env.FOMO_MIN_NATIVE_REALIZED_PNL_USD??500)&&roi>=cfg.min_roi_30d&&winrate>=cfg.min_win_rate_30d&&wilson>=Number(process.env.FOMO_MIN_NATIVE_WILSON??.25)&&medianCost>=cfg.min_median_buy_usd&&uniqueActive<=cfg.max_unique_tokens_in_100_actions;
  return {passed,closed_trade_sample:recent.length,closed_trade_total:n(data.closedCount),closed_trade_sample_complete:data.hasNextPage!==true,native_realized_pnl_sample:realized,native_cost_sample:cost,native_roi_sample:roi,native_winrate_sample:winrate,native_wilson_sample:wilson,native_median_cost_usd:medianCost,native_active_tokens:uniqueActive};
}
