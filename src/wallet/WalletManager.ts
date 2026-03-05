/**
 * WalletManager — Agent wallet operations (no private keys here).
 *
 * createWallet() registers agent in KeyVault and returns address.
 * getSolBalance / getWalletInfo read from chain (with retry for devnet).
 * buildTransferTransaction() builds SystemProgram.transfer for vault
 * contributions. All signing is done inside KeyVault via TransactionEngine.
 */
import {
    Connection,
    PublicKey,
    LAMPORTS_PER_SOL,
    SystemProgram,
    Transaction,
    Keypair,
  } from '@solana/web3.js';
  import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
  import { KeyVault } from '../vault/KeyVault';
  
  export interface WalletInfo {
    agentId: string;
    address: string;
    solBalance: number;
    tokenBalances: TokenBalance[];
    lastUpdated: number;
  }
  
  export interface TokenBalance {
    mint: string;
    symbol: string;
    balance: number;
    decimals: number;
    uiAmount: number;
  }
  
  export class WalletManager {
    private connection: Connection;
    private vault: KeyVault;
    private walletCache: Map<string, WalletInfo> = new Map();
  
    constructor(connection: Connection, vault: KeyVault) {
      this.connection = connection;
      this.vault = vault;
    }
  
    /**
     * Register an agent in the vault and return its address.
     * Safe to call multiple times — returns existing address if already registered.
     */
    async createWallet(agentId: string): Promise<string> {
      return await this.vault.registerAgent(agentId);
    }
  
    /**
     * Get current SOL balance in SOL (not lamports).
     * On RPC failure (e.g. devnet rate limit), retries once then returns 0 so agents can continue.
     */
    async getSolBalance(agentId: string): Promise<number> {
      const address = new PublicKey(this.vault.getAgentPublicKey(agentId));
      const lamports = await this.getBalanceWithRetry(address);
      return lamports / LAMPORTS_PER_SOL;
    }

    private async getBalanceWithRetry(pubkey: PublicKey, retries = 4): Promise<number> {
      let lastErr: unknown;
      for (let i = 0; i < retries; i++) {
        try {
          return await this.connection.getBalance(pubkey);
        } catch (e) {
          lastErr = e;
          if (i < retries - 1) {
            await new Promise((r) => setTimeout(r, 800 * (i + 1)));
          }
        }
      }
      console.warn(
        'getBalance failed for',
        pubkey.toBase58(),
        '- treating as 0. Common on devnet under rate limit.',
        lastErr instanceof Error ? lastErr.message : lastErr
      );
      return 0;
    }
  
  /**
     * Get full wallet info.
     *
     * NOTE: For this project we only care about SOL balances. To avoid
     * hammering public devnet RPC with getParsedTokenAccountsByOwner
     * (which is heavily rate-limited and noisy), we skip token lookups
     * entirely and always return an empty token list.
     */
    async getWalletInfo(agentId: string): Promise<WalletInfo> {
      const address = this.vault.getAgentPublicKey(agentId);
      const pubkey = new PublicKey(address);

      const solLamports = await this.getBalanceWithRetry(pubkey);
      const solBalance = solLamports / LAMPORTS_PER_SOL;

      const info: WalletInfo = {
        agentId,
        address,
        solBalance,
        tokenBalances: [],
        lastUpdated: Date.now(),
      };

      this.walletCache.set(agentId, info);
      return info;
    }
  
    /**
     * Request airdrop for devnet testing.
     * Max 2 SOL per request on devnet.
     */
    async requestAirdrop(agentId: string, solAmount: number = 2): Promise<string> {
      const address = new PublicKey(this.vault.getAgentPublicKey(agentId));
      const lamports = Math.min(solAmount, 2) * LAMPORTS_PER_SOL; // Devnet cap
  
      const signature = await this.connection.requestAirdrop(address, lamports);
      await this.connection.confirmTransaction(signature, 'confirmed');
  
      return signature;
    }
  
    /**
     * Transfer SOL between agents.
     * Used for Vault treasury contributions.
     */
    async buildTransferTransaction(
      fromAgentId: string,
      toAddress: string,
      solAmount: number
    ): Promise<Transaction> {
      const fromAddress = new PublicKey(this.vault.getAgentPublicKey(fromAgentId));
      const toPublicKey = new PublicKey(toAddress);
      const lamports = Math.floor(solAmount * LAMPORTS_PER_SOL);
  
      const { blockhash } = await this.connection.getLatestBlockhash();
      const tx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: fromAddress,
          toPubkey: toPublicKey,
          lamports,
        })
      );
      tx.recentBlockhash = blockhash;
      tx.feePayer = fromAddress;
  
      return tx;
    }
  
    getCachedInfo(agentId: string): WalletInfo | undefined {
      return this.walletCache.get(agentId);
    }
  }