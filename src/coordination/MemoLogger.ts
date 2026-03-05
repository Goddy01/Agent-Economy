/**
 * MemoLogger — On-chain audit trail for agent decisions.
 *
 * Writes agent decisions to Solana Memo program so every action is verifiable
 * on-chain. addMemoInstruction() attaches a memo to an existing tx (e.g.
 * transfer + memo in one). log() sends a standalone memo tx. Retries and
 * confirmation timeout handling for devnet reliability.
 */
import {
    Connection,
    PublicKey,
    Transaction,
    TransactionInstruction,
    LAMPORTS_PER_SOL,
  } from '@solana/web3.js';
  import { KeyVault } from '../vault/KeyVault';
  import { AgentDecision } from '../agents/types';
  
  const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');

  const MAX_MEMO_RETRIES = 3;
  const RETRY_DELAY_MS = 1500;
  const CONFIRM_POLL_MS = 3000;
  const CONFIRM_POLL_ATTEMPTS = 10;

  function isRetryableRpcError(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    const full = err instanceof Error && (err as unknown as { cause?: unknown }).cause != null
      ? msg + String((err as unknown as { cause: unknown }).cause)
      : msg;
    return /ECONNRESET|fetch failed|ETIMEDOUT|ECONNREFUSED|socket hang up/i.test(full);
  }

  function isConfirmTimeoutError(err: unknown): err is Error & { signature?: string } {
    if (!(err instanceof Error)) return false;
    const name = (err as Error & { name?: string }).name;
    const sig = (err as Error & { signature?: string }).signature;
    return (name === 'TransactionExpiredTimeoutError' || /Transaction was not confirmed/i.test(err.message)) && typeof sig === 'string';
  }

  async function pollConfirmation(connection: Connection, signature: string): Promise<boolean> {
    for (let i = 0; i < CONFIRM_POLL_ATTEMPTS; i++) {
      await new Promise(r => setTimeout(r, CONFIRM_POLL_MS));
      const status = await connection.getSignatureStatus(signature);
      const conf = status?.value?.confirmationStatus;
      if (conf === 'confirmed' || conf === 'finalized') return true;
    }
    return false;
  }

  async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= MAX_MEMO_RETRIES; attempt++) {
      try {
        return await fn();
      } catch (e) {
        lastErr = e;
        if (attempt < MAX_MEMO_RETRIES && isRetryableRpcError(e)) {
          await new Promise(r => setTimeout(r, RETRY_DELAY_MS * attempt));
          continue;
        }
        throw lastErr;
      }
    }
    throw lastErr;
  }
  
  export interface MemoEntry {
    agentId: string;
    decision: AgentDecision;
    signature: string;
    timestamp: number;
  }
  
  export class MemoLogger {
    private connection: Connection;
    private vault: KeyVault;
    private logs: MemoEntry[] = [];
    private sessionId?: string;
  
    constructor(connection: Connection, vault: KeyVault) {
      this.connection = connection;
      this.vault = vault;
    }

    setSessionId(sessionId: string): void {
      this.sessionId = sessionId;
    }

    /**
     * Add a memo instruction to an existing transaction (e.g. transfer to vault).
     * Use this to combine memo and transfer in a single on-chain transaction.
     */
    addMemoInstruction(tx: Transaction, agentId: string, decision: AgentDecision): void {
      const memoData = JSON.stringify({
        agent: agentId,
        type: decision.type,
        reason: decision.reason.substring(0, 100),
        confidence: decision.confidence,
        ts: decision.timestamp,
        sessionId: this.sessionId,
      });
      const agentPubkey = new PublicKey(this.vault.getAgentPublicKey(agentId));
      tx.add(new TransactionInstruction({
        keys: [{ pubkey: agentPubkey, isSigner: true, isWritable: false }],
        programId: MEMO_PROGRAM_ID,
        data: Buffer.from(memoData, 'utf-8'),
      }));
    }

    /**
     * Record a memo that was included in another transaction (e.g. transfer+memo).
     * Call this after a combined tx confirms so getLogs() includes it.
     */
    recordMemo(agentId: string, decision: AgentDecision, signature: string): void {
      this.logs.push({ agentId, decision, signature, timestamp: Date.now() });
    }
  
    /**
     * Write an agent decision as an on-chain memo.
     * This creates a permanent, verifiable record of every agent action.
     */
    async log(agentId: string, decision: AgentDecision): Promise<string | null> {
      if (process.env.DRY_RUN === 'true') return null;
  
      try {
        const memoData = JSON.stringify({
          agent: agentId,
          type: decision.type,
          reason: decision.reason.substring(0, 100), // Keep memo short
          confidence: decision.confidence,
          ts: decision.timestamp,
          sessionId: this.sessionId,
        });
  
        const agentPubkey = new PublicKey(this.vault.getAgentPublicKey(agentId));

        let signature: string;
        try {
          signature = await withRetry(async () => {
            const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash('confirmed');
            const tx = new Transaction();
            tx.recentBlockhash = blockhash;
            tx.feePayer = agentPubkey;
            tx.add(new TransactionInstruction({
              keys: [{ pubkey: agentPubkey, isSigner: true, isWritable: false }],
              programId: MEMO_PROGRAM_ID,
              data: Buffer.from(memoData, 'utf-8'),
            }));
            await this.vault.sign({ agentId, transaction: tx, description: 'Decision memo' });
            const sig = await this.connection.sendRawTransaction(tx.serialize());
            await this.connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
            return sig;
          });
        } catch (confirmErr: unknown) {
          // Timeout doesn't mean the tx failed — poll once more and use signature if it landed
          if (isConfirmTimeoutError(confirmErr)) {
            const sig = (confirmErr as Error & { signature: string }).signature;
            const landed = await pollConfirmation(this.connection, sig);
            if (landed) {
              signature = sig;
              console.warn(`Memo for ${agentId}: confirmation timed out but tx landed (${sig.slice(0, 8)}…)`);
            } else {
              console.warn(`Memo log failed for ${agentId}:`, confirmErr);
              return null;
            }
          } else {
            throw confirmErr;
          }
        }

        this.logs.push({ agentId, decision, signature, timestamp: Date.now() });
        return signature;
      } catch (err) {
        // Memo logging failure is non-critical — log but don't throw
        console.warn(`Memo log failed for ${agentId}:`, err);
        return null;
      }
    }
  
    getLogs(agentId?: string): MemoEntry[] {
      if (agentId) return this.logs.filter(l => l.agentId === agentId);
      return [...this.logs];
    }
  
    getExplorerUrl(signature: string): string {
      return `https://solscan.io/tx/${signature}?cluster=devnet`;
    }
  }