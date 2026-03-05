/**
 * KeyVault — HD wallet vault for agent keypairs.
 *
 * Master seed is encrypted at rest (crypto.ts). Agent keys are derived via
 * BIP44-style path m/44'/501'/index'/0'. Only public keys and derivation
 * indices are stored; private key material is derived on demand for signing
 * and then cleared. Unregistered agents cannot get keys (getAgentPublicKey throws).
 */
import * as fs from 'fs';
import * as path from 'path';
import * as bip39 from 'bip39';
import { derivePath } from 'ed25519-hd-key';
import { Keypair, Transaction, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { encrypt, decrypt } from './crypto';
import type {
  VaultState,
  AgentKeyRecord,
  SigningRequest,
  SigningResult,
  EncryptedSeedPayload,
} from './types';

const VAULT_VERSION = 1;
const MIN_PASSPHRASE_LENGTH = 32;  // Enforced so weak passphrases are rejected
const SOLANA_DERIVATION_PREFIX = "m/44'/501'";  // Solana standard path

// ─── Persistence: read/write vault state file (env: VAULT_STATE_PATH) ───
function getStatePath(): string {
  return process.env.VAULT_STATE_PATH ?? path.join(process.cwd(), '.agent-colony-vault.json');
}

function defaultState(): VaultState {
  return {
    masterSeedEncrypted: null,
    agents: [],
    version: VAULT_VERSION,
  };
}

function loadStateSync(): VaultState {
  const statePath = getStatePath();
  try {
    const raw = fs.readFileSync(statePath, 'utf-8');
    const parsed = JSON.parse(raw) as VaultState;
    if (parsed.version !== VAULT_VERSION) {
      return defaultState();
    }
    return parsed;
  } catch {
    return defaultState();
  }
}

function saveStateSync(state: VaultState): void {
  const statePath = getStatePath();
  const dir = path.dirname(statePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf-8');
}

/**
 * KeyVault: HD wallet vault for agent keypairs.
 * Master seed is encrypted at rest; agent keys are derived via m/44'/501'/index'/0'.
 */
export class KeyVault {
  private passphrase: string;

  constructor(passphrase: string) {
    const normalized = passphrase.trim();
    if (normalized.length < MIN_PASSPHRASE_LENGTH) {
      throw new Error(`Passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters`);
    }
    this.passphrase = normalized;
  }

  /**
   * Initialize the vault with a new mnemonic. Call once; throws if already initialized.
   * Returns the mnemonic (show to user once for backup).
   */
  /** Initialize vault with a new 24-word mnemonic; returns it once for backup. */
  async initialize(): Promise<string> {
    const state = loadStateSync();
    if (state.masterSeedEncrypted != null) {
      throw new Error('Vault already initialized');
    }

    const mnemonic = bip39.generateMnemonic(256);  // 24 words
    const seed = bip39.mnemonicToSeedSync(mnemonic);
    const payload = await encrypt(seed, this.passphrase);

    const newState: VaultState = {
      masterSeedEncrypted: payload as EncryptedSeedPayload,
      agents: [],
      version: VAULT_VERSION,
    };
    saveStateSync(newState);
    return mnemonic;
  }

  /**
   * Restore the vault from a recovery phrase (mnemonic).
   * Use this after losing .agent-colony-vault.json to regain access to the same addresses.
   * Only works when the vault file is missing or empty (not already initialized).
   */
  async restore(mnemonic: string): Promise<void> {
    const normalized = mnemonic.trim().replace(/\s+/g, ' ');
    if (!bip39.validateMnemonic(normalized)) {
      throw new Error('Invalid recovery phrase (mnemonic). Check the words and try again.');
    }
    const state = loadStateSync();
    if (state.masterSeedEncrypted != null) {
      throw new Error(
        'Vault already initialized. Delete .agent-colony-vault.json first if you intend to restore from mnemonic.'
      );
    }
    const seed = bip39.mnemonicToSeedSync(normalized);
    const payload = await encrypt(seed, this.passphrase);
    seed.fill(0);
    const newState: VaultState = {
      masterSeedEncrypted: payload as EncryptedSeedPayload,
      agents: [],
      version: VAULT_VERSION,
    };
    saveStateSync(newState);
  }

  /**
   * Register an agent and return its Solana public key (base58).
   * Idempotent: same agentId returns same address.
   */
  async registerAgent(agentId: string): Promise<string> {
    const state = loadStateSync();
    const existing = state.agents.find((a) => a.agentId === agentId);
    if (existing) {
      return existing.publicKey;
    }

    if (state.masterSeedEncrypted == null) {
      throw new Error('Vault not initialized; call initialize() first');
    }

    const seedPlain = await decrypt(state.masterSeedEncrypted, this.passphrase);
    const hexSeed = seedPlain.toString('hex');
    const nextIndex = state.agents.length > 0
      ? Math.max(...state.agents.map((a) => a.derivationIndex)) + 1
      : 0;
    const derivationPath = `${SOLANA_DERIVATION_PREFIX}/${nextIndex}'/0'`;
    const { key } = derivePath(derivationPath, hexSeed);
    const keypair = Keypair.fromSeed(key);
    const publicKey = keypair.publicKey.toBase58();

    seedPlain.fill(0);
    key.fill(0);

    const record: AgentKeyRecord = {
      agentId,
      publicKey,
      derivationIndex: nextIndex,
      createdAt: Date.now(),
    };
    state.agents.push(record);
    saveStateSync(state);
    return publicKey;
  }

  /**
   * Return the Solana public key (base58) for an already-registered agent.
   */
  getAgentPublicKey(agentId: string): string {
    const state = loadStateSync();
    const record = state.agents.find((a) => a.agentId === agentId);
    if (!record) {
      throw new Error(`Agent not registered: ${agentId}`);
    }
    return record.publicKey;
  }

  /**
   * Sign a transaction with the given agent's key. Modifies the transaction in place.
   * Returns a SigningResult for logging.
   */
  /** Sign a transaction with the agent's derived key; modifies tx in place. Called only by TransactionEngine after circuit breakers pass. */
  async sign(request: SigningRequest): Promise<SigningResult> {
    const { agentId, transaction, description: _description } = request;
    const state = loadStateSync();
    const record = state.agents.find((a) => a.agentId === agentId);
    if (!record) {
      throw new Error(`Agent not registered: ${agentId}`);
    }
    if (state.masterSeedEncrypted == null) {
      throw new Error('Vault not initialized');
    }

    // Decrypt master seed only for this sign; derive key and sign then zero buffers
    const seedPlain = await decrypt(state.masterSeedEncrypted, this.passphrase);
    const hexSeed = seedPlain.toString('hex');
    const derivationPath = `${SOLANA_DERIVATION_PREFIX}/${record.derivationIndex}'/0'`;
    const { key } = derivePath(derivationPath, hexSeed);
    const keypair = Keypair.fromSeed(key);

    seedPlain.fill(0);
    key.fill(0);

    if (transaction instanceof VersionedTransaction) {
      transaction.sign([keypair]);
    } else {
      (transaction as Transaction).sign(keypair);
    }

    const signature = this.getSignatureFromTransaction(transaction);
    return {
      signature,
      agentId,
      timestamp: Date.now(),
    };
  }

  private getSignatureFromTransaction(
    transaction: Transaction | VersionedTransaction
  ): string {
    if (transaction instanceof VersionedTransaction) {
      const sigs = transaction.signatures;
      if (sigs.length === 0) {
        return '';
      }
      const first = sigs[0];
      const sigBytes = first instanceof Uint8Array ? first : (first as { signature?: Buffer }).signature;
      if (!sigBytes || sigBytes.length === 0) {
        return '';
      }
      return bs58.encode(Buffer.from(sigBytes));
    }
    const tx = transaction as Transaction;
    const sig = tx.signature;
    if (!sig) {
      return '';
    }
    return bs58.encode(sig);
  }
}
