#!/usr/bin/env ts-node
/**
 * Teardown (sweep + local state cleanup)
 *
 * Goal: "tear down all agents" by sweeping SOL from every agent wallet
 * (including vault + funder) to a destination wallet address, then clearing
 * local persisted state so the colony does not come back on restart.
 *
 * Usage:
 *   npm run teardown -- <DESTINATION_WALLET_ADDRESS> [--dry-run]
 *
 * Notes:
 * - This only sweeps SOL (native lamports).
 * - Leaves a small buffer in each wallet for fees/rent to avoid overdraw.
 * - Only sweeps wallets that already exist in the local vault file; it will NOT
 *   create new wallets.
 */
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import { Connection, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import { KeyVault } from '../src/vault/KeyVault';
import { WalletManager } from '../src/wallet/WalletManager';
import { getAgentIds } from '../src/colony/agentRegistry';

dotenv.config();

// Buffer so we don't overdraw (tx fee + rent edge cases).
const RENT_AND_FEE_BUFFER_LAMPORTS = 2_000_000; // ~0.002 SOL

function getVaultStatePath(): string {
  return process.env.VAULT_STATE_PATH ?? path.join(process.cwd(), '.agent-colony-vault.json');
}

function getDynamicAgentsPath(): string {
  return path.join(process.cwd(), 'config', 'agents.dynamic.json');
}

function parseArgs(argv: string[]): { destination: string; dryRun: boolean } {
  const args = argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const destination = args.find((a) => !a.startsWith('-')) ?? '';
  return { destination, dryRun };
}

function readRegisteredAgentIdsFromVaultFile(statePath: string): string[] {
  try {
    if (!fs.existsSync(statePath)) return [];
    const raw = fs.readFileSync(statePath, 'utf8');
    if (!raw.trim()) return [];
    const parsed = JSON.parse(raw) as { agents?: Array<{ agentId?: string }> };
    if (!parsed || !Array.isArray(parsed.agents)) return [];
    return parsed.agents
      .map((a) => (typeof a.agentId === 'string' ? a.agentId : ''))
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function sweepAllAgentsToDestination(opts: {
  connection: Connection;
  vault: KeyVault;
  walletManager: WalletManager;
  agentIds: string[];
  destination: string;
  dryRun: boolean;
}): Promise<void> {
  const { connection, vault, walletManager, agentIds, destination, dryRun } = opts;

  console.log(`Destination: ${destination}`);
  console.log(`Agents to sweep (${agentIds.length}): ${agentIds.join(', ')}\n`);

  for (const agentId of agentIds) {
    // Only sweep agents that are already registered in this vault.
    try {
      vault.getAgentPublicKey(agentId);
    } catch {
      console.log(`  ${agentId}: not in this vault (no key) - skip`);
      continue;
    }

    const balanceSol = await walletManager.getSolBalance(agentId);
    const balanceLamports = Math.floor(balanceSol * LAMPORTS_PER_SOL);
    const sendLamports = Math.max(0, balanceLamports - RENT_AND_FEE_BUFFER_LAMPORTS);

    if (sendLamports <= 0) {
      console.log(`  ${agentId}: ${balanceSol.toFixed(6)} SOL - nothing to send (buffer)`);
      continue;
    }

    const sendSol = sendLamports / LAMPORTS_PER_SOL;
    if (dryRun) {
      console.log(`  ${agentId}: ${balanceSol.toFixed(6)} SOL - would send ${sendSol.toFixed(6)} SOL`);
      continue;
    }

    console.log(`  ${agentId}: ${balanceSol.toFixed(6)} SOL → sending ${sendSol.toFixed(6)} SOL...`);
    const tx = await walletManager.buildTransferTransaction(agentId, destination, sendSol);
    await vault.sign({ agentId, transaction: tx, description: 'teardown-sweep' });
    const raw = tx.serialize();
    const sig = await connection.sendRawTransaction(raw, { skipPreflight: false, preflightCommitment: 'confirmed' });
    await connection.confirmTransaction(sig, 'confirmed');
    console.log(`    Sent. Tx: https://solscan.io/tx/${sig}?cluster=devnet`);
  }
}

function cleanupLocalState(opts: { dryRun: boolean }): void {
  const { dryRun } = opts;
  const vaultPath = getVaultStatePath();
  const dynamicPath = getDynamicAgentsPath();

  const pathsToRemove = [dynamicPath, vaultPath];
  console.log('\nLocal state cleanup:');
  for (const p of pathsToRemove) {
    if (!fs.existsSync(p)) {
      console.log(`  - ${p}: not found`);
      continue;
    }
    if (dryRun) {
      console.log(`  - ${p}: would delete`);
      continue;
    }
    try {
      fs.unlinkSync(p);
      console.log(`  - ${p}: deleted`);
    } catch (err) {
      console.log(`  - ${p}: failed to delete (${err instanceof Error ? err.message : String(err)})`);
    }
  }
}

async function main(): Promise<void> {
  const { destination, dryRun } = parseArgs(process.argv);
  if (!destination) {
    throw new Error('Missing destination address. Usage: npm run teardown -- <DESTINATION_WALLET_ADDRESS> [--dry-run]');
  }
  try {
    // Validate base58 pubkey format early.
    // eslint-disable-next-line no-new
    new PublicKey(destination);
  } catch {
    throw new Error('Invalid destination wallet address (not a valid Solana public key).');
  }

  const passphrase = (process.env.MASTER_PASSPHRASE ?? '').trim();
  if (!passphrase || passphrase.length < 32) {
    throw new Error('MASTER_PASSPHRASE must be set in .env and at least 32 characters');
  }

  const rpcUrl = process.env.SOLANA_RPC_URL ?? 'https://api.devnet.solana.com';
  const connection = new Connection(rpcUrl, 'confirmed');
  const vault = new KeyVault(passphrase);
  const walletManager = new WalletManager(connection, vault);

  // Build the sweep list from:
  // - configured registry + dynamic agents
  // - AND whatever is registered in the vault file (covers old agents / renamed presets)
  const vaultStatePath = getVaultStatePath();
  const registered = readRegisteredAgentIdsFromVaultFile(vaultStatePath);
  const configured = getAgentIds();
  const all = Array.from(new Set<string>([...configured, ...registered]));

  if (all.length === 0) {
    console.log('No agents found to teardown (empty registry + no vault file).');
    cleanupLocalState({ dryRun });
    return;
  }

  await sweepAllAgentsToDestination({
    connection,
    vault,
    walletManager,
    agentIds: all,
    destination,
    dryRun,
  });

  cleanupLocalState({ dryRun });

  console.log('\nTeardown complete.');
  if (!dryRun) {
    console.log('If a colony process is still running in another terminal, stop it (Ctrl+C) before starting again.');
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});

