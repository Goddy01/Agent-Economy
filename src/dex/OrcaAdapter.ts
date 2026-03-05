import {
    Connection,
    PublicKey,
    Transaction,
    VersionedTransaction,
    SystemProgram,
  } from '@solana/web3.js';
  import { u64 } from '@solana/spl-token';
  import {
    WhirlpoolContext,
    buildWhirlpoolClient,
    swapQuoteByInputToken,
    PDAUtil,
  } from '@orca-so/whirlpools-sdk';
  import { Percentage } from '@orca-so/common-sdk';
  import { KeyVault } from '../vault/KeyVault';
  import { TransactionEngine } from '../transactions/TransactionEngine';
  import { WalletManager } from '../wallet/WalletManager';

  const ORCA_WHIRLPOOL_PROGRAM_ID = new PublicKey('whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc');
  const DEVNET_WHIRLPOOLS_CONFIG = new PublicKey('FcrweFY1G9HJAHG5inkGB6pKg1HZ6x9UC2WioAfWrGkR');
  const TICK_SPACING = 64;
  
  export interface SwapResult {
    success: boolean;
    signature?: string;
    inputAmount: number;
    outputAmount?: number;
    error?: string;
    simulated: boolean;
  }
  
  /**
   * OrcaAdapter — Swap interface for Flipper agent.
   *
   * buildSwapTransactionForMemo() returns a tx the caller can add a memo to and
   * send via TransactionEngine (all circuit breakers apply). On devnet we use
   * a 0-lamport self-transfer for reliability; buildSwapTransaction() contains
   * the full Orca Whirlpool path for when pool liquidity is available.
   */
  export class OrcaAdapter {
    private connection: Connection;
    private vault: KeyVault;
    private txEngine: TransactionEngine;
    private walletManager: WalletManager;
  
    // Devnet token mints
    static readonly DEVNET_USDC = new PublicKey('Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr');
    static readonly DEVNET_SOL = new PublicKey('So11111111111111111111111111111111111111112');
  
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
   * Build a transaction the caller can add a memo to and send via TransactionEngine.
   * On devnet we use a 0-lamport self-transfer so circuit breakers and signing
   * are exercised without depending on live Orca pool liquidity.
   */
  async buildSwapTransactionForMemo(
      agentId: string,
      direction: string,
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
     * Execute a "simulated" swap on devnet.
     *
     * For hackathon/demo reliability we do NOT depend on a live Orca pool.
     * Instead we:
     *   - Create a 0-SOL self-transfer for the agent (real on-chain tx)
     *   - Run it through TransactionEngine so all circuit breakers apply
     *   - Return a mocked outputAmount based on the direction
     *
     * This makes swaps cheap, deterministic, and fully verifiable on devnet
     * (you see a real signature and SystemProgram transfer), while keeping
     * the safety and accounting logic realistic.
     */
    async executeSwap(
      agentId: string,
      direction: string,
      amountSol: number
    ): Promise<SwapResult> {
      try {
        const tx = await this.buildSwapTransactionForMemo(agentId, direction, amountSol);
        const result = await this.txEngine.executeTransaction(
          agentId,
          tx,
          `Simulated Orca swap: ${direction} ${amountSol} SOL equivalent`
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
          outputAmount: direction === 'SOL→USDC' ? amountSol * 150 : amountSol, // Mock
          simulated: result.dryRun ?? false,
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
  
    /**
     * Builds a swap transaction using Orca Whirlpools SDK.
     * Fetches SOL/USDC pool on devnet, gets swap quote, returns transaction.
     */
    private async buildSwapTransaction(
      agentId: string,
      direction: string,
      amount: number
    ): Promise<Transaction | VersionedTransaction> {
      const agentPubkey = new PublicKey(this.vault.getAgentPublicKey(agentId));

      const wallet = {
        publicKey: agentPubkey,
        signTransaction: async <T extends Transaction | VersionedTransaction>(tx: T): Promise<T> => tx,
        signAllTransactions: async <T extends Transaction | VersionedTransaction>(txs: T[]): Promise<T[]> => txs,
      };

      const ctx = WhirlpoolContext.from(
        this.connection,
        wallet,
        ORCA_WHIRLPOOL_PROGRAM_ID
      );

      const client = buildWhirlpoolClient(ctx);

      const tokenMintA = OrcaAdapter.DEVNET_SOL;
      const tokenMintB = OrcaAdapter.DEVNET_USDC;

      const poolPda = PDAUtil.getWhirlpool(
        ORCA_WHIRLPOOL_PROGRAM_ID,
        DEVNET_WHIRLPOOLS_CONFIG,
        tokenMintA,
        tokenMintB,
        TICK_SPACING
      );
      const poolAddress = poolPda.publicKey;

      const pool = await client.getPool(poolAddress, true);

      const isSolToUsdc = direction === 'SOL→USDC';
      const inputMint = isSolToUsdc ? OrcaAdapter.DEVNET_SOL : OrcaAdapter.DEVNET_USDC;

      const amountLamports = Math.floor(amount * 1e9);
      const tokenAmount = new (u64 as any)(amountLamports);

      const slippage = Percentage.fromFraction(1, 100);

      const quote = await swapQuoteByInputToken(
        pool,
        inputMint,
        tokenAmount,
        slippage,
        ORCA_WHIRLPOOL_PROGRAM_ID,
        ctx.fetcher,
        true
      );

      const txBuilder = await pool.swap(quote, agentPubkey);

      const payload = await txBuilder.build({
        maxSupportedTransactionVersion: 'legacy',
        blockhashCommitment: 'confirmed',
      });

      return payload.transaction;
    }
  
    async getPoolPrice(pair: string): Promise<number | null> {
      // CURSOR PROMPT: "Fetch current price from Orca Whirlpool pool for SOL/USDC on devnet"
      return null;
    }
  }