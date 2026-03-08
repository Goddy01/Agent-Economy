/**
 * PoolAdapter - Simulated DEX counterparty when Orca pool is unavailable.
 *
 * Pool agent holds SOL (and optionally USDC) as the reserve. When a Trader swaps,
 * we build a tx with SOL transfers and optionally USDC SPL transfers. Profits
 * traders make come from the pool reserve. Uses partialSign with both keys.
 */
import { Connection, PublicKey, Transaction, SystemProgram } from '@solana/web3.js';
import { Token, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { KeyVault } from '../vault/KeyVault';

const LAMPORTS_PER_SOL = 1e9;
const USDC_DECIMALS = 6;

export interface PoolSwapResult {
  tx: Transaction;
  realSwap: true;
  estimatedOutputSol: number;
  /** USDC amount (human) transferred in the tx, so dashboard can match Solscan. */
  amountUsdc: number;
}

export interface BuildSimulatedSwapOptions {
  /** When set, swap includes USDC SPL transfers (pool and trader ATAs). */
  usdcMint?: PublicKey | null;
}

/**
 * Build a simulated swap tx: Trader <-> Pool with SOL transfers and optionally USDC SPL.
 * Sell (SOL→USDC): Trader sends amountSol to Pool, Pool sends amountSol*(1-spread) SOL and amountSol*price USDC to trader.
 * Buy (USDC→SOL): Trader sends amountSol*(1+spread) SOL and amountSol*price USDC to Pool, Pool sends amountSol SOL to trader.
 */
export async function buildSimulatedSwap(
  connection: Connection,
  vault: KeyVault,
  traderId: string,
  poolId: string,
  direction: string,
  amountSol: number,
  price: number,
  spread: number,
  options?: BuildSimulatedSwapOptions
): Promise<PoolSwapResult> {
  const traderPubkey = new PublicKey(vault.getAgentPublicKey(traderId));
  const poolPubkey = new PublicKey(vault.getAgentPublicKey(poolId));
  const usdcMint = options?.usdcMint ?? null;

  const { blockhash } = await connection.getLatestBlockhash();
  const tx = new Transaction();

  const isSell = direction === 'SOL→USDC';

  if (isSell) {
    const traderToPool = Math.floor(amountSol * LAMPORTS_PER_SOL);
    const poolToTrader = Math.floor(amountSol * (1 - spread) * LAMPORTS_PER_SOL);
    tx.add(
      SystemProgram.transfer({
        fromPubkey: traderPubkey,
        toPubkey: poolPubkey,
        lamports: traderToPool,
      }),
      SystemProgram.transfer({
        fromPubkey: poolPubkey,
        toPubkey: traderPubkey,
        lamports: poolToTrader,
      })
    );
    if (usdcMint) {
      const poolUsdcAta = await Token.getAssociatedTokenAddress(
        ASSOCIATED_TOKEN_PROGRAM_ID,
        TOKEN_PROGRAM_ID,
        usdcMint,
        poolPubkey
      );
      const traderUsdcAta = await Token.getAssociatedTokenAddress(
        ASSOCIATED_TOKEN_PROGRAM_ID,
        TOKEN_PROGRAM_ID,
        usdcMint,
        traderPubkey
      );
      const usdcAmountRaw = Math.floor(amountSol * price * Math.pow(10, USDC_DECIMALS));
      const traderAtaInfo = await connection.getAccountInfo(traderUsdcAta);
      if (!traderAtaInfo) {
        tx.add(
          Token.createAssociatedTokenAccountInstruction(
            ASSOCIATED_TOKEN_PROGRAM_ID,
            TOKEN_PROGRAM_ID,
            usdcMint,
            traderUsdcAta,
            traderPubkey,
            traderPubkey
          )
        );
      }
      tx.add(
        Token.createTransferInstruction(
          TOKEN_PROGRAM_ID,
          poolUsdcAta,
          traderUsdcAta,
          poolPubkey,
          [],
          usdcAmountRaw
        )
      );
    }
  } else {
    const traderToPool = Math.floor(amountSol * (1 + spread) * LAMPORTS_PER_SOL);
    const poolToTrader = Math.floor(amountSol * LAMPORTS_PER_SOL);
    tx.add(
      SystemProgram.transfer({
        fromPubkey: traderPubkey,
        toPubkey: poolPubkey,
        lamports: traderToPool,
      }),
      SystemProgram.transfer({
        fromPubkey: poolPubkey,
        toPubkey: traderPubkey,
        lamports: poolToTrader,
      })
    );
    if (usdcMint) {
      const poolUsdcAta = await Token.getAssociatedTokenAddress(
        ASSOCIATED_TOKEN_PROGRAM_ID,
        TOKEN_PROGRAM_ID,
        usdcMint,
        poolPubkey
      );
      const traderUsdcAta = await Token.getAssociatedTokenAddress(
        ASSOCIATED_TOKEN_PROGRAM_ID,
        TOKEN_PROGRAM_ID,
        usdcMint,
        traderPubkey
      );
      const usdcAmountRaw = Math.floor(amountSol * price * Math.pow(10, USDC_DECIMALS));
      const traderAtaInfo = await connection.getAccountInfo(traderUsdcAta);
      if (!traderAtaInfo) {
        tx.add(
          Token.createAssociatedTokenAccountInstruction(
            ASSOCIATED_TOKEN_PROGRAM_ID,
            TOKEN_PROGRAM_ID,
            usdcMint,
            traderUsdcAta,
            traderPubkey,
            traderPubkey
          )
        );
      }
      tx.add(
        Token.createTransferInstruction(
          TOKEN_PROGRAM_ID,
          traderUsdcAta,
          poolUsdcAta,
          traderPubkey,
          [],
          usdcAmountRaw
        )
      );
    }
  }

  tx.recentBlockhash = blockhash;
  tx.feePayer = traderPubkey;

  const estimatedOutputSol = isSell ? amountSol * (1 - spread) : amountSol;
  const amountUsdc = usdcMint
    ? Math.floor(amountSol * price * Math.pow(10, USDC_DECIMALS)) / Math.pow(10, USDC_DECIMALS)
    : 0;

  return { tx, realSwap: true, estimatedOutputSol, amountUsdc };
}
