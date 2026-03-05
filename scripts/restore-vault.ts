#!/usr/bin/env ts-node
/**
 * Restore the vault from your 24-word recovery phrase after losing .agent-colony-vault.json.
 * Recreates the vault so the same 3 agent addresses (and any SOL sent to them) are accessible again.
 *
 * Usage: RECOVERY_PHRASE="word1 word2 ... word24" npm run restore-vault
 * Or set RECOVERY_PHRASE in .env (do not commit .env).
 * Requires MASTER_PASSPHRASE in .env (same as when vault was first created).
 */
import * as dotenv from 'dotenv';
import { KeyVault } from '../src/vault/KeyVault';
import { Connection } from '@solana/web3.js';
import { WalletManager } from '../src/wallet/WalletManager';

dotenv.config();

const AGENT_IDS = ['vault', 'accumulator', 'flipper'] as const;

async function main(): Promise<void> {
  const passphrase = (process.env.MASTER_PASSPHRASE ?? '').trim();
  const mnemonic = (process.env.RECOVERY_PHRASE ?? process.env.MNEMONIC ?? '').trim();

  if (!passphrase || passphrase.length < 32) {
    throw new Error('MASTER_PASSPHRASE must be set in .env and at least 32 characters');
  }
  if (!mnemonic) {
    throw new Error(
      'Set RECOVERY_PHRASE (or MNEMONIC) in .env to your 24-word recovery phrase, or run:\n' +
        '  RECOVERY_PHRASE="word1 word2 ... word24" npm run restore-vault'
    );
  }

  const vault = new KeyVault(passphrase);
  await vault.restore(mnemonic);
  console.log('Vault restored from recovery phrase.\n');

  const rpcUrl = process.env.SOLANA_RPC_URL ?? 'https://api.devnet.solana.com';
  const connection = new Connection(rpcUrl, 'confirmed');
  const walletManager = new WalletManager(connection, vault);

  console.log('Agent addresses (same as before — any SOL here is recoverable):\n');
  for (const agentId of AGENT_IDS) {
    const address = await walletManager.createWallet(agentId);
    const balance = await walletManager.getSolBalance(agentId);
    console.log(`  ${agentId.padEnd(12)} ${address}  (${balance.toFixed(4)} SOL)`);
  }
  console.log('\nYou can run npm run start to use the colony again.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
