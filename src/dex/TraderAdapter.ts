/**
 * TraderAdapter - P2P swap builder for Trader <-> Trader.
 *
 * When two traders have opposite intents (one buy, one sell), we build a tx
 * with two SystemProgram transfers to simulate the swap. Both traders sign.
 */
import { Connection, PublicKey, Transaction, SystemProgram } from '@solana/web3.js';
import { KeyVault } from '../vault/KeyVault';

const LAMPORTS_PER_SOL = 1e9;

export interface P2PSwapResult {
  tx: Transaction;
  estimatedOutputSol: number;
}

/**
 * Build a P2P swap tx: Trader A <-> Trader B with two SOL transfers.
 * direction is from the initiator's perspective (the trader who found the match).
 * Sell (SOL→USDC): Initiator sends amountSol to peer, peer sends amountSol*(1-spread) back.
 * Buy (USDC→SOL): Initiator sends amountSol*(1+spread) to peer, peer sends amountSol back.
 */
export async function buildP2PSwap(
  connection: Connection,
  vault: KeyVault,
  initiatorId: string,
  peerId: string,
  direction: string,
  amountSol: number,
  spread: number
): Promise<P2PSwapResult> {
  const initiatorPubkey = new PublicKey(vault.getAgentPublicKey(initiatorId));
  const peerPubkey = new PublicKey(vault.getAgentPublicKey(peerId));

  const { blockhash } = await connection.getLatestBlockhash();
  const tx = new Transaction();

  const isSell = direction === 'SOL→USDC';

  if (isSell) {
    const initiatorToPeer = Math.floor(amountSol * LAMPORTS_PER_SOL);
    const peerToInitiator = Math.floor(amountSol * (1 - spread) * LAMPORTS_PER_SOL);
    tx.add(
      SystemProgram.transfer({
        fromPubkey: initiatorPubkey,
        toPubkey: peerPubkey,
        lamports: initiatorToPeer,
      }),
      SystemProgram.transfer({
        fromPubkey: peerPubkey,
        toPubkey: initiatorPubkey,
        lamports: peerToInitiator,
      })
    );
  } else {
    const initiatorToPeer = Math.floor(amountSol * (1 + spread) * LAMPORTS_PER_SOL);
    const peerToInitiator = Math.floor(amountSol * LAMPORTS_PER_SOL);
    tx.add(
      SystemProgram.transfer({
        fromPubkey: initiatorPubkey,
        toPubkey: peerPubkey,
        lamports: initiatorToPeer,
      }),
      SystemProgram.transfer({
        fromPubkey: peerPubkey,
        toPubkey: initiatorPubkey,
        lamports: peerToInitiator,
      })
    );
  }

  tx.recentBlockhash = blockhash;
  tx.feePayer = initiatorPubkey;

  const estimatedOutputSol = isSell ? amountSol * (1 - spread) : amountSol;

  return { tx, estimatedOutputSol };
}
