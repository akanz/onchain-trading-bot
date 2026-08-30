console.log("Starting daily GMGN wallet discovery and qualification…");
await import("./daily-wallet-scan.js");

console.log("Starting daily Fomo wallet discovery and qualification…");
await import("./fomo-wallet-scan.js");
