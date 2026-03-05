#!/usr/bin/env ts-node
/**
 * Recover SOL from previous (legacy) agent wallets into the vault.
 *
 * After switching to 8 agents (accumulator1, flipper1, …), the old
 * "accumulator" and "flipper" wallets may still hold SOL. This script
 * sweeps that SOL to the vault (or to SWEEP_TO_ADDRESS if set).
 *
 * Prerequisites:
 *   - Vault already initialized (npm run setup or restore-vault).
 *   - MASTER_PASSPHRASE in .env.
 *
 * Usage:
 *   npm run recover-agent-sol
 *
 * Optional .env:
 *   SWEEP_FROM_AGENTS=accumulator,flipper   (default; comma-separated)
 *   SWEEP_TO_ADDRESS=<pubkey>              (default: vault wallet)
 *   MIN_SOL=0.001                          (skip agent if balance below this)
 */
import * as dotenv from 'dotenv';
import { Connection, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { KeyVault } from '../src/vault/KeyVault';
import { WalletManager } from '../src/wallet/WalletManager';

dotenv.config();

const RENT_AND_FEE_BUFFER_LAMPORTS = 15_000; // ~0.000015 SOL so we don't over-send

async function main(): Promise<void> {
  const passphrase = (process.env.MASTER_PASSPHRASE ?? '').trim();
  if (!passphrase || passphrase.length < 32) {
    throw new Error('MASTER_PASSPHRASE must be set in .env and at least 32 characters');
  }

  const rpcUrl = process.env.SOLANA_RPC_URL ?? 'https://api.devnet.solana.com';
  const connection = new Connection(rpcUrl, 'confirmed');
  const vault = new KeyVault(passphrase);
  const walletManager = new WalletManager(connection, vault);

  const fromAgentsEnv = (process.env.SWEEP_FROM_AGENTS ?? 'accumulator,flipper').trim();
  const fromAgents = fromAgentsEnv.split(',').map((s) => s.trim()).filter(Boolean);
  const minSol = parseFloat(process.env.MIN_SOL ?? '0.001');
  const toAddressOverride = (process.env.SWEEP_TO_ADDRESS ?? '').trim();

  if (fromAgents.length === 0) {
    throw new Error('SWEEP_FROM_AGENTS must list at least one agent id (e.g. accumulator,flipper)');
  }

  console.log('Recover SOL from previous agent wallets\n');

  // Destination: vault wallet (or SWEEP_TO_ADDRESS). Vault must already be initialized.
  let toAddress: string;
  try {
    toAddress = toAddressOverride || vault.getAgentPublicKey('vault');
  } catch (e) {
    throw new Error('Vault not initialized or vault wallet missing. Run npm run setup or npm run restore-vault first.');
  }
  console.log(`Destination: ${toAddress}\n`);

  for (const agentId of fromAgents) {
    // Only sweep from agents that are already registered (e.g. old 3-agent "accumulator"/"flipper").
    // If not registered, skip — do not create a new wallet.
    try {
      vault.getAgentPublicKey(agentId);
    } catch {
      console.log(`  ${agentId}: not in this vault (no key), skipping. Only use for legacy accumulator/flipper.\n`);
      continue;
    }

    const balanceSol = await walletManager.getSolBalance(agentId);
    const balanceLamports = Math.floor(balanceSol * LAMPORTS_PER_SOL);

    if (balanceSol < minSol) {
      console.log(`  ${agentId}: ${balanceSol.toFixed(4)} SOL (below MIN_SOL=${minSol}) — skip\n`);
      continue;
    }

    const sendLamports = Math.max(0, balanceLamports - RENT_AND_FEE_BUFFER_LAMPORTS);
    if (sendLamports <= 0) {
      console.log(`  ${agentId}: balance too low to cover fee — skip\n`);
      continue;
    }

    const sendSol = sendLamports / LAMPORTS_PER_SOL;
    console.log(`  ${agentId}: ${balanceSol.toFixed(4)} SOL → sending ${sendSol.toFixed(4)} SOL to ${toAddress.slice(0, 8)}...`);

    const tx = await walletManager.buildTransferTransaction(agentId, toAddress, sendSol);
    await vault.sign({ agentId, transaction: tx, description: 'recover-agent-sol' });
    const raw = tx.serialize();
    const sig = await connection.sendRawTransaction(raw, { skipPreflight: false, preflightCommitment: 'confirmed' });
    await connection.confirmTransaction(sig, 'confirmed');
    console.log(`    Sent. Tx: https://solscan.io/tx/${sig}?cluster=devnet\n`);
  }

  console.log('Done. Remaining SOL in those wallets is left for rent/fees.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
