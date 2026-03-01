import {
    Connection,
    PublicKey,
    LAMPORTS_PER_SOL,
    SystemProgram,
    Transaction,
    Keypair,
  } from '@solana/web3.js';
  import {
    getOrCreateAssociatedTokenAccount,
    getAccount,
    TOKEN_PROGRAM_ID,
  } from '@solana/spl-token';
  import { KeyVault } from '../vault/KeyVault';
  import BigNumber from 'bignumber.js';
  
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
     */
    async getSolBalance(agentId: string): Promise<number> {
      const address = new PublicKey(this.vault.getAgentPublicKey(agentId));
      const lamports = await this.connection.getBalance(address);
      return lamports / LAMPORTS_PER_SOL;
    }
  
    /**
     * Get full wallet info including all token balances.
     */
    async getWalletInfo(agentId: string): Promise<WalletInfo> {
      const address = this.vault.getAgentPublicKey(agentId);
      const pubkey = new PublicKey(address);
  
      const solLamports = await this.connection.getBalance(pubkey);
      const solBalance = solLamports / LAMPORTS_PER_SOL;
  
      // Fetch all token accounts
      const tokenAccounts = await this.connection.getParsedTokenAccountsByOwner(
        pubkey,
        { programId: TOKEN_PROGRAM_ID }
      );
  
      const tokenBalances: TokenBalance[] = tokenAccounts.value.map(account => {
        const info = account.account.data.parsed.info;
        return {
          mint: info.mint,
          symbol: 'Unknown', // Enrich from token registry in production
          balance: info.tokenAmount.amount,
          decimals: info.tokenAmount.decimals,
          uiAmount: info.tokenAmount.uiAmount,
        };
      });
  
      const info: WalletInfo = {
        agentId,
        address,
        solBalance,
        tokenBalances,
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