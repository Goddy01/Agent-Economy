#!/usr/bin/env ts-node
/**
 * Sweep SOL from all agent wallets into the funder wallet, leaving
 * a fixed balance (2.2 SOL by default) in the vault.
 *
 * - Uses the same vault + wallet manager as the main colony.
 * - Does NOT use TransactionEngine, so use carefully and only when
 *   you explicitly want to rebalance funds.
 *
 * Prerequisites:
 *   - Vault already initialized (e.g. via `npm run setup` or restore-vault).
 *   - MASTER_PASSPHRASE set in .env (32+ characters).
 *
 * Usage:
 *   npx ts-node scripts/sweep-to-funder.ts
 *
 * Optional .env overrides:
 *   SWEEP_TARGET_VAULT_SOL=2.2   (desired remaining SOL in vault)
 *   SWEEP_MIN_SOL=0.001          (skip agent if balance below this)
 */
import * as dotenv from 'dotenv';
import { Connection, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { KeyVault } from '../src/vault/KeyVault';
import { WalletManager } from '../src/wallet/WalletManager';
import { getAgentIds } from '../src/colony/agentRegistry';

dotenv.config();

// Buffer so we don't overdraw for rent/fees.
// 2_000_000 lamports ≈ 0.002 SOL, which is plenty for tx fees and
// avoids "insufficient funds for rent" when sweeping nearly all SOL.
const RENT_AND_FEE_BUFFER_LAMPORTS = 2_000_000;

async function main(): Promise<void> {
  const passphrase = (process.env.MASTER_PASSPHRASE ?? '').trim();
  if (!passphrase || passphrase.length < 32) {
    throw new Error('MASTER_PASSPHRASE must be set in .env and at least 32 characters');
  }

  const rpcUrl = process.env.SOLANA_RPC_URL ?? 'https://api.devnet.solana.com';
  const connection = new Connection(rpcUrl, 'confirmed');
  const vault = new KeyVault(passphrase);
  const walletManager = new WalletManager(connection, vault);

  // Ensure vault exists
  try {
    vault.getAgentPublicKey('vault');
  } catch {
    throw new Error('Vault not initialized or vault wallet missing. Run npm run setup or npm run restore-vault first.');
  }

  const funderAddress = vault.getAgentPublicKey('funder');
  console.log(`Sweeping SOL to funder wallet:\n  ${funderAddress}\n`);

  const targetVaultSol = parseFloat(process.env.SWEEP_TARGET_VAULT_SOL ?? '2.2');
  const minSol = parseFloat(process.env.SWEEP_MIN_SOL ?? '0.001');

  const agentIds = getAgentIds();
  console.log(`Agents discovered from registry: ${agentIds.join(', ')}\n`);

  // First: sweep all non-vault, non-funder agents fully to funder.
  for (const agentId of agentIds) {
    if (agentId === 'vault' || agentId === 'funder') continue;

    // Only sweep agents that actually have a key in this vault.
    try {
      vault.getAgentPublicKey(agentId);
    } catch {
      console.log(`  ${agentId}: not in this vault (no key), skipping.\n`);
      continue;
    }

    const balanceSol = await walletManager.getSolBalance(agentId);
    const balanceLamports = Math.floor(balanceSol * LAMPORTS_PER_SOL);

    if (balanceSol < minSol) {
      console.log(`  ${agentId}: ${balanceSol.toFixed(4)} SOL (below MIN_SOL=${minSol}) - skip\n`);
      continue;
    }

    const sendLamports = Math.max(0, balanceLamports - RENT_AND_FEE_BUFFER_LAMPORTS);
    if (sendLamports <= 0) {
      console.log(`  ${agentId}: balance too low to cover fee - skip\n`);
      continue;
    }

    const sendSol = sendLamports / LAMPORTS_PER_SOL;
    console.log(`  ${agentId}: ${balanceSol.toFixed(4)} SOL → sending ${sendSol.toFixed(4)} SOL to funder...`);

    const tx = await walletManager.buildTransferTransaction(agentId, funderAddress, sendSol);
    await vault.sign({ agentId, transaction: tx, description: 'sweep-to-funder' });
    const raw = tx.serialize();
    const sig = await connection.sendRawTransaction(raw, { skipPreflight: false, preflightCommitment: 'confirmed' });
    await connection.confirmTransaction(sig, 'confirmed');
    console.log(`    Sent. Tx: https://solscan.io/tx/${sig}?cluster=devnet\n`);
  }

  // Then: adjust vault to targetVaultSol by sending excess (if any) to funder.
  const vaultBalanceSol = await walletManager.getSolBalance('vault');
  const vaultBalanceLamports = Math.floor(vaultBalanceSol * LAMPORTS_PER_SOL);

  console.log(`Vault balance: ${vaultBalanceSol.toFixed(4)} SOL (target: ${targetVaultSol.toFixed(4)} SOL)`);

  if (vaultBalanceSol < targetVaultSol) {
    console.log('  Vault is already below target; not sending anything from vault.');
    return;
  }

  const targetLamports = Math.floor(targetVaultSol * LAMPORTS_PER_SOL);
  const sendFromVaultLamports = Math.max(0, vaultBalanceLamports - targetLamports - RENT_AND_FEE_BUFFER_LAMPORTS);

  if (sendFromVaultLamports <= 0) {
    console.log('  After buffer, no vault SOL available to send while keeping target + rent/fees. Done.');
    return;
  }

  const sendFromVaultSol = sendFromVaultLamports / LAMPORTS_PER_SOL;
  console.log(`  Vault: sending ${sendFromVaultSol.toFixed(4)} SOL to funder to leave ~${targetVaultSol.toFixed(4)} SOL (plus rent/fee buffer).`);

  const vaultToFunderTx = await walletManager.buildTransferTransaction('vault', funderAddress, sendFromVaultSol);
  await vault.sign({ agentId: 'vault', transaction: vaultToFunderTx, description: 'sweep-to-funder-vault' });
  const rawVault = vaultToFunderTx.serialize();
  const sigVault = await connection.sendRawTransaction(rawVault, { skipPreflight: false, preflightCommitment: 'confirmed' });
  await connection.confirmTransaction(sigVault, 'confirmed');
  console.log(`    Sent from vault. Tx: https://solscan.io/tx/${sigVault}?cluster=devnet\n`);

  console.log('Done sweeping to funder.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

