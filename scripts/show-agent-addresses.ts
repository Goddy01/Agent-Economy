#!/usr/bin/env ts-node
/**
 * Print registered agent IDs and their public keys (from the vault state file).
 * Use this to verify which addresses your vault controls (e.g. old accumulator/flipper).
 * Does not require MASTER_PASSPHRASE; only reads the vault state file.
 *
 * Usage: npm run show-agent-addresses
 */
import * as fs from 'fs';
import * as path from 'path';

const VAULT_VERSION = 1;
const statePath = process.env.VAULT_STATE_PATH ?? path.join(process.cwd(), '.agent-colony-vault.json');

interface AgentKeyRecord {
  agentId: string;
  publicKey: string;
  derivationIndex: number;
  createdAt: number;
}

interface VaultState {
  agents: AgentKeyRecord[];
  version: number;
}

function main(): void {
  let state: VaultState;
  try {
    const raw = fs.readFileSync(statePath, 'utf-8');
    const parsed = JSON.parse(raw) as VaultState;
    if (parsed.version !== VAULT_VERSION || !Array.isArray(parsed.agents)) {
      console.error('Invalid or empty vault state.');
      process.exit(1);
    }
    state = parsed;
  } catch (e) {
    console.error('Could not read vault file:', statePath, e instanceof Error ? e.message : e);
    process.exit(1);
  }

  console.log('Registered agents (agentId -> address):\n');
  for (const a of state.agents) {
    console.log(`  ${a.agentId.padEnd(16)} ${a.publicKey}`);
  }
  console.log('');
}

main();
