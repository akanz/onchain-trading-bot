export type Chain = "sol" | "bsc" | "base" | "robinhood" | "eth" | "arc" | "stable";
export type Json = Record<string, any>;

export interface Verdict {
  passed: boolean;
  score: number;
  reasons: string[];
  warnings: string[];
}

export interface TrackerConfig extends Json {
  default_chain: Chain;
  enabled_chains: Chain[];
}

export interface Alert extends Json {
  tier: "CALL" | "RESEARCH" | "REJECT";
  chain: Chain;
  address: string;
  symbol?: string;
}

export interface TokenHolderSnapshot {
  address: string;
  percentage?: number | undefined;
  usdValue?: number | undefined;
  profit?: number | undefined;
  tags: string[];
}

export interface TokenSnapshot extends Json {
  chain: Chain;
  address: string;
  name?: string | undefined;
  symbol?: string | undefined;
  price?: number | undefined;
  marketCap?: number | undefined;
  fdv?: number | undefined;
  liquidity?: number | undefined;
  priceChange1h?: number | undefined;
  priceChange24h?: number | undefined;
  volume5m?: number | undefined;
  volume1h?: number | undefined;
  volume24h?: number | undefined;
  buys1h?: number | undefined;
  sells1h?: number | undefined;
  ageSeconds?: number | undefined;
  holderCount?: number | undefined;
  top10HolderRate?: number | undefined;
  smartWallets?: number | undefined;
  freshWalletRate?: number | undefined;
  dex?: string | undefined;
  poolAddress?: string | undefined;
  website?: string | undefined;
  twitter?: string | undefined;
  telegram?: string | undefined;
  gmgn?: string | undefined;
  honeypot?: boolean | undefined;
  openSource?: boolean | undefined;
  renounced?: boolean | undefined;
  liquidityLocked?: boolean | undefined;
  buyTax?: number | undefined;
  sellTax?: number | undefined;
  topHolders: TokenHolderSnapshot[];
  verdict: Verdict;
}
