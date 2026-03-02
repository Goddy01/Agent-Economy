import { BaseAgent, AgentConfig } from './BaseAgent';
import { AgentDecision } from './types';
import { Connection } from '@solana/web3.js';
import { KeyVault } from '../vault/KeyVault';
import { WalletManager } from '../wallet/WalletManager';
import { TransactionEngine } from '../transactions/TransactionEngine';
import { MemoLogger } from '../coordination/MemoLogger';
import { RationaleEngine } from '../ai/RationaleEngine';

const FLOOR_SOL = parseFloat(process.env.VAULT_FLOOR_SOL ?? '5.0');

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
      tickMs: 60_000, // Slow — it just receives and protects
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

    // Vault only acts to report status — never initiates spending
    return {
      type: 'HOLD',
      agentId: this.id,
      reason: `Vault holding ${balance.toFixed(4)} SOL. Floor: ${FLOOR_SOL} SOL. Protected.`,
      params: { balance, floor: FLOOR_SOL, safeToSpend: balance - FLOOR_SOL },
      timestamp: Date.now(),
      confidence: 1.0,
    };
  }

  protected async execute(_decision: AgentDecision): Promise<void> {
    // Vault never executes outbound transactions autonomously
    // Its spending is explicitly blocked by TransactionEngine circuit breaker
  }

  getVaultStatus(): {
    balance: number;
    floor: number;
    safeToSpend: number;
    totalReceived: number;
    incomingCount: number;
  } {
    const totalReceived = this.incomingQueue.reduce((sum, r) => sum + r.amount, 0);
    return {
      balance: 0, // Updated live from WalletManager
      floor: FLOOR_SOL,
      safeToSpend: 0,
      totalReceived,
      incomingCount: this.incomingQueue.length,
    };
  }
}