import { fomoChain, type FomoToken } from "./client.js";
import type { Chain, Json } from "../types.js";
import { crossedHistoricalMarketCap, historicalMarketCap } from "../market-cap.js";

const addSource=(profile:Json,source:string)=>{const values:Array<unknown>=profile.discovery_sources??[];if(!values.includes(source))values.push(source);profile.discovery_sources=values;};

export function buildFomoTrackedWallets(profiles:Json[],tokens:FomoToken[],enabledChains:Chain[],minimumTrendingAthMarketCap=1_000_000):Json[] {
  const trackedProfiles=new Map<string,Json>();
  for(const profile of profiles){const id=String(profile.id??"");if(!id||profile.private||profile.isRestricted)continue;trackedProfiles.set(id,{...profile,discovery_sources:["fomo_leaderboard"]});}
  for(const token of tokens){
    const sources=[] as string[];if(token.sources.has("fomo_most_held"))sources.push("fomo_most_held_500pct");if(token.sources.has("fomo_trending")&&crossedHistoricalMarketCap(token,minimumTrendingAthMarketCap))sources.push("fomo_trending_500pct");if(!sources.length)continue;
    for(const holder of token.holders){const user:Json=holder.user??{},id=String(user.id??"");if(!id||user.private||user.isRestricted)continue;const profile=trackedProfiles.get(id)??{...user,discovery_sources:[]};for(const source of sources)addSource(profile,source);const positions:Json[]=profile.qualifying_positions??[];if(!positions.some(row=>Number(row.networkId)===token.networkId&&row.tokenAddress===token.address))positions.push({networkId:token.networkId,tokenAddress:token.address,symbol:token.token?.symbol,currentMarketCap:Number(token.marketCap??0),athMarketCap:historicalMarketCap(token),roiPercent:holder.roiPercent,realizedRoiPercent:holder.realizedRoiPercent,unrealizedRoiPercent:holder.unrealizedRoiPercent});profile.qualifying_positions=positions;trackedProfiles.set(id,profile);}
  }
  const output:Json[]=[];
  for(const profile of trackedProfiles.values()){
    for(const chain of enabledChains){const wallet=chain==="sol"?String(profile.address??""):String(profile.evmAddress??"");if(!wallet)continue;const positionRows:Json[]=profile.qualifying_positions??[],chainPositions=positionRows.filter(row=>fomoChain(row.networkId)===chain),max=(field:string)=>chainPositions.length?Math.max(...chainPositions.map(row=>Number(row[field]??0))):undefined;output.push({chain,wallet,fomo_user_id:String(profile.id),fomo_handle:profile.userHandle,discovery_sources:profile.discovery_sources??[],leaderboard_periods:profile.leaderboard_periods??[],leaderboard_ranks:profile.leaderboard_ranks??{},qualifying_position_count:chainPositions.length,max_position_roi_percent:max("roiPercent"),max_realized_position_roi_percent:max("realizedRoiPercent"),max_unrealized_position_roi_percent:max("unrealizedRoiPercent"),tracking_tier:"observed"});}
  }
  return output;
}
