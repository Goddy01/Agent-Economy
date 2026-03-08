/**
 * Vault agent - Treasury; does not initiate outbound spends.
 *
 * Receives SOL from Traders (recordIncoming). decide() always
 * returns HOLD with status message. execute() is no-op.
 */
import { BaseAgent, AgentConfig } from './BaseAgent';
import { AgentDecision } from './types';
import { Connection } from '@solana/web3.js';
import { KeyVault } from '../vault/KeyVault';
import { WalletManager } from '../wallet/WalletManager';
import { TransactionEngine } from '../transactions/TransactionEngine';
import { MemoLogger } from '../coordination/MemoLogger';
import { RationaleEngine } from '../ai/RationaleEngine';

export class VaultAgent extends BaseAgent {
  private incomingQueue: Array<{ from: string; amount: number; timestamp: number }> = [];

  constructor(
    connection: Connection,
    vault: KeyVault,
    walletManager: WalletManager,
    txEngine: TransactionEngine,
    memoLogger: MemoLogger,
    rationaleEngine: RationaleEngine
  ) {
    const config: AgentConfig = {
      id: 'vault',
      name: 'The Vault',
      tickMs: 60_000, // Slow - it just receives and protects
    };
    super(config, connection, vault, walletManager, txEngine, memoLogger, rationaleEngine);
  }

  protected async onInitialize(): Promise<void> {}

  // External agents call this to notify the vault of incoming funds
  recordIncoming(from: string, amount: number): void {
    this.incomingQueue.push({ from, amount, timestamp: Date.now() });
    this.stats.lastAction = `Received ${amount.toFixed(4)} SOL from ${from}`;
    this.stats.lastActionTime = Date.now();
    this.stats.vaultContributions += amount;
    this.emit('received', { from, amount });
  }

  protected async decide(): Promise<AgentDecision> {
    const balance = await this.getBalance();

    // Vault only acts to report status - never initiates spending
    return {
      type: 'HOLD',
      agentId: this.id,
      reason: `Vault holding ${balance.toFixed(4)} SOL. Protected.`,
      params: { balance },
      timestamp: Date.now(),
      confidence: 1.0,
    };
  }

  protected async execute(_decision: AgentDecision): Promise<void> {
    // Vault never initiates outbound spends.
  }

  getVaultStatus(): {
    balance: number;
    totalReceived: number;
    incomingCount: number;
  } {
    const totalReceived = this.incomingQueue.reduce((sum, r) => sum + r.amount, 0);
    return {
      balance: 0, // Updated live from WalletManager
      totalReceived,
      incomingCount: this.incomingQueue.length,
    };
  }
}