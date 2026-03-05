/**
 * KeyVault and signing types.
 *
 * SigningRequest/SigningResult: used when the vault signs a transaction for an agent.
 * AgentKeyRecord: one entry per agent (publicKey, derivation index).
 * VaultState: persisted vault file shape (encrypted seed + agent list).
 */
import { Transaction, VersionedTransaction } from '@solana/web3.js';

export interface SigningRequest {
  agentId: string;
  transaction: Transaction | VersionedTransaction;
  description: string;  // Human-readable reason for signing
}

export interface SigningResult {
  signature: string;
  agentId: string;
  timestamp: number;
}

export interface AgentKeyRecord {
  agentId: string;
  publicKey: string;  // base58
  derivationIndex: number;
  createdAt: number;
}

export interface VaultState {
  masterSeedEncrypted: EncryptedSeedPayload | null;
  agents: AgentKeyRecord[];
  version: number;
}

export interface EncryptedSeedPayload {
  salt: string;
  iv: string;
  tag: string;
  ciphertext: string;
}