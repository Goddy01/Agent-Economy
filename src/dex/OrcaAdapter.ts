import {
  Connection,
  PublicKey,
  Transaction,
  VersionedTransaction,
  SystemProgram,
} from '@solana/web3.js';
import { KeyVault } from '../vault/KeyVault';
import { TransactionEngine } from '../transactions/TransactionEngine';
import { WalletManager } from '../wallet/WalletManager';
import type { MockOracle } from '../coordination/Oracle';
import { buildSimulatedSwap } from './PoolAdapter';

export interface SwapResult {
  success: boolean;
  signature?: string;
  inputAmount: number;
  outputAmount?: number;
  error?: string;
  simulated: boolean;
}

/** Result of building a swap: Pool simulated swap (SOL-only) or fallback memo-only tx. */
export interface BuildSwapResult {
  tx: Transaction | VersionedTransaction;
  realSwap: boolean;
  estimatedOutputSol?: number;
  /** When true, use executePoolSwap(traderId, poolId, tx) instead of executeTransaction. */
  poolSwap?: boolean;
  /** USDC amount (human) in the tx when pool swap with USDC; so dashboard can match Solscan. */
  amountUsdc?: number;
}

/**
 * OrcaAdapter - Swap interface for Trader agent.
 *
 * When pool has balance (and USDC when USDC_MINT is set), returns a Pool simulated swap
 * (SOL and optionally USDC SPL transfers). Otherwise 0-lamport self-transfer for memo fallback.
 */
export class OrcaAdapter {
  private connection: Connection;
  private vault: KeyVault;
  private txEngine: TransactionEngine;
  private walletManager: WalletManager;
  private poolId: string | null;
  private oracle: MockOracle | null;
  private usdcMint: PublicKey | null;

  constructor(
    connection: Connection,
    vault: KeyVault,
    txEngine: TransactionEngine,
    walletManager: WalletManager,
    options?: { poolId?: string; oracle?: MockOracle; usdcMint?: PublicKey | null }
  ) {
    this.connection = connection;
    this.vault = vault;
    this.txEngine = txEngine;
    this.walletManager = walletManager;
    this.poolId = options?.poolId ?? null;
    this.oracle = options?.oracle ?? null;
    this.usdcMint = options?.usdcMint ?? null;
  }

  /**
   * Build a swap transaction: Pool simulated swap (SOL + optional USDC) when pool has balance, else memo tx.
   */
  async buildSwapTransactionForMemo(
    agentId: string,
    direction: string,
    amountSol: number
  ): Promise<BuildSwapResult> {
    if (this.poolId && this.oracle) {
      const price = this.oracle.getPrice('SOL/USDC');
      const spreadData = this.oracle.getSpread('SOL/USDC');
      const spread = Math.max(0.0005, spreadData.askBidSpread);
      const poolSolBalance = await this.walletManager.getSolBalance(this.poolId);
      const isSell = direction === 'SOL→USDC';
      const poolNeedsSol = isSell ? amountSol * (1 - spread) : amountSol;

      let poolHasEnough = poolSolBalance >= poolNeedsSol + 0.01;
      if (poolHasEnough && this.usdcMint) {
        if (isSell) {
          const poolUsdcBalance = await this.walletManager.getTokenBalance(this.poolId, this.usdcMint);
          if (poolUsdcBalance < amountSol * price) poolHasEnough = false;
        } else {
          const traderUsdcBalance = await this.walletManager.getTokenBalance(agentId, this.usdcMint);
          if (traderUsdcBalance < amountSol * price) poolHasEnough = false;
        }
      }

      if (poolHasEnough) {
        try {
          const poolOut = await buildSimulatedSwap(
            this.connection,
            this.vault,
            agentId,
            this.poolId,
            direction,
            amountSol,
            price,
            spread,
            { usdcMint: this.usdcMint ?? undefined }
          );
          return {
            tx: poolOut.tx,
            realSwap: true,
            estimatedOutputSol: poolOut.estimatedOutputSol,
            poolSwap: true,
            amountUsdc: poolOut.amountUsdc,
          };
        } catch {
          // Fall through to memo tx
        }
      }
    }

    const agentAddress = new PublicKey(this.vault.getAgentPublicKey(agentId));
    const { blockhash } = await this.connection.getLatestBlockhash();
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: agentAddress,
        toPubkey: agentAddress,
        lamports: 0,
      })
    );
    tx.recentBlockhash = blockhash;
    tx.feePayer = agentAddress;
    return { tx, realSwap: false };
  }

  /**
   * Execute a swap: builds tx (Pool or memo) and runs it through TransactionEngine.
   */
  async executeSwap(
    agentId: string,
    direction: string,
    amountSol: number
  ): Promise<SwapResult> {
    try {
      const { tx, realSwap, estimatedOutputSol } = await this.buildSwapTransactionForMemo(
        agentId,
        direction,
        amountSol
      );
      const result = await this.txEngine.executeTransaction(
        agentId,
        tx,
        realSwap
          ? `Orca swap: ${direction} ${amountSol} SOL`
          : `Simulated Orca swap: ${direction} ${amountSol} SOL equivalent`
      );
      const error =
        result.error ??
        (result.blockedBy
          ? `Blocked by circuit breaker: ${result.blockedBy}`
          : undefined);
      const outputAmount =
        estimatedOutputSol ?? (direction === 'SOL→USDC' ? amountSol * 0.99 : amountSol);
      return {
        success: result.success,
        signature: result.signature,
        inputAmount: amountSol,
        outputAmount,
        simulated: (result.dryRun ?? false) || !realSwap,
        error,
      };
    } catch (err) {
      return {
        success: false,
        inputAmount: amountSol,
        error: String(err),
        simulated: false,
      };
    }
  }

  async getPoolPrice(_pair: string): Promise<number | null> {
    return null;
  }
}
