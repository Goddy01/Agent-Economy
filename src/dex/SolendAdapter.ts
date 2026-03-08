import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
} from '@solana/web3.js';
import { KeyVault } from '../vault/KeyVault';
import { TransactionEngine } from '../transactions/TransactionEngine';
import { WalletManager } from '../wallet/WalletManager';

export interface DepositResult {
  success: boolean;
  signature?: string;
  inputAmount: number;
  simulated: boolean;
  error?: string;
  blockedBy?: string;
}

/**
 * SolendAdapter - Lending-style interface for Flipper / yield strategies.
 *
 * For the hackathon/devnet demo we follow the same pattern as OrcaAdapter:
 * we exercise the full safety pipeline (TransactionEngine + circuit breakers)
 * using a 0-lamport self-transfer, and annotate it as a "Solend deposit"
 * in the description and dashboard. This keeps on-chain actions cheap and
 * deterministic while still proving multi-protocol wiring.
 *
 * In a production setup this class would construct real Solend deposit /
 * withdraw instructions against the Solend program id.
 */
export class SolendAdapter {
  private connection: Connection;
  private vault: KeyVault;
  private txEngine: TransactionEngine;
  private walletManager: WalletManager;

  // Mainnet Solend program id for documentation / future real integration.
  // For the demo we do not send transactions to this program, but we keep it
  // here to clearly document the target protocol.
  static readonly SOLEND_PROGRAM_ID = new PublicKey(
    'So1endDq2YkqhipRh3WViPa8hdiSpxWy6z3Z6tMCpAo'
  );

  constructor(
    connection: Connection,
    vault: KeyVault,
    txEngine: TransactionEngine,
    walletManager: WalletManager
  ) {
    this.connection = connection;
    this.vault = vault;
    this.txEngine = txEngine;
    this.walletManager = walletManager;
  }

  /**
   * Build a transaction that can carry a memo and be sent via TransactionEngine.
   *
   * Mirrors OrcaAdapter.buildSwapTransactionForMemo: 0-lamport self-transfer
   * so that circuit breakers, rate limiting, and dry-run behaviour are all
   * exercised without depending on live Solend markets or liquidity.
   */
  async buildDepositTransactionForMemo(
    agentId: string,
    amountSol: number
  ): Promise<Transaction> {
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
    return tx;
  }

  /**
   * Execute a "simulated" Solend deposit on devnet.
   *
   * Behaviour:
   *   - Builds a 0-SOL self-transfer for the agent (real on-chain tx)
   *   - Runs it through TransactionEngine so all circuit breakers apply
   *   - Describes the operation as a Solend deposit in the dashboard / logs
   *
   * This demonstrates multi-protocol integration without taking protocol
   * risk on devnet, matching the pattern used for Orca swaps.
   */
  async executeDeposit(agentId: string, amountSol: number): Promise<DepositResult> {
    try {
      const tx = await this.buildDepositTransactionForMemo(agentId, amountSol);
      const result = await this.txEngine.executeTransaction(
        agentId,
        tx,
        `Simulated Solend deposit: ${amountSol.toFixed(4)} SOL`
      );

      const error =
        result.error ??
        (result.blockedBy
          ? `Blocked by circuit breaker: ${result.blockedBy}`
          : undefined);

      return {
        success: result.success,
        signature: result.signature,
        inputAmount: amountSol,
        simulated: result.dryRun ?? false,
        error,
        blockedBy: result.blockedBy,
      };
    } catch (err) {
      return {
        success: false,
        inputAmount: amountSol,
        simulated: false,
        error: String(err),
      };
    }
  }
}

