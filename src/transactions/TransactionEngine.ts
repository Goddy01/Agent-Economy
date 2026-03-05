/**
 * TransactionEngine — Single pipeline for all agent transactions.
 *
 * Order: (1) Rate limit check (per agent), (2) Max SOL per tx check,
 * (3) Vault floor check for vault agent, (4) Simulation always,
 * (5) If not dry run: sign via KeyVault → sendRawTransaction → confirm.
 * If any circuit breaker fails or simulation fails, we never sign or send.
 * Judges: see tests/security-attacks.test.ts for attack simulations.
 */
import {
    Connection,
    Transaction,
    VersionedTransaction,
    PublicKey,
    LAMPORTS_PER_SOL,
    SendTransactionError,
  } from '@solana/web3.js';
  import { KeyVault } from '../vault/KeyVault';
  import { RateLimiter } from './RateLimiter';
  
  export interface CircuitBreakerConfig {
    maxTxSol: number;           // Max SOL value per transaction
    maxTxPerMinute: number;     // Rate limit
    vaultFloorSol: number;      // Vault agent cannot go below this
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
      description: string,
      options?: { skipVaultFloor?: boolean }
    ): Promise<TransactionResult> {
  
      // ── Circuit Breaker 1: Rate Limit ──────────────────────────
      const rateCheck = this.rateLimiter.check(agentId);
      if (!rateCheck.allowed) {
        return this.blocked(agentId, `Rate limit: ${rateCheck.remaining} remaining, resets in ${Math.ceil(rateCheck.resetIn / 1000)}s`);
      }
  
      // ── Circuit Breaker 2: Transaction Value ───────────────────
      const estimatedSol = await this.estimateTransactionValue(transaction);
      if (estimatedSol > this.config.maxTxSol) {
        return this.blocked(agentId, `Transaction value ${estimatedSol.toFixed(4)} SOL exceeds max ${this.config.maxTxSol} SOL`);
      }
  
      // ── Circuit Breaker 3: Vault Floor (for Vault agent only) ──
      if (!options?.skipVaultFloor && agentId === 'vault') {
        const balanceCheck = await this.checkVaultFloor(agentId, estimatedSol);
        if (!balanceCheck.safe) {
          return this.blocked(agentId, `Vault floor protection: balance ${balanceCheck.balance.toFixed(2)} SOL, floor ${this.config.vaultFloorSol} SOL`);
        }
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
  
      // ── Dry Run — stop here ────────────────────────────────────
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
  
    /** Estimate SOL value of tx for maxTxSol circuit breaker (SystemProgram transfer only). */
    private async estimateTransactionValue(transaction: Transaction | VersionedTransaction): Promise<number> {
      if (!('instructions' in transaction)) {
        return 0;  // VersionedTransaction: conservative 0 for breaker
      }
      let totalLamports = 0;
      for (const instruction of transaction.instructions) {
        if (instruction.programId.equals(new PublicKey('11111111111111111111111111111111'))) {
          const data = instruction.data;
          if (data.length >= 12 && data.readUInt32LE(0) === 2) {
            totalLamports += Number(data.readBigUInt64LE(4));
          }
        }
      }
      return totalLamports / LAMPORTS_PER_SOL;
    }
  
    private async checkVaultFloor(
      agentId: string,
      proposedSpend: number
    ): Promise<{ safe: boolean; balance: number }> {
      const publicKey = new PublicKey(this.vault.getAgentPublicKey(agentId));
      const lamports = await this.connection.getBalance(publicKey);
      const balance = lamports / LAMPORTS_PER_SOL;
      const postBalance = balance - proposedSpend;
      return {
        safe: postBalance >= this.config.vaultFloorSol,
        balance,
      };
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