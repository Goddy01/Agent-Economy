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
import { Connection, PublicKey } from '@solana/web3.js';
import { KeyVault } from '../src/vault/KeyVault';
import { WalletManager } from '../src/wallet/WalletManager';
import { getAgentIds, getAgentKind } from '../src/colony/agentRegistry';

dotenv.config();

async function main(): Promise<void> {
  const rpcUrl = process.env.SOLANA_RPC_URL ?? 'https://api.devnet.solana.com';
  const passphrase = (process.env.MASTER_PASSPHRASE ?? '').trim();
  const usdcMintRaw = (process.env.USDC_MINT ?? '').trim();
  const hasUsdc = usdcMintRaw.length > 0;

  if (!passphrase || passphrase.length < 32) {
    throw new Error('MASTER_PASSPHRASE must be set in .env and at least 32 characters.');
  }

  const connection = new Connection(rpcUrl, 'confirmed');
  const vault = new KeyVault(passphrase);
  const walletManager = new WalletManager(connection, vault);
  const usdcMint = hasUsdc ? new PublicKey(usdcMintRaw) : null;

  const agentIds = getAgentIds();

  const solHeader = 'Balance (SOL)';
  const usdcHeader = 'USDC';
  const headerLine = hasUsdc
    ? `Role        Agent ID        Address                                   ${solHeader}  ${usdcHeader}`
    : `Role        Agent ID        Address                                   ${solHeader}`;
  const sepLine = hasUsdc
    ? '----------- --------------- ---------------------------------------- ------------- ---------------'
    : '----------- --------------- ---------------------------------------- -------------';

  console.log('\nAgent wallet balances\n');
  console.log(headerLine);
  console.log(sepLine);

  for (const agentId of agentIds) {
    const role = getAgentKind(agentId);
    let address: string;
    let balance: number;
    let usdcBalance: number = 0;
    try {
      address = await walletManager.createWallet(agentId);
      balance = await walletManager.getSolBalance(agentId);
      if (usdcMint) {
        usdcBalance = await walletManager.getTokenBalance(agentId, usdcMint);
      }
    } catch (e) {
      console.error(`Error reading wallet for ${agentId}:`, e instanceof Error ? e.message : e);
      continue;
    }

    const roleLabel = role.padEnd(11);
    const idLabel = agentId.padEnd(15);
    const addrLabel = address.padEnd(40);
    const solLabel = balance.toFixed(4).padStart(11);
    const row = hasUsdc
      ? `${roleLabel} ${idLabel} ${addrLabel} ${solLabel}  ${usdcBalance.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).padStart(14)}`
      : `${roleLabel} ${idLabel} ${addrLabel} ${solLabel}`;

    console.log(row);
  }

  console.log('');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

