import { number } from "./scoring.js";
import type { Chain, Json } from "./types.js";

const noisyTags=new Set([
  "bundler","rat_trader","dex_bot","sniper","axiom","photon","bullx",
  "trojan","pepeboost","padre",
]);

export function gmgnTraderRoiPercent(row:Json):number {
  const ratio=number(row.realized_pnl,null);
  return ratio===null?Number.NaN:ratio*100;
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
  if((number(row.realized_profit,0)??0)<100||gmgnTraderRoiPercent(row)<minimumRoiPercent)return false;
  if((number(row.sell_tx_count_cur,0)??0)<1||(number(row.buy_tx_count_cur,0)??0)>50)return false;
  return true;
}

export function validWalletAddress(chain:Chain,address:string):boolean {
  return chain==="sol"?/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address):/^0x[0-9a-fA-F]{40}$/.test(address);
}

export function trackWallet(row:Json):string {
  return String(row.maker??row.maker_info?.address??"");
}
