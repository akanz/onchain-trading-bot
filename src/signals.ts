import type { Chain, Json } from "./types.js";

export type SignalSource =
  | "trending_momentum"
  | "trending_small_cap"
  | "trending_smart_money"
  | "trending_early_volume"
  | "trending_multiwindow_stability"
  | "price_surge"
  | "profitable_surge_wallet"
  | "smart_money_signal"
  | "smart_money_wallet"
  | "kol_wallet"
  | "followed_wallet"
  | "tracked_wallet"
  | "fomo_most_held"
  | "fomo_trending"
  | "fomo_holder"
  | "fomo_leaderboard"
  | "fomo_tracked_wallet"
  | "long_launchpad"
  | "dexscreener_market"
  | "twitter";

export interface SignalCandidate {
  chain: Chain;
  address: string;
  symbol?: string;
  sources: Set<SignalSource>;
  sourceIds: Set<string>;
  wallets: Set<string>;
  buyWallets: Set<string>;
  sellWallets?: Set<string>;
  traderLabels?: Set<string>;
  sellTraderLabels?: Set<string>;
  sellSources?: Set<SignalSource>;
  twitterAccounts: Set<string>;
  firstTimestamp: number;
  aggregateBuyUsd: number;
  aggregateSellUsd?: number;
  observedMarketCap?: number;
  marketCapObservedAt?: number;
  market?: Json;
  tokenInfo?: Json;
  tokenSecurity?: Json;
  tokenPool?: Json;
  trackedBuySafety?: Json;
  surgeAttribution?: Json;
}

const finite = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "") return null;
  const parsed=Number(value); return Number.isFinite(parsed)?parsed:null;
};
const truthyFlag=(value:unknown)=>value===true||value===1||value==="1"||value==="yes"||value==="true";

export function addressKey(address:string):string {
  return address.startsWith("0x")?address.toLowerCase():address;
}

export function validTokenAddress(chain:Chain,address:string):boolean {
  return chain==="sol"?/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address):/^0x[0-9a-fA-F]{40}$/.test(address);
}

export function marketSnapshot(row:Json):Json {
  const data=row.data??row,cur=row.cur_data??{};
  return {
    ...data,
    address:row.token_address??data.address,
    symbol:data.symbol??row.symbol,
    market_cap:finite(row.market_cap??data.market_cap??data.usd_market_cap),
    liquidity:finite(cur.liquidity??data.liquidity),
    holder_count:finite(cur.holder_count??data.holder_count),
    top_10_holder_rate:finite(cur.top_10_holder_rate??data.top_10_holder_rate),
    rug_ratio:finite(data.rug_ratio),
  };
}

export function passesMarketGate(row:Json,cfg:Json):{passed:boolean;reasons:string[]} {
  const m=marketSnapshot(row),reasons:string[]=[];
  const required=(ok:boolean,label:string)=>{if(!ok)reasons.push(label);};
  const liquidity=finite(m.liquidity),marketCap=finite(m.market_cap),holders=finite(m.holder_count);
  const top10=finite(m.top_10_holder_rate),rug=finite(m.rug_ratio),bundler=finite(m.bundler_rate??m.bundler_trader_amount_rate);
  const insider=finite(m.rat_trader_amount_rate??m.suspected_insider_hold_rate),entrapment=finite(m.entrapment_ratio),dev=finite(m.dev_team_hold_rate);
  required(liquidity!==null&&liquidity>=cfg.min_liquidity_usd,`liquidity below $${cfg.min_liquidity_usd}`);
  const liquidityRatio=liquidity!==null&&marketCap!==null&&marketCap>0?liquidity/marketCap:null,minRatio=finite(cfg.min_liquidity_to_market_cap_ratio)??.05;
  required(liquidityRatio!==null&&liquidityRatio>=minRatio,liquidityRatio===null?"liquidity-to-market-cap ratio unavailable":`liquidity-to-market-cap ratio below ${(minRatio*100).toFixed(1)}%`);
  required(marketCap!==null&&marketCap>=cfg.min_market_cap_usd&&marketCap<=cfg.max_market_cap_usd,"market cap outside configured range");
  required(holders!==null&&holders>=cfg.min_holders,`fewer than ${cfg.min_holders} holders`);
  required(rug!==null&&rug<=0.3,"rug ratio unavailable or above 0.30");
  required(!truthyFlag(m.is_wash_trading),"wash trading detected");
  required(!truthyFlag(m.is_honeypot),"honeypot detected");
  required(top10!==null&&top10>0&&top10<=cfg.max_top_10_holder_rate,"top-10 concentration is 0%, too high, or unavailable");
  required(bundler!==null&&bundler<=cfg.max_bundler_rate,"bundler activity too high or unavailable");
  required(insider!==null&&insider<=cfg.max_rat_trader_rate,"insider/rat activity too high or unavailable");
  required(entrapment!==null&&entrapment<=(cfg.max_entrapment_rate??1),"entrapment activity too high or unavailable");
  required(dev===null||dev<=cfg.max_dev_team_hold_rate,"dev-team holding too high");
  return {passed:reasons.length===0,reasons};
}

export function passesSurgeDiscoveryGate(row:Json,cfg:Json):{passed:boolean;reasons:string[]} {
  const m=marketSnapshot(row),reasons:string[]=[],required=(ok:boolean,label:string)=>{if(!ok)reasons.push(label);},liquidity=finite(m.liquidity),marketCap=finite(m.market_cap),holders=finite(m.holder_count),top10=finite(m.top_10_holder_rate),rug=finite(m.rug_ratio),minLiquidity=finite(cfg.tracked_alert_min_liquidity_usd)??500,minRatio=finite(cfg.tracked_alert_min_liquidity_to_market_cap_ratio)??.01,maxRatio=finite(cfg.tracked_alert_max_liquidity_to_market_cap_ratio)??10,minMarketCap=finite(cfg.tracked_alert_min_market_cap_usd)??5000,minHolders=finite(cfg.tracked_alert_min_holders)??10,maxTop10=finite(cfg.tracked_alert_max_top_10_holder_rate)??finite(cfg.max_top_10_holder_rate)??.3,ratio=liquidity!==null&&marketCap!==null&&marketCap>0?liquidity/marketCap:null;
  required(liquidity!==null&&liquidity>=minLiquidity,`liquidity below early-token floor $${minLiquidity}`);required(marketCap!==null&&marketCap>=minMarketCap&&marketCap<=cfg.max_market_cap_usd,`market cap unavailable or outside early-token range $${minMarketCap}-$${cfg.max_market_cap_usd}`);required(ratio!==null&&ratio>=minRatio,`liquidity-to-market-cap ratio below ${(minRatio*100).toFixed(1)}%`);required(ratio!==null&&ratio<=maxRatio,`liquidity-to-market-cap ratio above ${(maxRatio*100).toFixed(1)}%; market data is contradictory`);required(holders!==null&&holders>=minHolders,`fewer than ${minHolders} holders`);required(top10!==null&&top10>0&&top10<=maxTop10,"top-10 concentration is 0%, too high, or unavailable");required(rug===null||rug<=.3,"rug ratio above 0.30");required(!truthyFlag(m.is_wash_trading),"wash trading detected");required(!truthyFlag(m.is_honeypot),"honeypot detected");return {passed:reasons.length===0,reasons};
}

export function isCatastrophicMarketCapCollapse(baseline:unknown,current:unknown,ratio=.01):boolean {
  const baselineMarketCap=finite(baseline),currentMarketCap=finite(current),threshold=finite(ratio);
  return baselineMarketCap!==null&&baselineMarketCap>0&&currentMarketCap!==null&&currentMarketCap>=0&&threshold!==null&&threshold>0&&currentMarketCap<baselineMarketCap*threshold;
}

export function signalStrength(candidate:SignalCandidate):number {
  let score=0;
  if(candidate.sources.has("trending_smart_money"))score+=2;
  if(candidate.sources.has("trending_early_volume"))score+=1;
  if(candidate.sources.has("trending_multiwindow_stability"))score+=2;
  if(candidate.sources.has("smart_money_signal"))score+=2;
  if(candidate.sources.has("price_surge"))score+=1;
  if(candidate.sources.has("profitable_surge_wallet"))score+=3;
  if(candidate.sources.has("trending_momentum"))score+=1;
  if(candidate.sources.has("trending_small_cap"))score+=1;
  if(candidate.sources.has("twitter"))score+=1;
  if(candidate.sources.has("followed_wallet"))score+=2;
  if(candidate.sources.has("tracked_wallet"))score+=2;
  if(candidate.sources.has("fomo_most_held"))score+=1;
  if(candidate.sources.has("fomo_trending"))score+=1;
  if(candidate.sources.has("fomo_holder"))score+=2;
  if(candidate.sources.has("fomo_leaderboard"))score+=3;
  if(candidate.sources.has("fomo_tracked_wallet"))score+=3;
  if(candidate.sources.has("long_launchpad"))score+=1;
  if(candidate.sources.has("dexscreener_market"))score+=1;
  if(candidate.sources.has("smart_money_wallet"))score+=candidate.wallets.size>=3?3:candidate.wallets.size>=2?2:1;
  if(candidate.sources.has("kol_wallet"))score+=candidate.wallets.size>=3?2:1;
  return score;
}

export function hasCapitalConfirmation(candidate:SignalCandidate):boolean {
  return ["trending_multiwindow_stability","trending_smart_money","smart_money_signal","profitable_surge_wallet","smart_money_wallet","kol_wallet","followed_wallet","tracked_wallet","fomo_holder","fomo_leaderboard","fomo_tracked_wallet"].some(source=>candidate.sources.has(source as SignalSource));
}

export function shouldInvestigate(candidate:SignalCandidate,minStrength=3):boolean {
  return Boolean(candidate.market)&&hasCapitalConfirmation(candidate)&&signalStrength(candidate)>=minStrength;
}

export function hasTrackedBuyCluster(candidate:SignalCandidate,minWallets=3):boolean {
  return candidate.buyWallets.size>=minWallets;
}

export function extractContractAddresses(text:string):string[] {
  const evm=text.match(/\b0x[0-9a-fA-F]{40}\b/g)??[];
  const sol=text.match(/\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g)??[];
  return [...new Set([...evm,...sol])];
}
