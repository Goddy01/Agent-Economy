/**
 * Adversarial / attack-simulation tests for judges.
 *
 * Each test simulates an attack; passing means the attack was BLOCKED.
 * - Attack 1: Tx over max SOL → blocked, no sign/send
 * - Attack 2: Flood (3 txs when limit 2/min) → 3rd blocked
 * - Attack 3: Vault drain below floor → blocked
 * - Attack 4: Simulation failure → never sign or send
 * - Attack 5: DRY_RUN → no sign, no sendRawTransaction
 * - Attack 6: Per-agent rate limit (A exhausted, B still allowed)
 * - Attack 7: Unregistered agent → getAgentPublicKey throws
 * Plus: KeyVault passphrase length, decrypt error no secret leak, RateLimiter isolation.
 *
 * Run: npm run test:security
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  Connection,
  Transaction,
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
  Keypair,
} from '@solana/web3.js';
import { TransactionEngine, CircuitBreakerConfig } from '../src/transactions/TransactionEngine';
import { KeyVault } from '../src/vault/KeyVault';
import { RateLimiter } from '../src/transactions/RateLimiter';

// Ephemeral keypair for signing in mocks (vault.sign is mocked to use this)
const testKeypair = Keypair.generate();
const testPubkey = testKeypair.publicKey.toBase58();

/** Build a SystemProgram transfer tx for the given SOL amount (used in attack simulations). */
function createTransferTx(solAmount: number, fromPubkey = testKeypair.publicKey): Transaction {
  const to = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
  const lamports = Math.floor(solAmount * LAMPORTS_PER_SOL);
  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey,
      toPubkey: to,
      lamports,
    })
  );
  tx.recentBlockhash = 'EkSnNWid2cvwEVnVx9adB3NgoZQZ81VnZ1b3WQyTz2NJ';
  tx.feePayer = fromPubkey;
  return tx;
}

describe('Security: Attack simulations (judges run: npm run test:security)', () => {
  const mockConnection = {
    simulateTransaction: jest.fn(),
    getBalance: jest.fn(),
    sendRawTransaction: jest.fn(),
    confirmTransaction: jest.fn(),
  } as unknown as Connection;

  const mockVault = {
    getAgentPublicKey: jest.fn(),
    sign: jest.fn(),
  } as unknown as KeyVault;

  const secureConfig: CircuitBreakerConfig = {
    maxTxSol: 1.0,
    maxTxPerMinute: 2,
    vaultFloorSol: 3.0,
    dryRun: false,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    (mockConnection.simulateTransaction as jest.Mock).mockResolvedValue({ value: { err: null } });
    if ('getBalance' in mockConnection) (mockConnection.getBalance as jest.Mock).mockResolvedValue(10 * LAMPORTS_PER_SOL);
    (mockVault.getAgentPublicKey as jest.Mock).mockReturnValue(testPubkey);
    (mockVault.sign as jest.Mock).mockImplementation(
      async ({ transaction }: { transaction: Transaction }) => {
        transaction.sign(testKeypair);
        return { signature: 'mock-sig' };
      }
    );
    (mockConnection.sendRawTransaction as jest.Mock).mockResolvedValue('tx-sig-123');
    (mockConnection.confirmTransaction as jest.Mock).mockResolvedValue(undefined);
  });

  describe('Attack 1: Exceed max SOL per transaction', () => {
    test('attacker sends 2 SOL when max is 1 SOL → BLOCKED, no sign/send', async () => {
      const engine = new TransactionEngine(mockConnection, mockVault, secureConfig);
      const tx = createTransferTx(2.0);

      const result = await engine.executeTransaction('attacker', tx, 'large transfer');

      expect(result.success).toBe(false);
      expect(result.blockedBy).toBeDefined();
      expect(result.blockedBy).toMatch(/exceeds max|max 1/);
      expect(result.simulationPassed).toBe(false);
      expect(mockVault.sign).not.toHaveBeenCalled();
      expect(mockConnection.sendRawTransaction).not.toHaveBeenCalled();
    });
  });

  describe('Attack 2: Rate limit bypass (flood transactions)', () => {
    test('attacker sends 3 txs in a row when limit is 2/min → 3rd BLOCKED', async () => {
      const engine = new TransactionEngine(mockConnection, mockVault, secureConfig);
      const r1 = await engine.executeTransaction('flipper', createTransferTx(0.1), '1');
      const r2 = await engine.executeTransaction('flipper', createTransferTx(0.1), '2');
      const r3 = await engine.executeTransaction('flipper', createTransferTx(0.1), '3');

      const successCount = [r1, r2, r3].filter((r) => r.success).length;
      const rateLimited = [r1, r2, r3].find((r) => r.blockedBy && /Rate limit/i.test(r.blockedBy));
      expect(successCount).toBe(2);
      expect(rateLimited).toBeDefined();
      expect(r3.success).toBe(false);
      expect(mockVault.sign).toHaveBeenCalledTimes(2);
      expect(mockConnection.sendRawTransaction).toHaveBeenCalledTimes(2);
    });
  });

  describe('Attack 3: Vault floor bypass (drain vault below floor)', () => {
    test('vault agent tries to send 2.5 SOL when balance=5 and floor=3 → BLOCKED', async () => {
      (mockConnection.getBalance as jest.Mock).mockResolvedValue(5 * LAMPORTS_PER_SOL);
      const engine = new TransactionEngine(mockConnection, mockVault, {
        ...secureConfig,
        maxTxSol: 5,
      });
      const tx = createTransferTx(2.5);

      const result = await engine.executeTransaction('vault', tx, 'drain vault');

      expect(result.success).toBe(false);
      expect(result.blockedBy).toMatch(/Vault floor protection/i);
      expect(result.blockedBy).toMatch(/5\.00|3/);
      expect(mockVault.sign).not.toHaveBeenCalled();
      expect(mockConnection.sendRawTransaction).not.toHaveBeenCalled();
    });
  });

  describe('Attack 4: Simulation failure must block sign/send', () => {
    test('malicious tx that fails simulation → BLOCKED, never sign or send', async () => {
      (mockConnection.simulateTransaction as jest.Mock).mockResolvedValue({
        value: { err: { InstructionError: [0, 'Custom(1)'] } },
      });
      const engine = new TransactionEngine(mockConnection, mockVault, secureConfig);
      const tx = createTransferTx(0.5);

      const result = await engine.executeTransaction('flipper', tx, 'bad tx');

      expect(result.success).toBe(false);
      expect(result.simulationPassed).toBe(false);
      expect(result.error).toMatch(/Simulation failed/i);
      expect(mockVault.sign).not.toHaveBeenCalled();
      expect(mockConnection.sendRawTransaction).not.toHaveBeenCalled();
    });
  });

  describe('Attack 5: Dry run must never sign or send', () => {
    test('with DRY_RUN=true, attacker tx is “accepted” but no on-chain tx', async () => {
      const engine = new TransactionEngine(mockConnection, mockVault, {
        ...secureConfig,
        dryRun: true,
      });
      const tx = createTransferTx(0.5);

      const result = await engine.executeTransaction('attacker', tx, 'dry run');

      expect(result.success).toBe(true);
      expect(result.dryRun).toBe(true);
      expect(mockVault.sign).not.toHaveBeenCalled();
      expect(mockConnection.sendRawTransaction).not.toHaveBeenCalled();
    });
  });

  describe('Attack 6: Rate limit is per-agent (no cross-agent bypass)', () => {
    test('agent A exhausts limit; agent B can still send (independent limits)', async () => {
      const engine = new TransactionEngine(mockConnection, mockVault, secureConfig);
      const tx = createTransferTx(0.1);

      await engine.executeTransaction('agentA', createTransferTx(0.1), '1');
      await engine.executeTransaction('agentA', createTransferTx(0.1), '2');
      const a3 = await engine.executeTransaction('agentA', createTransferTx(0.1), '3');
      expect(a3.success).toBe(false);
      expect(a3.blockedBy).toMatch(/Rate limit/i);

      const b1 = await engine.executeTransaction('agentB', createTransferTx(0.1), '1');
      expect(b1.success).toBe(true);
      expect(mockVault.sign).toHaveBeenCalledTimes(3);
    });
  });

  describe('Attack 7: Unregistered agent cannot obtain key or sign', () => {
    test('getAgentPublicKey(unknown agent) → throws (no key material exposed)', () => {
      const statePath = path.join(os.tmpdir(), `vault-security-test-${Date.now()}.json`);
      const orig = process.env.VAULT_STATE_PATH;
      process.env.VAULT_STATE_PATH = statePath;
      try {
        fs.writeFileSync(statePath, JSON.stringify({
          masterSeedEncrypted: null,
          agents: [{ agentId: 'legit', publicKey: 'So11111111111111111111111111111111111111112', derivationIndex: 0, createdAt: Date.now() }],
          version: 1,
        }), 'utf-8');
        const vault = new KeyVault('a'.repeat(32));
        expect(() => vault.getAgentPublicKey('attacker_agent')).toThrow(/not registered/);
      } finally {
        process.env.VAULT_STATE_PATH = orig;
        try { fs.unlinkSync(statePath); } catch { /* ignore */ }
      }
    });
  });
});

describe('Security: KeyVault and config (no secret leakage)', () => {
  test('KeyVault rejects passphrase shorter than 32 chars', () => {
    expect(() => new KeyVault('short')).toThrow(/at least 32/);
    expect(() => new KeyVault('')).toThrow();
    expect(() => new KeyVault('a'.repeat(31))).toThrow();
    expect(() => new KeyVault('a'.repeat(32))).not.toThrow();
  });

  test('decrypt error message does not contain passphrase or key material', async () => {
    const { decrypt } = await import('../src/vault/crypto');
    const fakePayload = {
      salt: 'a'.repeat(64),
      iv: 'b'.repeat(32),
      tag: 'c'.repeat(32),
      ciphertext: 'd'.repeat(64),
    };
    try {
      await decrypt(fakePayload, 'wrong-passphrase');
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).not.toMatch(/wrong-passphrase|secret key|private key|seed|mnemonic|passphrase.*leak/i);
      expect(msg).toMatch(/MASTER_PASSPHRASE|decryption failed|does not match/i);
    }
  });
});

describe('Security: RateLimiter isolation', () => {
  test('each agent has independent window', () => {
    const limiter = new RateLimiter(2, 60_000);
    expect(limiter.check('alice').allowed).toBe(true);
    limiter.record('alice');
    expect(limiter.check('alice').allowed).toBe(true);
    limiter.record('alice');
    expect(limiter.check('alice').allowed).toBe(false);
    expect(limiter.check('bob').allowed).toBe(true);
  });
});
