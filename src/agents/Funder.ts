/**
 * Funder agent - Distributes SOL from its own wallet to other agents.
 *
 * You send SOL to the funder's wallet (same vault-derived address as any agent).
 * The funder agent tops up other agents' wallets to TARGET_AGENT_SOL so they
 * can operate. No private key in .env; the funder is just another agent.
 */
import { BaseAgent, AgentConfig } from './BaseAgent';
import { AgentDecision } from './types';
import { KeyVault } from '../vault/KeyVault';
import { WalletManager } from '../wallet/WalletManager';
import { TransactionEngine } from '../transactions/TransactionEngine';
import { MemoLogger } from '../coordination/MemoLogger';
import { RationaleEngine } from '../ai/RationaleEngine';

const DEFAULT_MIN_SEND_SOL = 0.005;
const DEFAULT_TICK_MS = 45_000; // Check and distribute every 45s
const DEFAULT_RESERVE_SOL = 0.01;

export interface FunderAgentConfig {
  agentIds: string[];
  targetSolPerAgent: number;
  /** Minimum SOL to send in a single top-up transfer. */
  minSendSol?: number;
  /** Amount of SOL to keep as a safety reserve on the funder itself. */
  reserveSol?: number;
  /** Decision loop interval in ms. */
  tickMs?: number;
}

function isTraderAgent(agentId: string): boolean {
  return agentId.startsWith('trader') || agentId.startsWith('flipper');
}

export class FunderAgent extends BaseAgent {
  private peerAgentIds: string[];
  private readonly lowBalanceThreshold: number;
  private readonly topupAmountSol: number;
  private readonly traderLowBalanceThreshold: number;
  private readonly traderTopupAmountSol: number;
  private readonly minSendSol: number;
  private readonly reserveSol: number;

  constructor(
    config: FunderAgentConfig,
    connection: import('@solana/web3.js').Connection,
    vault: KeyVault,
    walletManager: WalletManager,
    txEngine: TransactionEngine,
    memoLogger: MemoLogger,
    rationaleEngine: RationaleEngine
  ) {
    const agentConfig: AgentConfig = {
      id: 'funder',
      name: 'The Funder',
      tickMs: config.agentIds.length > 0 ? (config.tickMs ?? DEFAULT_TICK_MS) : 60_000,
    };
    super(agentConfig, connection, vault, walletManager, txEngine, memoLogger, rationaleEngine);
    this.peerAgentIds = config.agentIds.filter((id) => id !== 'funder' && id !== 'vault' && id !== 'pool');
    this.lowBalanceThreshold = parseFloat(process.env.FUNDER_LOW_BALANCE_THRESHOLD ?? '0.7');
    this.topupAmountSol = parseFloat(process.env.FUNDER_TOPUP_AMOUNT_SOL ?? '1');
    const traderTarget = parseFloat(process.env.FUNDER_TRADER_TARGET_SOL ?? '0.2');
    this.traderLowBalanceThreshold = Math.max(0.05, traderTarget - 0.05);
    this.traderTopupAmountSol = traderTarget;
    this.minSendSol = config.minSendSol ?? DEFAULT_MIN_SEND_SOL;
    this.reserveSol = config.reserveSol ?? DEFAULT_RESERVE_SOL;
  }

  protected async onInitialize(): Promise<void> {}

  /** Remove an agent from the top-up list (e.g. after it is deleted and funds claimed). */
  removePeer(agentId: string): void {
    this.peerAgentIds = this.peerAgentIds.filter((id) => id !== agentId);
  }

  /** Add an agent to the top-up list (e.g. when dynamically adding a new trader). */
  addPeer(agentId: string): void {
    if (this.peerAgentIds.includes(agentId)) return;
    if (agentId === 'funder' || agentId === 'vault' || agentId === 'pool') return;
    this.peerAgentIds.push(agentId);
  }

  protected async decide(): Promise<AgentDecision> {
    const funderBalance = await this.getFunderBalance();
    let remaining = Math.max(0, funderBalance - this.reserveSol);
    const distributions: Array<{ agentId: string; amountSol: number }> = [];
    for (const agentId of this.peerAgentIds) {
      if (remaining < this.minSendSol) break;
      const balance = await this.walletManager.getSolBalance(agentId);
      const threshold = isTraderAgent(agentId) ? this.traderLowBalanceThreshold : this.lowBalanceThreshold;
      const topup = isTraderAgent(agentId) ? this.traderTopupAmountSol : this.topupAmountSol;
      // Only top up agents that are at or below the low-balance threshold.
      if (balance > threshold) continue;
      const amount = Math.min(topup, remaining);
      if (amount >= this.minSendSol) {
        distributions.push({ agentId, amountSol: amount });
        remaining -= amount;
      }
    }
    if (distributions.length === 0) {
      return {
        type: 'HOLD',
        agentId: this.id,
        reason: 'Funder: all agents above low-balance threshold. Send SOL to funder wallet to top up.',
        params: {},
        timestamp: Date.now(),
        confidence: 1.0,
      };
    }
    return {
      // Use a non-HOLD type so BaseAgent will call execute() and actually
      // send the distributions instead of skipping them.
      type: 'TRADE',
      agentId: this.id,
      reason: `Funder: topping up ${distributions.length} low-balance agent(s)`,
      params: { distributions },
      timestamp: Date.now(),
      confidence: 1.0,
    };
  }

  private async getFunderBalance(): Promise<number> {
    return this.walletManager.getSolBalance(this.id);
  }

  protected async execute(decision: AgentDecision): Promise<void> {
    const distributions = decision.params?.distributions as Array<{ agentId: string; amountSol: number }> | undefined;
    if (!Array.isArray(distributions) || distributions.length === 0) return;

    for (const { agentId, amountSol } of distributions) {
      try {
        const toAddress = this.vault.getAgentPublicKey(agentId);
        const tx = await this.walletManager.buildTransferTransaction(this.id, toAddress, amountSol);
        const result = await this.txEngine.executeTransaction(this.id, tx, 'funder top-up');
        if (result.success && result.signature) {
          this.stats.totalTrades += 1;
          this.stats.successfulTrades += 1;
          this.stats.outboundSOL = (this.stats.outboundSOL ?? 0) + amountSol;
          this.stats.lastAction = `Sent ${amountSol.toFixed(4)} SOL to ${agentId}`;
          this.stats.lastActionTime = Date.now();
          this.emit('trade', {
            type: 'FUNDER_DISTRIBUTION',
            agentId: this.id,
            to: agentId,
            amount: amountSol,
            signature: result.signature,
            result,
          });
        } else {
          this.stats.totalTrades += 1;
          this.stats.failedTrades += 1;
          this.emit('trade', {
            type: 'FUNDER_DISTRIBUTION_FAILED',
            agentId: this.id,
            to: agentId,
            amount: amountSol,
            blockedBy: result.blockedBy,
            error: result.error,
          });
        }
      } catch (err) {
        this.stats.failedTrades += 1;
        this.emit('error', { agentId: this.id, error: String(err) });
      }
    }
  }
}
