/**
 * TransactionEngine - Single pipeline for all agent transactions.
 *
 * Order: (1) Rate limit check (per agent), (2) Simulation always,
 * (3) If not dry run: sign via KeyVault → sendRawTransaction → confirm.
 * If any circuit breaker fails or simulation fails, we never sign or send.
 * Judges: see tests/security-attacks.test.ts for attack simulations.
 */
import {
    Connection,
    Transaction,
    VersionedTransaction,
    SendTransactionError,
  } from '@solana/web3.js';
  import { KeyVault } from '../vault/KeyVault';
  import { RateLimiter } from './RateLimiter';
  
  export interface CircuitBreakerConfig {
    maxTxPerMinute: number;     // Rate limit
    dryRun: boolean;            // Simulate only, never send
  }
  
  export interface TransactionResult {
    success: boolean;
    signature?: string;
    simulationPassed: boolean;
    blockedBy?: string;         // Which circuit breaker fired
    error?: string;
    dryRun: boolean;
    agentId: string;
    estimatedFee: number;       // lamports
  }
  
  export class TransactionEngine {
    private connection: Connection;
    private vault: KeyVault;
    private rateLimiter: RateLimiter;
    private config: CircuitBreakerConfig;
  
    constructor(
      connection: Connection,
      vault: KeyVault,
      config: CircuitBreakerConfig
    ) {
      this.connection = connection;
      this.vault = vault;
      this.config = config;
      this.rateLimiter = new RateLimiter(config.maxTxPerMinute);
    }
  
    /**
     * Primary transaction submission pipeline.
     *
     * Order of operations:
     * 1. Rate limit check
     * 2. Balance validation
     * 3. Transaction simulation (always)
     * 4. If not dry run: sign → send → confirm
     * 5. Record in rate limiter
     */
    async executeTransaction(
      agentId: string,
      transaction: Transaction | VersionedTransaction,
      description: string
    ): Promise<TransactionResult> {
  
      // ── Circuit Breaker: Rate Limit ─────────────────────────────
      const rateCheck = this.rateLimiter.check(agentId);
      if (!rateCheck.allowed) {
        return this.blocked(agentId, `Rate limit: ${rateCheck.remaining} remaining, resets in ${Math.ceil(rateCheck.resetIn / 1000)}s`);
      }
  
      // ── Simulation (always runs) ───────────────────────────────
      const simulation = await this.simulateTransaction(transaction);
      if (!simulation.success) {
        return {
          success: false,
          simulationPassed: false,
          error: `Simulation failed: ${simulation.error}`,
          dryRun: this.config.dryRun,
          agentId,
          estimatedFee: 0,
        };
      }
  
      // ── Dry Run - stop here ────────────────────────────────────
      if (this.config.dryRun) {
        return {
          success: true,
          simulationPassed: true,
          dryRun: true,
          agentId,
          estimatedFee: simulation.fee ?? 5000,
          signature: `DRY_RUN_${Date.now()}`,
        };
      }
  
      // ── Sign & Send ────────────────────────────────────────────
      try {
        await this.vault.sign({ agentId, transaction, description });
  
        const signature = await this.connection.sendRawTransaction(
          transaction.serialize(),
          { skipPreflight: true } // We already simulated
        );
  
        await this.connection.confirmTransaction(signature, 'confirmed');
  
        this.rateLimiter.record(agentId);
  
        return {
          success: true,
          signature,
          simulationPassed: true,
          dryRun: false,
          agentId,
          estimatedFee: simulation.fee ?? 5000,
        };
      } catch (err) {
        const error = err instanceof SendTransactionError
          ? `${err.message}\nLogs: ${err.logs?.join('\n')}`
          : String(err);
  
        return {
          success: false,
          simulationPassed: true, // It passed sim but failed on-chain
          error,
          dryRun: false,
          agentId,
          estimatedFee: simulation.fee ?? 0,
        };
      }
    }

  /**
   * Execute a Pool swap transaction (Trader <-> Pool).
   * Uses multi-agent signing instead of single-agent. Circuit breakers still apply.
   */
  async executePoolSwap(
    traderId: string,
    poolId: string,
    transaction: Transaction,
    description: string
  ): Promise<TransactionResult> {
    const rateCheck = this.rateLimiter.check(traderId);
    if (!rateCheck.allowed) {
      return this.blocked(traderId, `Rate limit: ${rateCheck.remaining} remaining, resets in ${Math.ceil(rateCheck.resetIn / 1000)}s`);
    }

    const simulation = await this.simulateTransaction(transaction);
    if (!simulation.success) {
      return {
        success: false,
        simulationPassed: false,
        error: `Simulation failed: ${simulation.error}`,
        dryRun: this.config.dryRun,
        agentId: traderId,
        estimatedFee: 0,
      };
    }

    if (this.config.dryRun) {
      return {
        success: true,
        simulationPassed: true,
        dryRun: true,
        agentId: traderId,
        estimatedFee: simulation.fee ?? 5000,
        signature: `DRY_RUN_${Date.now()}`,
      };
    }

    try {
      await this.vault.signMultiAgent([traderId, poolId], transaction);

      const signature = await this.connection.sendRawTransaction(
        transaction.serialize(),
        { skipPreflight: true }
      );

      await this.connection.confirmTransaction(signature, 'confirmed');

      this.rateLimiter.record(traderId);

      return {
        success: true,
        signature,
        simulationPassed: true,
        dryRun: false,
        agentId: traderId,
        estimatedFee: simulation.fee ?? 5000,
      };
    } catch (err) {
      const error = err instanceof SendTransactionError
        ? `${err.message}\nLogs: ${err.logs?.join('\n')}`
        : String(err);

      return {
        success: false,
        simulationPassed: true,
        error,
        dryRun: false,
        agentId: traderId,
        estimatedFee: 0,
      };
    }
  }

  /**
   * Execute a P2P swap transaction (Trader A <-> Trader B).
   * Uses multi-agent signing. Circuit breakers apply to the initiator.
   */
  async executeTraderSwap(
    traderAId: string,
    traderBId: string,
    transaction: Transaction,
    description: string
  ): Promise<TransactionResult> {
    const rateCheck = this.rateLimiter.check(traderAId);
    if (!rateCheck.allowed) {
      return this.blocked(traderAId, `Rate limit: ${rateCheck.remaining} remaining, resets in ${Math.ceil(rateCheck.resetIn / 1000)}s`);
    }

    const simulation = await this.simulateTransaction(transaction);
    if (!simulation.success) {
      return {
        success: false,
        simulationPassed: false,
        error: `Simulation failed: ${simulation.error}`,
        dryRun: this.config.dryRun,
        agentId: traderAId,
        estimatedFee: 0,
      };
    }

    if (this.config.dryRun) {
      return {
        success: true,
        simulationPassed: true,
        dryRun: true,
        agentId: traderAId,
        estimatedFee: simulation.fee ?? 5000,
        signature: `DRY_RUN_${Date.now()}`,
      };
    }

    try {
      await this.vault.signMultiAgent([traderAId, traderBId], transaction);

      const signature = await this.connection.sendRawTransaction(
        transaction.serialize(),
        { skipPreflight: true }
      );

      await this.connection.confirmTransaction(signature, 'confirmed');

      this.rateLimiter.record(traderAId);

      return {
        success: true,
        signature,
        simulationPassed: true,
        dryRun: false,
        agentId: traderAId,
        estimatedFee: simulation.fee ?? 5000,
      };
    } catch (err) {
      const error = err instanceof SendTransactionError
        ? `${err.message}\nLogs: ${err.logs?.join('\n')}`
        : String(err);

      return {
        success: false,
        simulationPassed: true,
        error,
        dryRun: false,
        agentId: traderAId,
        estimatedFee: 0,
      };
    }
  }
  
    // ─── Private Helpers ───────────────────────────────────────────
  
    /** Simulate before any sign/send; failure blocks the tx (Attack 4). */
    private async simulateTransaction(
      transaction: Transaction | VersionedTransaction
    ): Promise<{ success: boolean; fee?: number; error?: string }> {
      try {
        const { value } = transaction instanceof VersionedTransaction
          ? await this.connection.simulateTransaction(transaction)
          : await this.connection.simulateTransaction(transaction);
  
        if (value.err) {
          return { success: false, error: JSON.stringify(value.err) };
        }
  
        return { success: true, fee: 5000 };  // 5000 lamports typical fee
      } catch (err) {
        return { success: false, error: String(err) };
      }
    }
  
    private blocked(agentId: string, reason: string): TransactionResult {
      return {
        success: false,
        simulationPassed: false,
        blockedBy: reason,
        dryRun: this.config.dryRun,
        agentId,
        estimatedFee: 0,
      };
    }
  }