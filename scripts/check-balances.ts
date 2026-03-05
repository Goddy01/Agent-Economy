#!/usr/bin/env ts-node
/**
 * Print balances for all agent wallets with their role.
 *
 * Uses the agent registry (AGENT_IDS or default) and the existing KeyVault
 * + WalletManager to read balances from the current RPC.
 *
 * Usage:
 *   npm run check-balances
 */
import * as dotenv from 'dotenv';
import { Connection } from '@solana/web3.js';
import { KeyVault } from '../src/vault/KeyVault';
import { WalletManager } from '../src/wallet/WalletManager';
import { getAgentIds, getAgentKind } from '../src/colony/agentRegistry';

dotenv.config();

async function main(): Promise<void> {
  const rpcUrl = process.env.SOLANA_RPC_URL ?? 'https://api.devnet.solana.com';
  const passphrase = (process.env.MASTER_PASSPHRASE ?? '').trim();

  if (!passphrase || passphrase.length < 32) {
    throw new Error('MASTER_PASSPHRASE must be set in .env and at least 32 characters.');
  }

  const connection = new Connection(rpcUrl, 'confirmed');
  const vault = new KeyVault(passphrase);
  const walletManager = new WalletManager(connection, vault);

  const agentIds = getAgentIds();

  console.log('\nAgent wallet balances\n');
  console.log('Role        Agent ID        Address                                   Balance (SOL)');
  console.log('----------- --------------- ---------------------------------------- -------------');

  for (const agentId of agentIds) {
    const role = getAgentKind(agentId);
    let address: string;
    let balance: number;
    try {
      // createWallet is idempotent: returns existing address if already registered
      address = await walletManager.createWallet(agentId);
      balance = await walletManager.getSolBalance(agentId);
    } catch (e) {
      console.error(`Error reading wallet for ${agentId}:`, e instanceof Error ? e.message : e);
      continue;
    }

    const roleLabel = role.padEnd(11);
    const idLabel = agentId.padEnd(15);
    const addrLabel = address.padEnd(40);
    const balLabel = balance.toFixed(4).padStart(11);

    console.log(`${roleLabel} ${idLabel} ${addrLabel} ${balLabel}`);
  }

  console.log('');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

