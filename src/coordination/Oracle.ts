/**
 * MockOracle — Simulated SOL/USDC price and spread for demo.
 *
 * Maintains 24h of minute-level history; tick() advances price with random
 * walk. getPrice, get24hAverage, getSpread feed Accumulator and Flipper
 * decision logic. In production this would be Pyth or Switchboard.
 */
export interface PriceData {
    pair: string;
    price: number;
    timestamp: number;
    change24h: number;
  }
  
  export interface SpreadData {
    pair: string;
    bid: number;
    ask: number;
    askBidSpread: number;
    buyPressure: number;  // 0-1, >0.5 means more buy pressure
  }
  
  export class MockOracle {
    private prices: Map<string, number[]> = new Map();
    // Demo-friendly SOL/USDC base price; keep it in a realistic $75–$85 band.
    private basePrice = 80;
  
    constructor() {
      // Initialize with 24 hours of fake price history
      const history: number[] = [];
      let price = this.basePrice;
      for (let i = 0; i < 1440; i++) { // 1 per minute for 24h
        price += (Math.random() - 0.5) * 0.5; // ±$0.25 per minute
        // Keep price in a ~\$50–\$120 range so SOL hovers around \$75–\$85.
        price = Math.max(50, Math.min(120, price)); // Clamp
        history.push(price);
      }
      this.prices.set('SOL/USDC', history);
    }
  
    tick(): void {
      // Called by orchestrator to advance simulation
      for (const [pair, history] of this.prices) {
        const last = history[history.length - 1];
        // Add volatility spikes occasionally
        const spike = Math.random() < 0.05 ? (Math.random() - 0.5) * 4 : 0;
        const newPrice = last + (Math.random() - 0.5) * 1.0 + spike;
        history.push(Math.max(50, Math.min(120, newPrice)));
        if (history.length > 1440 * 2) history.shift(); // Keep 48h window
      }
    }
  
    getPrice(pair: string): number {
      const history = this.prices.get(pair);
      if (!history || history.length === 0) return this.basePrice;
      return history[history.length - 1];
    }
  
    get24hAverage(pair: string): number {
      const history = this.prices.get(pair);
      if (!history) return this.basePrice;
      const last24h = history.slice(-1440);
      return last24h.reduce((a, b) => a + b, 0) / last24h.length;
    }
  
    getSpread(pair: string): SpreadData {
      const price = this.getPrice(pair);
      const spreadPct = 0.001 + Math.random() * 0.008; // 0.1% to 0.9%
      const bid = price * (1 - spreadPct / 2);
      const ask = price * (1 + spreadPct / 2);
      return {
        pair,
        bid,
        ask,
        askBidSpread: spreadPct,
        buyPressure: Math.random(),
      };
    }
  
    getPriceChange(pair: string): number {
      const history = this.prices.get(pair);
      if (!history || history.length < 1440) return 0;
      const current = history[history.length - 1];
      const ago24h = history[history.length - 1440];
      return (current - ago24h) / ago24h;
    }
  }