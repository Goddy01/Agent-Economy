/**
 * Pool agent - Passive counterparty for simulated swaps.
 *
 * Holds SOL as the liquidity reserve; no decide/execute logic.
 * Traders swap via PoolAdapter; profits come from this reserve.
 * (Orca fallback). Pool wallet is created and funded; agent exists only for
 * dashboard display and key derivation.
 */
import { BaseAgent, AgentConfig } from './BaseAgent';
import { AgentDecision } from './types';
import { Connection } from '@solana/web3.js';
import { KeyVault } from '../vault/KeyVault';
import { WalletManager } from '../wallet/WalletManager';
import { TransactionEngine } from '../transactions/TransactionEngine';
import { MemoLogger } from '../coordination/MemoLogger';
import { RationaleEngine } from '../ai/RationaleEngine';

export class PoolAgent extends BaseAgent {
  constructor(
    agentId: string,
    connection: Connection,
    vault: KeyVault,
    walletManager: WalletManager,
    txEngine: TransactionEngine,
    memoLogger: MemoLogger,
    rationaleEngine: RationaleEngine
  ) {
    const config: AgentConfig = {
      id: agentId,
      name: 'Pool',
      tickMs: 60_000,
    };
    super(config, connection, vault, walletManager, txEngine, memoLogger, rationaleEngine);
  }

  protected async onInitialize(): Promise<void> {}

  protected async decide(): Promise<AgentDecision> {
    return {
      type: 'HOLD',
      agentId: this.id,
      reason: 'Pool: passive counterparty for simulated swaps',
      params: {},
      timestamp: Date.now(),
      confidence: 1.0,
    };
  }

  protected async execute(_decision: AgentDecision): Promise<void> {
    // No-op
  }
}
