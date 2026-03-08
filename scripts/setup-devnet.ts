#!/usr/bin/env ts-node
/**
 * Setup devnet: initialize KeyVault (if needed), create agent wallets,
 * print addresses and balances. No automatic airdrop - use https://faucet.solana.com/ if needed.
 *
 * Requires MASTER_PASSPHRASE in .env (32+ chars). Run once before npm run start.
 * Judges: addresses printed here match the dashboard and Solscan.
 */
import * as dotenv from 'dotenv';
import { Connection } from '@solana/web3.js';
import { KeyVault } from '../src/vault/KeyVault';
import { WalletManager } from '../src/wallet/WalletManager';
import { getAgentIds } from '../src/colony/agentRegistry';

dotenv.config();

async function main(): Promise<void> {
  const rpcUrl = process.env.SOLANA_RPC_URL ?? 'https://api.devnet.solana.com';
  const passphrase = (process.env.MASTER_PASSPHRASE ?? '').trim();

  if (!passphrase || passphrase.length < 32) {
    throw new Error('MASTER_PASSPHRASE must be set in .env and at least 32 characters');
  }

  const connection = new Connection(rpcUrl, 'confirmed');
  const vault = new KeyVault(passphrase);
  const walletManager = new WalletManager(connection, vault);

  console.log('Agent Colony devnet setup\n');

  // ── 1. Initialize KeyVault if not already initialized ─────────────
  try {
    const mnemonic = await vault.initialize();
    console.log('SAVE THIS RECOVERY PHRASE - shown once:\n');
    console.log(`  ${mnemonic}\n`);
    console.log('Vault initialized.\n');
  } catch (err) {
    if (String(err).includes('already initialized')) {
      console.log('Vault already initialized\n');
    } else {
      throw err;
    }
  }

  // ── 2. Create wallets for all agents (default 8 for scalability demo) ─
  const agentIds = getAgentIds();
  console.log(`Creating agent wallets (${agentIds.length} agents)...`);
  const addresses: Record<string, string> = {};
  for (const agentId of agentIds) {
    addresses[agentId] = await walletManager.createWallet(agentId);
    console.log(`  ${agentId.padEnd(12)} ${addresses[agentId]}`);
  }
  console.log('');

  // ── 3. Print addresses and balances; prompt for faucet if any have no SOL ─
  console.log('Addresses and balances:\n');
  const needsSol: string[] = [];
  for (const agentId of agentIds) {
    const address = addresses[agentId];
    const balance = await walletManager.getSolBalance(agentId);
    console.log(`  ${agentId.padEnd(12)} ${address}`);
    console.log(`  ${''.padEnd(12)} ${balance.toFixed(4)} SOL\n`);
    if (balance <= 0) {
      needsSol.push(agentId);
    }
  }
  if (needsSol.length > 0) {
    console.log(`Wallets with no SOL: ${needsSol.join(', ')}. Get devnet SOL at https://faucet.solana.com/ (select devnet, paste the addresses above; max 2 requests every 8 hours without signing in).\n`);
  }
  if (agentIds.includes('funder')) {
    console.log('Send SOL to the funder address above; the funder agent will distribute it to other agents when the colony starts.\n');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
