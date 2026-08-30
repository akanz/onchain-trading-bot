import test from "node:test";
import assert from "node:assert/strict";
import { formatAlert, formatDegenDigest, formatTokenCard, formatTrendingDigest } from "../src/format.js";
import { buildTokenSnapshot } from "../src/token-card.js";

const verdict={passed:true,score:100,reasons:["PASS honeypot check passed"],warnings:[]};

test("token card derives market data and renders a tangible potential-call alert",()=>{
  const snapshot=buildTokenSnapshot("robinhood","0x56910D4409F3a0C78C64DD8D0545FF0705389870",{
    name:"The <Index>",symbol:"Index",holder_count:18665,circulating_supply:"1000000000",max_supply:"1000000000",liquidity:"769094",
    price:{price:"0.02",price_1h:"0.019",price_24h:"0.022",volume_5m:"12899",volume_1h:"139579",volume_24h:"3123414",buys_1h:134,sells_1h:86},
    pool:{pool_address:"0xpool",exchange:"uniswap_v3",creation_timestamp:Math.floor(Date.now()/1000)-86400},
    stat:{fresh_wallet_rate:"0.05"},wallet_tags_stat:{smart_wallets:7},link:{gmgn:"https://gmgn.ai/token",website:"javascript:alert(1)"}
  },{is_honeypot:false,is_open_source:true,is_renounced:true,top_10_holder_rate:"0.125",buy_tax:"0",sell_tax:"0",lock_summary:{is_locked:true}},{pool_address:"0xpool",exchange:"uniswap_v3",liquidity:"769094",creation_timestamp:Math.floor(Date.now()/1000)-86400},[],verdict);
  assert.equal(snapshot.marketCap,20_000_000);
  assert.ok((snapshot.priceChange24h??0)<-9);
  const message=formatAlert({tier:"CALL",chain:"robinhood",address:snapshot.address,token_snapshot:snapshot,sources:["smart_money_wallet"],signal_strength:5,wallet_count:3,aggregate_buy_usd:12000});
  assert.match(message,/POTENTIAL CALL/);
  assert.match(message,/MCap: \$20M/);
  assert.match(message,/24h \$3\.1M/);
  assert.match(message,/Top 10: 12\.5%/);
  assert.match(message,/Largest holders: unavailable/);
  assert.match(message,/smart money wallet/);
  assert.doesNotMatch(message,/<Index>/);
  assert.doesNotMatch(message,/javascript:/);
  assert.ok(message.length<4096);
});

test("degen digest labels rejected microcaps and splits long feeds",()=>{
  const rows=Array.from({length:13},(_,index)=>({chain:index%2?"bsc":"sol",symbol:`MICRO${index+1}`,address:`0x${String(index+1).padStart(40,"0")}`,market_cap:50_000+index,liquidity:8_000,volume:20_000,price_change_percent5m:35,swaps:90,degen_sources:index===0?["FILTERED TRENDING","PRICE SURGE"]:["FILTERED TRENDING"],quality_reasons:["liquidity below $50000","fewer than 300 holders"]}));
  const messages=formatDegenDigest(["sol","bsc"],rows);
  assert.equal(messages.length,2);
  assert.match(messages[0]!,/DEGEN MODE/);
  assert.match(messages[0]!,/highlights ≤ \$100K/);
  assert.match(messages[0]!,/PRICE SURGE/);
  assert.match(messages[0]!,/failed normal filters/);
  assert.match(messages[1]!,/MICRO13/);
  assert.ok(messages.every(message=>message.length<4096));
});

test("degen digest renders a rich Pons card with verified trading-bot links",()=>{const [message]=formatDegenDigest(["robinhood"],[{chain:"robinhood",name:"Money <Printer>",symbol:"BRRR",address:"0x1111111111111111111111111111111111111111",price:.0000371,market_cap:37_100,fdv:37_100,ath_market_cap:88_400,liquidity:8_100,is_microcap:true,pons_status:"ACTIVE",pons_version:"v2",graduation_progress_percent:72,quote_symbol:"USDG",launch_age_seconds:600,price_change_1h:-6.4,price_change_5m:35,price_change_30m:110,progress_change_30m:8,volume_1h:159_000,volume_24h:240_000,buys_1h:1300,sells_1h:1000,holder_count:324,top_10_holder_rate:.23,fresh_wallet_rate:.1,top_holders:[{address:"0x2222222222222222222222222222222222222222",amount_percentage:.082}],website:"javascript:alert(1)",degen_sources:["PONS ACTIVE","PONS PRICE SURGE","NEAR GRADUATION"],degen_signal_labels:["PONS PRICE SURGE","NEAR GRADUATION"],quality_reasons:["Pons launchpad discovery; full contract and liquidity checks have not passed"]}]);assert.match(message!,/Robinhood @ Pons V2/);assert.match(message!,/Money &lt;Printer&gt;/);assert.match(message!,/\[37\.1K\/-6\.4%\]/);assert.match(message!,/curve \+72\.0%/);assert.match(message!,/TH: .*8\.2/);assert.match(message!,/MaestroSniperBot/);assert.match(message!,/BananaGunSniper_bot/);assert.match(message!,/PONS PRICE SURGE/);assert.match(message!,/0x1111111111111111111111111111111111111111/);assert.doesNotMatch(message!,/javascript:/);});

test("failed check includes real rejection reasons",()=>{
  const snapshot=buildTokenSnapshot("base","0x1111111111111111111111111111111111111111",{name:"Risky",symbol:"RISK",price:{price:"1"},circulating_supply:"100"},{is_honeypot:true},{},[],{passed:false,score:25,reasons:["FAIL honeypot detected"],warnings:["Unknown critical field: liquidity"]});
  const message=formatTokenCard(snapshot);
  assert.match(message,/REJECTED/);
  assert.match(message,/FAIL honeypot detected/);
  assert.match(message,/Unknown critical field: liquidity/);
  assert.match(message,/Liquidity: n\/a/);
});

test("trending digest returns ten ranked multi-window contracts and cluster alert returns the CA",()=>{
  const rows=Array.from({length:12},(_,index)=>({chain:index%2?"bsc":"sol",symbol:`T${index+1}`,address:`0x${String(index+1).padStart(40,"0")}`,market_cap:index===0?400_000:1_000_000+index,liquidity:100_000,volume_5m:30_000,volume_15m:90_000,volume_30m:180_000,volume_1h:360_000,price_change_5m:index,price_change_15m:2,price_change_30m:index===0?120:20,price_change_1h:25,drawdown_1h_percent:8,multiwindow_grade:"A",multiwindow_score:82,pattern:"Bullish consolidation"}));
  const digest=formatTrendingDigest(["sol","bsc"],rows);
  assert.match(digest,/TOP 10 EARLY \+ STABLE TRENDING TOKENS/);
  assert.match(digest,/SOL · BSC/);
  assert.match(digest,/Vol 5m \$30K \/ 15m \$90K \/ 30m \$180K \/ 1h \$360K/);
  assert.match(digest,/A 82\/100 · Bullish consolidation/);
  assert.match(digest,/\$T10/);
  assert.doesNotMatch(digest,/\$T11/);
  assert.match(digest,new RegExp(rows[0]!.address));
  const cluster=formatAlert({tier:"RESEARCH",kind:"WALLET_CLUSTER",chain:"sol",address:"So11111111111111111111111111111111111111112",wallet_count:2,aggregate_buy_usd:500});
  assert.match(cluster,/2 distinct tracked wallets bought/);
  assert.match(cluster,/So11111111111111111111111111111111111111112/);
  assert.match(cluster,/CA trigger only/);
});

test("multiple alert shows the initial baseline and fresh safety rescan",()=>{
  const message=formatAlert({tier:"RESEARCH",kind:"MULTIPLE",chain:"robinhood",address:"0x1111111111111111111111111111111111111111",symbol:"BRRR",milestone:2,multiple:2.14,baseline_price:.00001,current_price:.0000214,baseline_market_cap:40_000,current_market_cap:85_600,first_seen:Math.floor(Date.now()/1000)-900,expires_at:Math.floor(Date.now()/1000)+6_300,age_seconds:900,source:"PONS DEGEN",token_snapshot:{},token_passed:true,token_score:88,token_warnings:[]});
  assert.match(message,/2X UPDATE/);
  assert.match(message,/2\.14x/);
  assert.match(message,/PONS degen baseline/i);
  assert.match(message,/Re-scan: <b>PASSED · 88\/100<\/b>/);
  assert.match(message,/0x1111111111111111111111111111111111111111/);
});
