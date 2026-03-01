import { Connection } from '@solana/web3.js';
import { KeyVault } from '../vault/KeyVault';
import { WalletManager } from '../wallet/WalletManager';
import { TransactionEngine } from '../transactions/TransactionEngine';
import { MemoLogger } from '../coordination/MemoLogger';
import { RationaleEngine } from '../ai/RationaleEngine';
import { AgentDecision, AgentStats } from './types';
import EventEmitter from 'events';

export interface AgentConfig {
  id: string;
  name: string;
  tickMs: number;
}

export abstract class BaseAgent extends EventEmitter {
  protected id: string;
  protected name: string;
  protected connection: Connection;
  protected vault: KeyVault;
  protected walletManager: WalletManager;
  protected txEngine: TransactionEngine;
  protected memoLogger: MemoLogger;
  protected rationaleEngine: RationaleEngine;
  protected stats: AgentStats;
  private tickMs: number;
  private tickInterval?: NodeJS.Timer;

  constructor(
    config: AgentConfig,
    connection: Connection,
    vault: KeyVault,
    walletManager: WalletManager,
    txEngine: TransactionEngine,
    memoLogger: MemoLogger,
    rationaleEngine: RationaleEngine
  ) {
    super();
    this.id = config.id;
    this.name = config.name;
    this.tickMs = config.tickMs;
    this.connection = connection;
    this.vault = vault;
    this.walletManager = walletManager;
    this.txEngine = txEngine;
    this.memoLogger = memoLogger;
    this.rationaleEngine = rationaleEngine;
    this.stats = this.initStats();
  }

  // ─── Lifecycle ─────────────────────────────────────────────────

  async initialize(): Promise<void> {
    const address = await this.walletManager.createWallet(this.id);
    this.emit('initialized', { agentId: this.id, address });
    await this.onInitialize();
  }

  start(): void {
    this.tickInterval = setInterval(() => this.tick(), this.tickMs);
    this.emit('started', { agentId: this.id });
  }

  stop(): void {
    if (this.tickInterval) {
      clearInterval(this.tickInterval as unknown as number);
    }
    this.emit('stopped', { agentId: this.id });
  }

  // ─── Abstract Methods (implement per agent) ────────────────────

  protected abstract onInitialize(): Promise<void>;
  protected abstract decide(): Promise<AgentDecision>;
  protected abstract execute(decision: AgentDecision): Promise<void>;

  // ─── Tick ──────────────────────────────────────────────────────

  private async tick(): Promise<void> {
    try {
      const decision = await this.decide();

      if (decision.type === 'HOLD') {
        this.emit('decision', { decision, skipped: true });
        return;
      }

      // Enrich with LLM rationale (non-blocking — if it fails, we proceed)
      decision.rationale = await this.rationaleEngine.explain(decision)
        .catch(() => `${decision.reason}`);

      this.emit('decision', { decision, skipped: false });

      await this.execute(decision);

      // Write decision to on-chain memo
      await this.memoLogger.log(this.id, decision)
        .catch(err => this.emit('warn', `Memo logging failed: ${err}`));

    } catch (err) {
      this.emit('error', { agentId: this.id, error: String(err) });
    }
  }

  // ─── Helpers ───────────────────────────────────────────────────

  protected async getBalance(): Promise<number> {
    return this.walletManager.getSolBalance(this.id);
  }

  protected recordTrade(success: boolean, volumeSOL: number): void {
    this.stats.totalTrades++;
    if (success) {
      this.stats.successfulTrades++;
      this.stats.totalVolumeSOL += volumeSOL;
    } else {
      this.stats.failedTrades++;
    }
  }

  getStats(): AgentStats {
    return { ...this.stats };
  }

  getId(): string { return this.id; }
  getName(): string { return this.name; }

  private initStats(): AgentStats {
    return {
      agentId: this.id,
      totalTrades: 0,
      successfulTrades: 0,
      failedTrades: 0,
      totalVolumeSOL: 0,
      pnlSOL: 0,
      vaultContributions: 0,
      lastAction: 'Initializing',
      lastActionTime: Date.now(),
    };
  }
}