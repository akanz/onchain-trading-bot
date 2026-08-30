import type { Alert, Chain, Json, TokenSnapshot } from "./types.js";
export const escapeHtml=(v:unknown)=>String(v).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;");
const compact=(value?:number)=>value===undefined?"n/a":new Intl.NumberFormat("en-US",{notation:"compact",maximumFractionDigits:1}).format(value);
const money=(value?:number)=>value===undefined?"n/a":`$${compact(value)}`;
const percent=(value?:number)=>value===undefined?"n/a":`${value>=0?"+":""}${value.toFixed(1)}%`;
const rate=(value?:number)=>value===undefined?"n/a":`${(value*100).toFixed(1)}%`;
const price=(value?:number)=>value===undefined?"n/a":value>=1?`$${value.toLocaleString("en-US",{maximumFractionDigits:4})}`:value>=.01?`$${value.toFixed(6)}`:value>=.000001?`$${value.toFixed(8)}`:`$${value.toExponential(3)}`;
const age=(seconds?:number)=>seconds===undefined?"n/a":seconds>=86400?`${Math.floor(seconds/86400)}d`:seconds>=3600?`${Math.floor(seconds/3600)}h`:`${Math.max(1,Math.floor(seconds/60))}m`;
const title=(value:string)=>value.split(/[_-]/).filter(Boolean).map(part=>part[0]?.toUpperCase()+part.slice(1)).join(" ");
const link=(label:string,url?:string)=>url?`<a href="${escapeHtml(url)}">${label}</a>`:label;
const httpUrl=(value:unknown):string|undefined=>{if(typeof value!=="string"||!value.trim())return undefined;try{const url=new URL(value.trim());return ["https:","http:"].includes(url.protocol)?url.toString():undefined;}catch{return undefined;}};
const short=(address:string)=>address.length>14?`${address.slice(0,6)}…${address.slice(-4)}`:address;
const traderName=(value:unknown)=>{const text=String(value??"").trim();return escapeHtml(/^(?:0x[0-9a-f]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$/i.test(text)?short(text):text);};
const explorer=(chain:Chain,address:string,kind:"token"|"address"="token")=>chain==="sol"?`https://solscan.io/${kind==="token"?"token":"account"}/${encodeURIComponent(address)}`:chain==="bsc"?`https://bscscan.com/${kind}/${encodeURIComponent(address)}`:chain==="base"?`https://basescan.org/${kind}/${encodeURIComponent(address)}`:chain==="robinhood"?`https://robinscan.io/${kind}/${encodeURIComponent(address)}`:chain==="eth"?`https://etherscan.io/${kind}/${encodeURIComponent(address)}`:undefined;
const dexScreener=(snapshot:TokenSnapshot)=>snapshot.poolAddress?`https://dexscreener.com/${snapshot.chain==="sol"?"solana":snapshot.chain}/${encodeURIComponent(snapshot.poolAddress)}`:undefined;
const securityWord=(label:string,value?:boolean)=>value===undefined?`${label} N/A`:value?`${label} PASS`:`${label} FAIL`;
const explicitRugText=(values:unknown[]):boolean=>values.some(value=>{const text=String(value);return !/\b(?:unavailable|unknown)\b/i.test(text)&&/\b(?:honeypot detected|rug(?: pull)? (?:detected|flagged)|scam(?: token)?|cannot sell|can't sell|unsellable|malicious contract)\b/i.test(text);});
const hasClearRugRisk=(snapshot:TokenSnapshot):boolean=>snapshot.honeypot===true||explicitRugText([...snapshot.verdict.reasons,...snapshot.verdict.warnings]);
export function formatRoster(chain:Chain,rows:Json[]):string {
  if(!rows.length)return `<b>${chain.toUpperCase()}</b>: no monitored profitable wallets yet.`;
  const evidence=(row:Json)=>Number(row.score)>0?`score ${Number(row.score).toFixed(1)}`:Number(row.max_position_roi_percent)>0?`max ROI ${percent(Number(row.max_position_roi_percent))}`:Number(row.fomo_leaderboard_pnl)>0?`Fomo PnL ${money(Number(row.fomo_leaderboard_pnl))}`:"profit evidence retained";
  return `<b>${chain.toUpperCase()} monitored wallets (${rows.length})</b>\n`+rows.slice(0,25).map((r,i)=>`${i+1}. ${r.fomo_handle?`<b>${escapeHtml(r.fomo_handle)}</b> · `:""}<code>${escapeHtml(r.wallet)}</code> — ${r.tracking_tier==="qualified"?"QUALIFIED":"ELITE OBSERVED"} · ${evidence(r)}`).join("\n");
}

export function formatTrackingStatus(chains:Chain[],diagnostics:Json):string {
  const lines=["🔎 <b>TRACKED-WALLET STATUS</b>"];
  for(const chain of chains){const row=diagnostics[chain]??{},buys=Array.isArray(row.fomo_recent_buys)?row.fomo_recent_buys:[],safety=row.tracked_buy_safety??{},multiples=row.multiplier_monitor??{};lines.push(`\n<b>${escapeHtml(chain.toUpperCase())}</b>\nMonitored addresses: ${Number(row.gmgn_tracked_wallets??0)} · Fomo-native profiles: ${Number(row.fomo_tracked_profiles??0)}\n2h multiplier baselines: ${Number(multiples.active_baselines??0)} active · ${Number(multiples.crossed_unannounced??0)} crossed but unannounced · max ${Number(multiples.max_observed_multiple??1).toFixed(2)}×\nRecent Fomo buys: ${Number(row.fomo_recent_buy_swaps??0)} · traders: ${Number(row.fomo_recent_buy_wallets??0)} · profile errors: ${Number(row.fomo_profile_scan_errors??0)}\nSafety checks: ${Number(safety.checked??0)} · passed: ${Number(safety.passed??0)} · suppressed: ${Number(safety.suppressed??0)} · unavailable: ${Number(safety.unavailable??0)}`);for(const buy of buys.slice(0,5)){const amount=Number(buy.amount_usd),amountText=Number.isFinite(amount)&&amount>0?` · ${money(amount)}`:"",when=buy.bought_at?` · ${escapeHtml(buy.bought_at)}`:"";lines.push(`• <b>${traderName(buy.trader)}</b> bought <code>${escapeHtml(buy.token)}</code>${amountText}${when}`);}}
  lines.push("\nℹ️ Recent means the configured signal lookback window. Unsafe tokens and tokens with unavailable GMGN safety data are counted as suppressed and are not sent as alerts.");
  return lines.join("\n").slice(0,4050);
}

export function formatSuppressedTokens(chains:Chain[],diagnostics:Json):string[] {
  const flagText=(value:unknown)=>value===true||value===1||value==="1"||value==="yes"?"yes":value===false||value===0||value==="0"||value==="no"?"no":"unknown",messages:string[]=[];
  for(const chain of chains){const rows=Array.isArray(diagnostics[chain]?.tracked_buy_safety?.recent_suppressed)?diagnostics[chain].tracked_buy_safety.recent_suppressed:[];for(const row of rows){const n=(value:unknown)=>Number.isFinite(Number(value))?Number(value):undefined,traders=(row.traders??[]).map(traderName).filter(Boolean),reason=(row.reasons??[]).map((value:unknown)=>escapeHtml(String(value).replace(/^FAIL\s+/,""))).join("; "),gmgn=httpUrl(row.gmgn_url),boughtAt=n(row.bought_at);messages.push([
    `🧪 <b>SUPPRESSED TRACKED BUY · ${escapeHtml(chain.toUpperCase())}</b>`,
    `<b>${escapeHtml(row.symbol??"Unknown")}${row.name&&row.name!==row.symbol?` · ${escapeHtml(row.name)}`:""}</b>`,
    `👤 Traders: ${traders.length?traders.join(", "):"unavailable"} · wallets ${n(row.wallet_count)??0} · observed ${money(n(row.aggregate_buy_usd))}${boughtAt?` · ${age(Math.max(0,Math.floor(Date.now()/1000)-boughtAt))} ago`:""}`,
    `💰 Price ${price(n(row.price))} · MC ${money(n(row.market_cap))} · liquidity ${money(n(row.liquidity))} (${rate(n(row.liquidity_to_market_cap_ratio))} of MC)`,
    `👥 Holders ${compact(n(row.holder_count))} · Top 10 ${rate(n(row.top_10_holder_rate))} · Smart ${compact(n(row.smart_wallets))} · KOL ${compact(n(row.renowned_wallets))} · fresh ${rate(n(row.fresh_wallet_rate))}`,
    `📊 Volume 1h ${money(n(row.volume_1h))} · 24h ${money(n(row.volume_24h))} · buys/sells 1h ${compact(n(row.buys_1h))}/${compact(n(row.sells_1h))}`,
    `🛡️ Honeypot ${flagText(row.honeypot)} · blacklist ${flagText(row.blacklist)} · cannot sell ${flagText(row.cannot_sell)} · source verified ${flagText(row.open_source)} · owner renounced ${flagText(row.renounced)} · LP locked ${flagText(row.liquidity_locked)}`,
    `🧾 Buy tax ${rate(n(row.buy_tax))} · sell tax ${rate(n(row.sell_tax))} · DEX ${escapeHtml(row.dex??"unknown")}`,
    row.creator?`🧑‍💻 Creator <code>${escapeHtml(row.creator)}</code>`:"",
    `🚫 Blocked because: ${reason||"safety details unavailable"}`,
    `<code>${escapeHtml(row.address)}</code>${gmgn?`\n${link("GMGN",gmgn)}`:""}`,
  ].filter(Boolean).join("\n").slice(0,4050));}}
  return messages.length?messages:[`🔎 No recently suppressed tracked-buy tokens for ${escapeHtml(chains.map(chain=>chain.toUpperCase()).join(" · "))}.`];
}

export function formatTrendingDigest(chains:Chain[],rows:Json[]):string {
  const items=rows.slice(0,10);
  const chainLabel=chains.map(chain=>chain.toUpperCase()).join(" · ");
  if(!items.length)return `🔎 <b>FRESH TRENDING SIGNALS · ${escapeHtml(chainLabel)}</b>\nNo new or strengthened signal this cycle.`;
  const lines=[`🔥 <b>${items.length} FRESH TRENDING SIGNAL${items.length===1?"":"S"}</b>`,`${escapeHtml(chainLabel)} · new events and strengthened momentum only`];
  for(const [index,row] of items.entries()){
    const symbol=escapeHtml(row.symbol??row.name??"Unknown"),n=(value:unknown)=>Number.isFinite(Number(value))?Number(value):undefined;
    const grade=escapeHtml(String(row.multiwindow_grade??"?")),score=n(row.multiwindow_score),pattern=escapeHtml(String(row.pattern??"structure unavailable")),tags=(Array.isArray(row.trending_signal_tags)?row.trending_signal_tags:[]).map((tag:unknown)=>escapeHtml(tag)).join(" · ");
    lines.push(`\n${index+1}. <b>${escapeHtml(String(row.chain??"?").toUpperCase())} · $${symbol}</b>${tags?` · <b>${tags}</b>`:""} · ${grade}${score===undefined?"":` ${Math.round(score)}/100`} · ${pattern}`);
    lines.push(`💰 MC ${money(n(row.market_cap))} · Liq ${money(n(row.liquidity))} · Vol 5m ${money(n(row.volume_5m??row.volume))} / 15m ${money(n(row.volume_15m))} / 30m ${money(n(row.volume_30m))} / 1h ${money(n(row.volume_1h))}`);
    lines.push(`📈 Change 5m ${percent(n(row.price_change_5m))} · 15m ${percent(n(row.price_change_15m))} · 30m ${percent(n(row.price_change_30m))} · 1h ${percent(n(row.price_change_1h))} · drawdown ${percent(n(row.drawdown_1h_percent))}`);
    if(row.address)lines.push(`<code>${escapeHtml(row.address)}</code>`);
  }
  lines.push("\nℹ️ Discovery only. Positive price is not required; persistent volume and stable structure are. Contract and tracked-wallet confirmation still apply before any trade.");
  return lines.join("\n").slice(0,4050);
}

function formatPonsDegenCard(row:Json):string {
  const n=(value:unknown)=>Number.isFinite(Number(value))?Number(value):undefined,address=String(row.address),name=escapeHtml(row.name??row.symbol??"Unknown token"),symbol=escapeHtml(row.symbol??"?"),quote=escapeHtml(row.quote_symbol??"?"),pons=`https://ponsfamily.com/launchpad/${encodeURIComponent(address)}`,change1h=n(row.price_change_1h),mc=n(row.market_cap),fdv=n(row.fdv??row.market_cap),ath=n(row.ath_market_cap),liq=n(row.liquidity),liqMultiple=fdv!==undefined&&liq&&liq>0?` [x${Math.max(1,Math.round(fdv/liq))}]`:"",version=escapeHtml(String(row.pons_version??"V1").toUpperCase()),status=escapeHtml(String(row.pons_status??"?")),progress=n(row.graduation_progress_percent),holders=Array.isArray(row.top_holders)?row.top_holders:[];
  const lines=[
    `🌱 ${link("PONS",pons)} · ${link(`<b>${name}</b>`,pons)} <b>[${compact(mc)}/${percent(change1h)}]</b> <b>$${symbol}/${quote}</b>`,
    `🌐 Robinhood @ Pons ${version}`,
    `💰 Price: ${price(n(row.price))}`,
    `💎 FDV: ${money(fdv)}${ath!==undefined?` → ATH ${money(ath)}`:""}`,
    `💧 Liquidity: ${money(liq)}${liqMultiple}`,
    `📊 Volume: 1H ${money(n(row.volume_1h))} · 24H ${money(n(row.volume_24h))} · Age ${age(n(row.token_age_seconds??row.launch_age_seconds))}`,
    `📈 1H: ${percent(change1h)} · buys ${compact(n(row.buys_1h))} · sells ${compact(n(row.sells_1h))}`,
    `🎯 ${status} · curve ${percent(progress)}${n(row.progress_change_30m)===undefined?"":` · change 30m ${percent(n(row.progress_change_30m))}`}`,
  ];
  if(holders.length){const top=holders.map((holder:Json)=>{const wallet=String(holder.address),hold=n(holder.amount_percentage);return link(`[${hold===undefined?"?":(hold*100).toFixed(1)}]`,explorer("robinhood",wallet,"address"));}).join(" · ");lines.push(`👥 Top holders: ${top}${n(row.top_10_holder_rate)===undefined?"":` [${(n(row.top_10_holder_rate)!*100).toFixed(1)}%]`}`);}else lines.push(`👥 Top holders: unavailable from GMGN this cycle${n(row.top_10_holder_rate)===undefined?"":` · Top 10 ${(n(row.top_10_holder_rate)!*100).toFixed(1)}%`}`);
  lines.push(`🤝 Holders: ${compact(n(row.holder_count))} · Smart: ${compact(n(row.smart_wallets))}`);
  lines.push(`🌱 Fresh wallets: ${n(row.fresh_wallet_rate)===undefined?"n/a":`${(n(row.fresh_wallet_rate)!*100).toFixed(1)}%`}`);
  const pool=String(row.pool_address??row.pool??""),chart=pool?`https://dexscreener.com/robinhood/${encodeURIComponent(pool)}`:undefined,defined=`https://defined.fi/token/robinhood/${encodeURIComponent(address)}`,gmgn=httpUrl(row.gmgn_url)??`https://gmgn.ai/robinhood/token/${encodeURIComponent(address)}`,axiom=`https://axiom.trade/t/${encodeURIComponent(address)}?chain=robinhood`,explore=explorer("robinhood",address),twitterUsername=String(row.twitter_username??"").trim().replace(/^@/,""),twitter=twitterUsername?`https://x.com/${encodeURIComponent(twitterUsername)}`:`https://x.com/search?q=${encodeURIComponent(address)}`,web=httpUrl(row.website);
  lines.push(`📈 Chart: ${[["DEX",chart],["DEF",defined]].filter((entry):entry is [string,string]=>Boolean(entry[1])).map(([label,url])=>link(label,url)).join(" · ")}`);
  const more:[[string,string|undefined]]|Array<[string,string|undefined]>=[["PONS",pons],["GMG",gmgn],["AXI",axiom],["EXP",explore],["X",twitter],["WEB",web]];lines.push(`🔗 Links: ${more.filter((entry):entry is [string,string]=>Boolean(entry[1])).map(([label,url])=>link(label,url)).join(" · ")}`);
  lines.push(`🔔 Signals: ${Array.isArray(row.degen_signal_labels)&&row.degen_signal_labels.length?row.degen_signal_labels.map((value:unknown)=>escapeHtml(value)).join(" · "):"PONS DISCOVERY"}`);
  lines.push(`\n<code>${escapeHtml(address)}</code>`);
  const bots:Array<[string,string]>=[["BSD","https://t.me/based_eth_bot"],["MAE","https://t.me/MaestroSniperBot"],["BLO","https://t.me/BloomEVMbot"],["SGM","https://t.me/Sigma_buyBot"],["BAN","https://t.me/BananaGunSniper_bot"]];lines.push(`🤖 Trading tools: ${bots.map(([label,url])=>link(label,url)).join(" · ")}`);
  lines.push("ℹ️ High-risk discovery only. Bot links open third-party trading tools; verify the CA, chain, taxes, slippage and sellability before signing.");
  return lines.join("\n").slice(0,4050);
}

export function formatDegenDigest(chains:Chain[],rows:Json[]):string[] {
  const chainLabel=chains.map(chain=>chain.toUpperCase()).join(" · "),maxMc=Number(process.env.DEGEN_MAX_MARKET_CAP_USD??100000);
  if(!rows.length)return [`🔎 <b>HIGH-RISK DISCOVERY · EARLY SETUPS</b>\n${escapeHtml(chainLabel)} · no filtered trending, microcap surge, or qualifying Pons launch was found this cycle.`];
  const pons=rows.filter(row=>row.pons_status),standard=rows.filter(row=>!row.pons_status),chunkSize=12,chunks:Json[][]=[];for(let index=0;index<standard.length;index+=chunkSize)chunks.push(standard.slice(index,index+chunkSize));
  const standardMessages=chunks.map((items,chunkIndex)=>{
    const lines=[`🌱 <b>HIGH-RISK DISCOVERY · TOP EARLY SETUPS</b>`,`${escapeHtml(chainLabel)} · Robinhood-heavy launchpad, microcap and surge signals · microcap highlights ≤ ${money(maxMc)} · ${chunkIndex+1}/${chunks.length}`];
    for(const [offset,row] of items.entries()){
      const n=(value:unknown)=>Number.isFinite(Number(value))?Number(value):undefined,symbol=escapeHtml(row.symbol??row.name??"Unknown"),labels=(row.degen_sources??[]).map((value:unknown)=>escapeHtml(value)).join(" · "),riskValues=(row.quality_reasons??[]).slice(0,3),rugRisk=explicitRugText(riskValues),risks=riskValues.map((value:unknown)=>escapeHtml(value)).join("; ")||"normal quality gate not passed";
      lines.push(`\n${chunkIndex*chunkSize+offset+1}. ${row.is_microcap?"🌱 MICROCAP · ":""}<b>${escapeHtml(String(row.chain??"?").toUpperCase())} · $${symbol}</b> · ${labels}`);
      if(row.pons_status){const status=escapeHtml(String(row.pons_status)),stageAge=n(row.graduated?row.graduated_age_seconds:row.launch_age_seconds);lines.push(`🎯 Pons ${status} · progress ${percent(n(row.graduation_progress_percent))} · pair ${escapeHtml(row.quote_symbol??"n/a")} · age ${age(stageAge)}`);lines.push(`📈 MC ${money(n(row.market_cap))} · change 5m ${percent(n(row.price_change_5m))} · change 30m ${percent(n(row.price_change_30m))} · progress change 30m ${percent(n(row.progress_change_30m))}`);}else lines.push(`📊 MC ${money(n(row.market_cap))} · Liq ${money(n(row.liquidity))} · Vol 5m ${money(n(row.volume))} · change 5m ${percent(n(row.price_change_percent5m??row.price_change_percent))} · swaps ${compact(n(row.swaps))}`);
      lines.push(`${rugRisk?"⚠️ Rug-risk evidence":"📝 Filter notes"}: ${risks}`);
      if(row.address)lines.push(`<code>${escapeHtml(row.address)}</code>`);
    }
    lines.push("\nℹ️ High-risk discovery feed. Filtered-trending rows failed normal filters; Pons launch data is discovery-only until contract/liquidity checks and tracked-wallet confirmation pass. This never triggers an automatic trade.");
    return lines.join("\n").slice(0,4050);
  });
  return [...pons.map(formatPonsDegenCard),...standardMessages];
}

export interface TokenCardContext {
  tier?:Alert["tier"];
  sources?:string[];
  signalStrength?:number;
  walletCount?:number;
  aggregateBuyUsd?:number;
  twitterAccounts?:string[];
}

export function formatTokenCard(s:TokenSnapshot,context:TokenCardContext={}):string {
  const tier=context.tier;
  const label=tier==="CALL"?"POTENTIAL CALL":tier==="RESEARCH"?"RESEARCH":s.verdict.passed?"PASSED CHECK":"REJECTED";
  const rugRisk=hasClearRugRisk(s),icon=rugRisk?"⚠️":tier==="CALL"?"🚀":tier==="RESEARCH"?"🔎":s.verdict.passed?"✅":"📝";
  const name=escapeHtml(s.name??s.symbol??"Unknown token"),symbol=s.symbol?`$${escapeHtml(s.symbol)}`:"symbol n/a";
  const chart=dexScreener(s),tokenName=link(`<b>${name}</b>`,chart);
  const mcChange=`[${compact(s.marketCap)}/${percent(s.priceChange24h)}]`;
  const multiple=s.marketCap!==undefined&&s.liquidity&&s.liquidity>0?` · MC/Liq ${(s.marketCap/s.liquidity).toFixed(1)}x`:"";
  const lines=[
    `${icon} <b>${label} · ${escapeHtml(s.chain.toUpperCase())}</b>`,
    `${tokenName} <b>${escapeHtml(mcChange)} ${symbol}</b>`,
    `🌐 ${escapeHtml(title(s.chain))}${s.dex?` @ ${escapeHtml(title(s.dex))}`:" · DEX n/a"}`,
    `💰 Price: ${price(s.price)}`,
    `💎 MCap: ${money(s.marketCap)} · FDV: ${money(s.fdv)}`,
    `💧 Liquidity: ${money(s.liquidity)}${multiple}`,
    `📊 Volume: 5m ${money(s.volume5m)} · 1h ${money(s.volume1h)} · 24h ${money(s.volume24h)} · Age ${age(s.ageSeconds)}`,
    `📈 1h: ${percent(s.priceChange1h)} · buys ${compact(s.buys1h)} / sells ${compact(s.sells1h)}`,
    `👥 Holders: ${compact(s.holderCount)} · Top 10: ${rate(s.top10HolderRate)} · Smart: ${compact(s.smartWallets)} · Fresh: ${rate(s.freshWalletRate)}`,
    `🛡️ Security: ${securityWord("honeypot-free",s.honeypot===undefined?undefined:!s.honeypot)} · ${securityWord("source",s.openSource)} · ${securityWord("owner renounced",s.renounced)} · ${securityWord("LP locked",s.liquidityLocked)}`,
    `🧾 Tax: buy ${rate(s.buyTax)} · sell ${rate(s.sellTax)}`,
  ];
  if(s.topHolders.length){
    lines.push("👤 <b>Largest holders</b>");
    for(const [index,holder] of s.topHolders.entries()){
      const walletLink=link(escapeHtml(short(holder.address)),explorer(s.chain,holder.address,"address"));
      const tags=holder.tags.length?` · ${escapeHtml(holder.tags.join(", "))}`:"";
      lines.push(`${index+1}. ${walletLink} · ${rate(holder.percentage)}${holder.usdValue===undefined?"":` · ${money(holder.usdValue)}`}${tags}`);
    }
  } else lines.push("👤 Largest holders: unavailable from GMGN for this token/chain");
  if(context.sources?.length){
    const sources=context.sources.map(source=>source.replaceAll("_"," ")).join(", ");
    lines.push(`🔔 Signals: ${escapeHtml(sources)} · strength ${context.signalStrength??"n/a"}`);
    lines.push(`🐋 Tracked wallets: ${context.walletCount??0} · observed buys ${money(context.aggregateBuyUsd)}`);
  }
  const failed=s.verdict.reasons.filter(reason=>reason.startsWith("FAIL "));
  const concerns=[...failed,...s.verdict.warnings];
  lines.push(`${s.verdict.passed?"✅":"🔎"} Filter: <b>${s.verdict.passed?"PASS":"FAIL"} · ${s.verdict.score}/100</b> · ${s.verdict.passed?"all configured gates passed":`${concerns.length} blocking concern(s)`}`);
  if(concerns.length)lines.push(`${rugRisk?"⚠️ Rug-risk evidence":"📝 Filter concerns"}: ${escapeHtml(concerns.slice(0,5).join("; "))}`);
  if(context.twitterAccounts?.length)lines.push(`💬 Mentioned on X by: ${context.twitterAccounts.map(account=>`@${escapeHtml(account)}`).join(", ")}`);
  const links:[[string,string|undefined]]|Array<[string,string|undefined]>=[["DEX",chart],["GMG",s.gmgn],["EXP",explorer(s.chain,s.address)],["WEB",s.website],["X",s.twitter??`https://x.com/search?q=${encodeURIComponent(s.address)}`]];
  lines.push(`🔗 Links: ${links.filter((entry):entry is [string,string]=>Boolean(entry[1])).map(([label,url])=>link(label,url)).join(" · ")}`);
  lines.push(`<code>${escapeHtml(s.address)}</code>`);
  return lines.join("\n").slice(0,4050);
}

export function formatAlert(a:Alert):string {
  if(a.kind==="MULTIPLE"){
    const multiple=Number(a.multiple),milestone=Math.floor(Number(a.milestone)),remaining=Math.max(0,Number(a.expires_at??0)-Math.floor(Date.now()/1000)),symbol=a.symbol?`$${escapeHtml(a.symbol)}`:"This token",initialMc=Number.isFinite(Number(a.baseline_market_cap))?money(Number(a.baseline_market_cap)):"n/a",currentMc=Number.isFinite(Number(a.current_market_cap))?money(Number(a.current_market_cap)):"n/a",warnings=Array.isArray(a.token_warnings)?a.token_warnings:[],verdictReasons=Array.isArray(a.token_snapshot?.verdict?.reasons)?a.token_snapshot.verdict.reasons:[],scanNotes=[...verdictReasons.filter((reason:unknown)=>String(reason).startsWith("FAIL ")),...warnings],rugRisk=a.token_snapshot?.honeypot===true||explicitRugText(scanNotes),rawScore=Number(a.token_score),score=Number.isFinite(rawScore)?`${Number.isInteger(rawScore)?rawScore:rawScore.toFixed(1)}/100`:"score unavailable",status=a.token_passed?`✅ <b>PASSED · ${score}</b>`:rugRisk?`⚠️ <b>RUG RISK · ${score}</b>`:`🔎 <b>NEEDS REVIEW · ${score}</b>`,scan=a.token_snapshot?`${status}${!a.token_passed&&!scanNotes.length?"\nThe latest safety scan did not pass every configured filter.":""}${scanNotes.length?`\n${rugRisk?"Rug-risk evidence":"Review notes"}: ${escapeHtml(scanNotes.slice(0,3).join("; "))}`:""}`:"🔎 Safety re-scan unavailable; treat this as a price-only update.";
    return `🚀 <b>${milestone}X MOMENTUM UPDATE</b>\n<b>${symbol} · ${escapeHtml(a.chain.toUpperCase())}</b>\nNow <b>${multiple.toFixed(2)}x</b> from the ${escapeHtml(String(a.source??"scan").toLowerCase())} baseline\n\n<b>Market move</b>\n💰 Price   ${price(Number(a.baseline_price))} → ${price(Number(a.current_price))}\n💎 MCap   ${initialMc} → ${currentMc}\n⏱️ Tracked ${age(Number(a.age_seconds))} · ${age(remaining)} remaining\n\n<b>Safety check</b>\n${scan}\n\n<b>Contract</b>\n<code>${escapeHtml(a.address)}</code>\n\nℹ️ Monitor current liquidity and the latest safety result before acting.`;
  }
  if(["WALLET_CLUSTER","TRACKED_WALLET_BUY","TRACKED_WALLET_OBSERVE","TRACKED_WALLET_POTENTIAL","TRACKED_WALLET_BUY_SIGNAL"].includes(String(a.kind))){
    const count=Number(a.wallet_count??0),label=String(a.tracking_label??(count>=3?"BUY SIGNAL":count===2?"POTENTIAL":"OBSERVE")),icon=count>=3?"🔥":count===2?"✨":"👀",sourceLabels=[...new Set((a.sources??[]).filter((source:string)=>source==="tracked_wallet"||source==="followed_wallet"||source==="fomo_tracked_wallet").map((source:string)=>source==="fomo_tracked_wallet"?"Fomo":source==="followed_wallet"?"GMGN followed feed":"GMGN"))],traders=(Array.isArray(a.traders)?a.traders:[]).map(traderName).filter(Boolean),traderText=traders.length?traders.slice(0,5).join(traders.length===2?" + ":", "):`${count} tracked wallet${count===1?"":"s"}`,observedAt=Number(a.market_cap_observed_at??a.first_timestamp),timeText=Number.isFinite(observedAt)&&observedAt>0?` · ${age(Math.max(0,Math.floor(Date.now()/1000)-observedAt))} ago`:"",marketCap=Number(a.market_cap_at_detection),marketCapText=Number.isFinite(marketCap)&&marketCap>0?money(marketCap):"unavailable";
    return `${icon} <b>${escapeHtml(label)} · TRACKED-WALLET BUY · ${escapeHtml(a.chain.toUpperCase())}</b>\n👤 <b>${traderText}</b> bought${a.symbol?` <b>$${escapeHtml(a.symbol)}</b>`:" this token"}\n${Number(a.aggregate_buy_usd)>0?`💵 Observed size: ${money(Number(a.aggregate_buy_usd))}\n`:""}💎 Market cap at detection: ${marketCapText}${timeText}\n🔎 Source: ${escapeHtml(sourceLabels.join(" + ")||"tracked-wallet feed")}\n\n<b>Contract</b>\n<code>${escapeHtml(a.address)}</code>\n\nℹ️ ${count>=3?"This is a multi-wallet buy signal":"Keep observing for more tracked-wallet confirmation"}; it is not an automatic trade instruction.`;
  }
  if(a.token_snapshot)return formatTokenCard(a.token_snapshot,{tier:a.tier,sources:a.sources,signalStrength:a.signal_strength,walletCount:a.wallet_count,aggregateBuyUsd:a.aggregate_buy_usd,twitterAccounts:a.twitter_accounts});
  const failures=Array.isArray(a.failures)?a.failures:[],rugRisk=explicitRugText(failures),icon=rugRisk?"⚠️":a.tier==="CALL"?"🚀":a.tier==="RESEARCH"?"🔎":"📝",sources=(a.sources??[]).map((source:string)=>source.replaceAll("_"," ")).join(", ");
  const market=a.market_cap?`\nMCap: $${Number(a.market_cap).toLocaleString()} · liquidity: $${Number(a.liquidity??0).toLocaleString()}`:"";
  const twitter=a.twitter_accounts?.length?`\nX: ${a.twitter_accounts.map((x:string)=>`@${escapeHtml(x)}`).join(", ")}`:"";
  return `${icon} <b>${a.tier} · ${a.chain.toUpperCase()}${a.symbol?` · ${escapeHtml(a.symbol)}`:""}</b>\n<code>${escapeHtml(a.address)}</code>\n🔔 Signals: ${escapeHtml(sources)} · strength: ${a.signal_strength??"?"}${market}\n🐋 Wallets: ${a.wallet_count??0} · observed buys: $${Number(a.aggregate_buy_usd??0).toLocaleString()} · safety: ${a.token_score??"?"}/100${twitter}${failures.length?`\n${rugRisk?"⚠️ Rug-risk evidence":"📝 Reasons"}: ${escapeHtml(failures.slice(0,3).join("; "))}`:""}`;
}
