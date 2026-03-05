/**
 * RateLimiter — Per-agent sliding-window rate limit.
 *
 * Each agent has an independent window (e.g. 2 tx per 60s). Used by
 * TransactionEngine to block flood attacks (Attack 2, Attack 6 in security tests).
 */
export class RateLimiter {
    private windows: Map<string, number[]> = new Map();
    private maxTxPerWindow: number;
    private windowMs: number;
  
    constructor(maxTxPerWindow: number = 10, windowMs: number = 60_000) {
      this.maxTxPerWindow = maxTxPerWindow;
      this.windowMs = windowMs;
    }
  
    /**
     * Check if agent is allowed to transact.
     * Returns { allowed: boolean, remaining: number, resetIn: number }
     */
    check(agentId: string): { allowed: boolean; remaining: number; resetIn: number } {
      const now = Date.now();
      const window = this.getWindow(agentId);
  
      // Remove timestamps outside the window
      const validTimestamps = window.filter(ts => now - ts < this.windowMs);
      this.windows.set(agentId, validTimestamps);
  
      const remaining = this.maxTxPerWindow - validTimestamps.length;
      const oldest = validTimestamps[0] ?? now;
      const resetIn = this.windowMs - (now - oldest);
  
      return {
        allowed: remaining > 0,
        remaining,
        resetIn,
      };
    }
  
    /**
     * Record a transaction for an agent.
     * Call only after a successful send.
     */
    record(agentId: string): void {
      const window = this.getWindow(agentId);
      window.push(Date.now());
      this.windows.set(agentId, window);
    }
  
    private getWindow(agentId: string): number[] {
      if (!this.windows.has(agentId)) {
        this.windows.set(agentId, []);
      }
      return this.windows.get(agentId)!;
    }
  
    getStats(agentId: string): { txInWindow: number; windowMs: number } {
      const now = Date.now();
      const window = this.getWindow(agentId);
      const validTimestamps = window.filter(ts => now - ts < this.windowMs);
      return { txInWindow: validTimestamps.length, windowMs: this.windowMs };
    }
  }