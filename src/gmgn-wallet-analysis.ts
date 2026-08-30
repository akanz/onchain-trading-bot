import { number } from "./scoring.js";
import type { Chain, Json } from "./types.js";

const noisyTags=new Set([
  "bundler","rat_trader","dex_bot","sniper","axiom","photon","bullx",
  "trojan","pepeboost","padre",
]);

export function gmgnTraderRoiPercent(row:Json):number {
  const ratios=[row.realized_pnl,row.unrealized_pnl,row.profit_change]
    .map(value=>number(value,null))
    .filter((value):value is number=>value!==null);
  return ratios.length?Math.max(...ratios)*100:Number.NaN;
}

export function gmgnTraderRoiEvidence(row:Json):Json {
  const percent=(value:unknown)=>{const ratio=number(value,null);return ratio===null?undefined:ratio*100;};
  const realized=percent(row.realized_pnl),unrealized=percent(row.unrealized_pnl),total=percent(row.profit_change);
  return {
    realized_roi_percent:realized,
    unrealized_roi_percent:unrealized,
    total_roi_percent:total,
    maximum_roi_percent:Math.max(...[realized,unrealized,total].filter((value):value is number=>value!==undefined)),
    realized_profit_usd:number(row.realized_profit,0)??0,
    unrealized_profit_usd:number(row.unrealized_profit,0)??0,
    total_profit_usd:number(row.profit,0)??0,
  };
}

export function gmgnTraderTags(row:Json):string[] {
  return [...(row.tags??[]),...(row.maker_token_tags??[])]
    .map((tag:unknown)=>String(tag).toLowerCase());
}

export function isCleanGmgnTrendingTrader(
  row:Json,
  minimumRoiPercent=Number(process.env.GMGN_MIN_TRENDING_TRADER_ROI_PERCENT??500),
):boolean {
  if(!row.address||Number(row.addr_type??0)!==0||row.is_suspicious||row.transfer_in||row.is_new)return false;
  if(gmgnTraderTags(row).some(tag=>noisyTags.has(tag)))return false;
  if((number(row.history_bought_cost,0)??0)<100)return false;
  const profit=Math.max(number(row.realized_profit,0)??0,number(row.unrealized_profit,0)??0,number(row.profit,0)??0);
  if(profit<100||gmgnTraderRoiPercent(row)<minimumRoiPercent)return false;
  if((number(row.sell_tx_count_cur,0)??0)<1||(number(row.buy_tx_count_cur,0)??0)>50)return false;
  return true;
}

export function buildEliteGmgnWalletsFromTokenResults(results:Json[],minimumRoiPercent=Number(process.env.GMGN_MIN_TRENDING_TRADER_ROI_PERCENT??500)):Json[] {
  const wallets=new Map<string,Json>();
  for(const result of results){
    const chain=result.chain as Chain,token=result.token??{};
    for(const trader of result.traders??[]){
      if(!isCleanGmgnTrendingTrader(trader,minimumRoiPercent))continue;
      const wallet=String(trader.address),key=`${chain}:${wallet.toLowerCase()}`,evidence=gmgnTraderRoiEvidence(trader),row=wallets.get(key)??{chain,wallet,source:"gmgn",tracking_tier:"elite_observed",verification_source:"gmgn_position_roi",discovery_sources:["gmgn_trending_500pct"],tokens:[],max_position_roi_percent:0,max_realized_position_roi_percent:0,max_unrealized_position_roi_percent:0};
      row.tokens.push({address:token.address,symbol:token.symbol,...evidence});
      row.max_position_roi_percent=Math.max(Number(row.max_position_roi_percent??0),Number(evidence.maximum_roi_percent??0));
      row.max_realized_position_roi_percent=Math.max(Number(row.max_realized_position_roi_percent??0),Number(evidence.realized_roi_percent??0));
      row.max_unrealized_position_roi_percent=Math.max(Number(row.max_unrealized_position_roi_percent??0),Number(evidence.unrealized_roi_percent??0));
      wallets.set(key,row);
    }
  }
  return [...wallets.values()];
}

export function validWalletAddress(chain:Chain,address:string):boolean {
  return chain==="sol"?/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address):/^0x[0-9a-fA-F]{40}$/.test(address);
}

export function trackWallet(row:Json):string {
  return String(row.maker??row.maker_info?.address??"");
}
