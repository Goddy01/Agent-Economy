/**
 * Funder agent — Distributes SOL from its own wallet to other agents.
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

const MIN_SEND_SOL = 0.005;
const TICK_MS = 45_000; // Check and distribute every 45s

export interface FunderAgentConfig {
  agentIds: string[];
  targetSolPerAgent: number;
}

export class FunderAgent extends BaseAgent {
  private readonly peerAgentIds: string[];
  private readonly targetSol: number;

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
      tickMs: config.agentIds.length > 0 ? TICK_MS : 60_000,
    };
    super(agentConfig, connection, vault, walletManager, txEngine, memoLogger, rationaleEngine);
    this.peerAgentIds = config.agentIds.filter((id) => id !== 'funder' && id !== 'vault');
    this.targetSol = config.targetSolPerAgent;
  }

  protected async onInitialize(): Promise<void> {}

  protected async decide(): Promise<AgentDecision> {
    const funderBalance = await this.getFunderBalance();
    const reserve = 0.01;
    let remaining = Math.max(0, funderBalance - reserve);
    const distributions: Array<{ agentId: string; amountSol: number }> = [];
    for (const agentId of this.peerAgentIds) {
      if (remaining < MIN_SEND_SOL) break;
      const balance = await this.walletManager.getSolBalance(agentId);
      if (balance >= this.targetSol) continue;
      const amount = Math.min(this.targetSol - balance, remaining);
      if (amount >= MIN_SEND_SOL) {
        distributions.push({ agentId, amountSol: amount });
        remaining -= amount;
      }
    }
    if (distributions.length === 0) {
      return {
        type: 'HOLD',
        agentId: this.id,
        reason: 'Funder: all agents above target. Send SOL to funder wallet to top up.',
        params: {},
        timestamp: Date.now(),
        confidence: 1.0,
      };
    }
    return {
      type: 'HOLD',
      agentId: this.id,
      reason: `Funder: topping up ${distributions.length} agent(s) to ${this.targetSol} SOL`,
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
