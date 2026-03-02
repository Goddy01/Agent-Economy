import {
    Connection,
    PublicKey,
    Transaction,
    TransactionInstruction,
    LAMPORTS_PER_SOL,
  } from '@solana/web3.js';
  import { KeyVault } from '../vault/KeyVault';
  import { AgentDecision } from '../agents/types';
  
  // Solana Memo Program
  const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
  
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
  
    constructor(connection: Connection, vault: KeyVault) {
      this.connection = connection;
      this.vault = vault;
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
        });
  
        const agentPubkey = new PublicKey(this.vault.getAgentPublicKey(agentId));
        const { blockhash } = await this.connection.getLatestBlockhash();
  
        const tx = new Transaction();
        tx.recentBlockhash = blockhash;
        tx.feePayer = agentPubkey;
  
        tx.add(new TransactionInstruction({
          keys: [{ pubkey: agentPubkey, isSigner: true, isWritable: false }],
          programId: MEMO_PROGRAM_ID,
          data: Buffer.from(memoData, 'utf-8'),
        }));
  
        await this.vault.sign({ agentId, transaction: tx, description: 'Decision memo' });
  
        const signature = await this.connection.sendRawTransaction(tx.serialize());
        await this.connection.confirmTransaction(signature, 'confirmed');
  
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
      return `https://explorer.solana.com/tx/${signature}?cluster=devnet`;
    }
  }