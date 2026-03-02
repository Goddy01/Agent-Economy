import { BaseAgent, AgentConfig } from './BaseAgent';
import { AgentDecision } from './types';
import { MockOracle } from '../coordination/Oracle';
import { Connection } from '@solana/web3.js';
import { KeyVault } from '../vault/KeyVault';
import { WalletManager } from '../wallet/WalletManager';
import { TransactionEngine } from '../transactions/TransactionEngine';
import { MemoLogger } from '../coordination/MemoLogger';
import { RationaleEngine } from '../ai/RationaleEngine';

const BUY_THRESHOLD = -0.02;    // Buy when price dips >2% from 24h avg
const VAULT_CUT = 0.1;           // 10% of gains to vault
const MAX_BUY_SOL = 0.2;         // Max 0.2 SOL per buy
const MIN_BALANCE_SOL = 0.5;     // Keep reserve

export class Accumulator extends BaseAgent {
  private oracle: MockOracle;
  private vaultAddress: string;
  private lastBuyPrice: number | null = null;

  constructor(
    oracle: MockOracle,
    vaultAddress: string,
    connection: Connection,
    vault: KeyVault,
    walletManager: WalletManager,
    txEngine: TransactionEngine,
    memoLogger: MemoLogger,
    rationaleEngine: RationaleEngine
  ) {
    const config: AgentConfig = {
      id: 'accumulator',
      name: 'The Accumulator',
      tickMs: 30_000, // Check every 30 seconds
    };
    super(config, connection, vault, walletManager, txEngine, memoLogger, rationaleEngine);
    this.oracle = oracle;
    this.vaultAddress = vaultAddress;
  }

  protected async onInitialize(): Promise<void> {
    const price = this.oracle.getPrice('SOL/USDC');
    this.lastBuyPrice = price;
  }

  protected async decide(): Promise<AgentDecision> {
    const currentPrice = this.oracle.getPrice('SOL/USDC');
    const avgPrice = this.oracle.get24hAverage('SOL/USDC');
    const priceChange = (currentPrice - avgPrice) / avgPrice;
    const balance = await this.getBalance();

    // Rule 1: Not enough balance to trade
    if (balance < MIN_BALANCE_SOL + MAX_BUY_SOL) {
      return {
        type: 'HOLD',
        agentId: this.id,
        reason: `Insufficient balance (${balance.toFixed(3)} SOL). Need ${(MIN_BALANCE_SOL + MAX_BUY_SOL).toFixed(2)} SOL minimum.`,
        params: { balance, currentPrice },
        timestamp: Date.now(),
        confidence: 1.0,
      };
    }

    // Rule 2: Price dip detected — accumulate
    if (priceChange < BUY_THRESHOLD) {
      const dipPercent = Math.abs(priceChange * 100).toFixed(1);
      return {
        type: 'BUY',
        agentId: this.id,
        reason: `Price dip ${dipPercent}% below 24h average. Buy signal triggered.`,
        params: {
          currentPrice,
          avgPrice,
          priceChange,
          buyAmount: MAX_BUY_SOL,
        },
        timestamp: Date.now(),
        confidence: Math.min(1.0, Math.abs(priceChange) / 0.05), // Scale with dip size
      };
    }

    // Rule 3: Send gains to vault if we've made profit
    if (this.lastBuyPrice && currentPrice > this.lastBuyPrice * 1.01) {
      const gain = (currentPrice - this.lastBuyPrice) / this.lastBuyPrice;
      const contribution = MAX_BUY_SOL * gain * VAULT_CUT;
      if (contribution > 0.001) {
        return {
          type: 'TRANSFER_TO_VAULT',
          agentId: this.id,
          reason: `Profit-taking: ${(gain * 100).toFixed(1)}% gain. Sending ${VAULT_CUT * 100}% to vault.`,
          params: { contribution, gain, vaultAddress: this.vaultAddress },
          timestamp: Date.now(),
          confidence: 0.8,
        };
      }
    }

    return {
      type: 'HOLD',
      agentId: this.id,
      reason: `Price change ${(priceChange * 100).toFixed(2)}% within normal range. Waiting for dip.`,
      params: { currentPrice, avgPrice, priceChange },
      timestamp: Date.now(),
      confidence: 1.0,
    };
  }

  protected async execute(decision: AgentDecision): Promise<void> {
    this.stats.lastAction = decision.reason;
    this.stats.lastActionTime = Date.now();

    if (decision.type === 'TRANSFER_TO_VAULT') {
      const { contribution, vaultAddress } = decision.params as {
        contribution: number;
        vaultAddress: string;
      };

      const tx = await this.walletManager.buildTransferTransaction(
        this.id,
        vaultAddress as string,
        contribution
      );

      const result = await this.txEngine.executeTransaction(
        this.id,
        tx,
        `Vault contribution: ${contribution.toFixed(4)} SOL`
      );

      if (result.success) {
        this.stats.vaultContributions += contribution;
        this.recordTrade(true, contribution);
        this.emit('trade', { type: 'VAULT_CONTRIBUTION', amount: contribution, result });
      } else {
        this.recordTrade(false, 0);
        this.emit('trade', { type: 'VAULT_CONTRIBUTION_FAILED', reason: result.blockedBy ?? result.error });
      }
    }

    // BUY logic: In real implementation, call OrcaAdapter
    // For demo: simulate buy by recording the decision
    if (decision.type === 'BUY') {
      this.lastBuyPrice = decision.params.currentPrice as number;
      this.recordTrade(true, decision.params.buyAmount as number);
      this.emit('trade', { type: 'BUY', decision });
    }
  }
}