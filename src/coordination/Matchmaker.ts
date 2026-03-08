/**
 * Matchmaker - Intent store for P2P trader matching.
 *
 * When a trader decides to SWAP, they first check for a matching opposite intent
 * (e.g. if selling, look for a buyer). If found, they execute a P2P swap.
 * Otherwise they post their intent and fall back to trading with the pool.
 * Intents expire after TTL to avoid stale matches.
 */
export interface SwapIntent {
  traderId: string;
  direction: string;
  amountSol: number;
  expiresAt: number;
}

export class Matchmaker {
  private intents: Map<string, SwapIntent> = new Map();

  /** Default TTL for intents (ms). */
  static readonly DEFAULT_TTL_MS = 10_000;

  /**
   * Try to find a matching opposite intent.
   * Sell (SOL→USDC) matches Buy (USDC→SOL) and vice versa.
   * Returns the matched intent and removes it from the store, or null if no match.
   */
  tryMatch(direction: string, amountSol: number): SwapIntent | null {
    this.pruneExpired();

    const oppositeDirection = direction === 'SOL→USDC' ? 'USDC→SOL' : 'SOL→USDC';

    for (const [key, intent] of this.intents) {
      if (intent.direction === oppositeDirection && this.amountMatches(intent.amountSol, amountSol)) {
        this.intents.delete(key);
        return intent;
      }
    }
    return null;
  }

  /**
   * Post a swap intent for future matching.
   * Intent expires after ttlMs.
   */
  postIntent(traderId: string, direction: string, amountSol: number, ttlMs = Matchmaker.DEFAULT_TTL_MS): void {
    this.pruneExpired();
    const key = `${traderId}:${Date.now()}`;
    this.intents.set(key, {
      traderId,
      direction,
      amountSol,
      expiresAt: Date.now() + ttlMs,
    });
  }

  /** Clear a specific trader's intents (e.g. after P2P match consumed it). */
  clearIntent(traderId: string): void {
    for (const [key, intent] of this.intents) {
      if (intent.traderId === traderId) {
        this.intents.delete(key);
        return;
      }
    }
  }

  private pruneExpired(): void {
    const now = Date.now();
    for (const [key, intent] of this.intents) {
      if (intent.expiresAt <= now) {
        this.intents.delete(key);
      }
    }
  }

  /** Match if amounts are within 20% of each other (allows for strategy jitter). */
  private amountMatches(a: number, b: number): boolean {
    const min = Math.min(a, b);
    const max = Math.max(a, b);
    return min >= max * 0.8;
  }
}
