/**
 * Agent decision and stats types.
 *
 * Used by all agents (Trader, Funder, Pool, Vault) and the dashboard.
 * AgentDecision is the output of decide(); execute() acts on it.
 */
export type AgentDecisionType =
  | 'BUY'
  | 'SELL'
  | 'SWAP'
  | 'TRANSFER_TO_VAULT'
  | 'HOLD'
  | 'AIRDROP_REQUEST'
  | 'TRADE';

export interface AgentDecision {
  type: AgentDecisionType;
  agentId: string;
  reason: string;           // Deterministic rule that triggered this
  rationale?: string;       // LLM-generated human-readable explanation
  params: Record<string, unknown>;
  timestamp: number;
  confidence: number;       // 0-1 score from rule engine
}

export interface AgentStats {
  agentId: string;
  totalTrades: number;
  successfulTrades: number;
  failedTrades: number;
  totalVolumeSOL: number;
  pnlSOL: number;
  /**
   * Realized P&L in USD: proceeds from sells (minus gas) − cost basis of the SOL that was sold (avg cost × amount sold).
   * Cost basis uses total cost of buys (incl. gas + DEX fees) / total SOL bought; only the portion attributable to sold SOL is subtracted.
   * Not reduced when profit is sent to the vault; P&L measures trading performance regardless of where the SOL is held.
   */
  pnlUSD?: number;
  /** Current SOL position (total bought − total sold). Used for unrealized P&L. */
  positionSOL?: number;
  /** Average entry price in USD (cost basis / total SOL bought). */
  avgEntryPriceUSD?: number;
  /** Unrealized P&L: (current price − avg entry) × position SOL. Computed by Orchestrator from live price. */
  unrealizedPnlUSD?: number;
  vaultContributions: number;
  lastAction: string;
  lastActionTime: number;
  /** ROI percentage (PnL / total deposited), when applicable. */
  roiPercent?: number;
}