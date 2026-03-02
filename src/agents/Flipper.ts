import { BaseAgent, AgentConfig } from './BaseAgent';
import { AgentDecision } from './types';
import { MockOracle } from '../coordination/Oracle';
import { OrcaAdapter } from '../dex/OrcaAdapter';
import { Connection } from '@solana/web3.js';
import { KeyVault } from '../vault/KeyVault';
import { WalletManager } from '../wallet/WalletManager';
import { TransactionEngine } from '../transactions/TransactionEngine';
import { MemoLogger } from '../coordination/MemoLogger';
import { RationaleEngine } from '../ai/RationaleEngine';

const SPREAD_THRESHOLD = 0.003;   // 0.3% spread to trigger trade
const TRADE_AMOUNT_SOL = 0.05;    // Small flip amounts
const VAULT_CUT = 0.15;            // 15% to vault (higher frequency = higher cut)

export class Flipper extends BaseAgent {
  private oracle: MockOracle;
  private orca: OrcaAdapter;
  private vaultAddress: string;
  private totalFlipProfit = 0;

  constructor(
    oracle: MockOracle,
    orca: OrcaAdapter,
    vaultAddress: string,
    connection: Connection,
    vault: KeyVault,
    walletManager: WalletManager,
    txEngine: TransactionEngine,
    memoLogger: MemoLogger,
    rationaleEngine: RationaleEngine
  ) {
    const config: AgentConfig = {
      id: 'flipper',
      name: 'The Flipper',
      tickMs: 10_000, // Every 10 seconds — aggressive
    };
    super(config, connection, vault, walletManager, txEngine, memoLogger, rationaleEngine);
    this.oracle = oracle;
    this.orca = orca;
    this.vaultAddress = vaultAddress;
  }

  protected async onInitialize(): Promise<void> {
    // Ensure token accounts exist for both sides of the swap pair
  }

  protected async decide(): Promise<AgentDecision> {
    const spread = this.oracle.getSpread('SOL/USDC');
    const balance = await this.getBalance();

    if (balance < TRADE_AMOUNT_SOL + 0.01) {
      return {
        type: 'HOLD',
        agentId: this.id,
        reason: 'Insufficient balance for flip',
        params: { balance },
        timestamp: Date.now(),
        confidence: 1.0,
      };
    }

    // Rule: Spread is wide enough to profit after fees
    if (spread.askBidSpread > SPREAD_THRESHOLD) {
      const direction = spread.buyPressure > 0.5 ? 'SOL→USDC' : 'USDC→SOL';
      return {
        type: 'SWAP',
        agentId: this.id,
        reason: `Spread ${(spread.askBidSpread * 100).toFixed(2)}% exceeds threshold. ${direction} flip opportunity.`,
        params: {
          direction,
          amount: TRADE_AMOUNT_SOL,
          expectedProfit: spread.askBidSpread * TRADE_AMOUNT_SOL,
          spread,
        },
        timestamp: Date.now(),
        confidence: Math.min(1.0, spread.askBidSpread / 0.01),
      };
    }

    // Periodic vault contribution from accumulated profits
    if (this.totalFlipProfit > 0.05) {
      const contribution = this.totalFlipProfit * VAULT_CUT;
      return {
        type: 'TRANSFER_TO_VAULT',
        agentId: this.id,
        reason: `Accumulated ${this.totalFlipProfit.toFixed(4)} SOL profit. Sending ${VAULT_CUT * 100}% to vault.`,
        params: { contribution, totalProfit: this.totalFlipProfit },
        timestamp: Date.now(),
        confidence: 1.0,
      };
    }

    return {
      type: 'HOLD',
      agentId: this.id,
      reason: `Spread ${(spread.askBidSpread * 100).toFixed(3)}% below ${(SPREAD_THRESHOLD * 100)}% threshold. Waiting.`,
      params: { spread },
      timestamp: Date.now(),
      confidence: 1.0,
    };
  }

  protected async execute(decision: AgentDecision): Promise<void> {
    this.stats.lastAction = decision.reason;
    this.stats.lastActionTime = Date.now();

    if (decision.type === 'SWAP') {
      try {
        const swapResult = await this.orca.executeSwap(
          this.id,
          decision.params.direction as string,
          decision.params.amount as number
        );

        if (swapResult.success) {
          const profit = decision.params.expectedProfit as number;
          this.totalFlipProfit += profit;
          this.stats.pnlSOL += profit;
          this.recordTrade(true, decision.params.amount as number);
          this.emit('trade', { type: 'SWAP', decision, result: swapResult });
        }
      } catch (err) {
        this.recordTrade(false, 0);
        this.emit('trade', { type: 'SWAP_FAILED', error: String(err) });
      }
    }

    if (decision.type === 'TRANSFER_TO_VAULT') {
      const { contribution } = decision.params as { contribution: number };
      const tx = await this.walletManager.buildTransferTransaction(
        this.id,
        this.vaultAddress,
        contribution
      );

      const result = await this.txEngine.executeTransaction(
        this.id,
        tx,
        `Vault contribution from flip profits`
      );

      if (result.success) {
        this.totalFlipProfit -= contribution;
        this.stats.vaultContributions += contribution;
        this.recordTrade(true, contribution);
      }
    }
  }
}