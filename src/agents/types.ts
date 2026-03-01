export type AgentDecisionType =
  | 'BUY'
  | 'SELL'
  | 'SWAP'
  | 'TRANSFER_TO_VAULT'
  | 'HOLD'
  | 'AIRDROP_REQUEST';

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
  vaultContributions: number;
  lastAction: string;
  lastActionTime: number;
}