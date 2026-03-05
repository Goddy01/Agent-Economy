/**
 * TransactionEngine unit tests — Circuit breakers and dry run.
 *
 * Covers: maxTxSol (block over limit, allow under), rate limit (block 3rd tx),
 * vault floor (block when postBalance < floor, allow when >=), and dry run
 * (success but never sign or sendRawTransaction). Judges: run with
 * npm run test:security together with security-attacks.test.ts.
 */
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

const testKeypair = Keypair.generate();
const testPubkey = testKeypair.publicKey.toBase58();

function createTransferTx(solAmount: number): Transaction {
  const to = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
  const lamports = Math.floor(solAmount * LAMPORTS_PER_SOL);
  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: testKeypair.publicKey,
      toPubkey: to,
      lamports,
    })
  );
  tx.recentBlockhash = 'EkSnNWid2cvwEVnVx9adB3NgoZQZ81VnZ1b3WQyTz2NJ';
  tx.feePayer = testKeypair.publicKey;
  return tx;
}

describe('TransactionEngine', () => {
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

  const baseConfig: CircuitBreakerConfig = {
    maxTxSol: 1.0,
    maxTxPerMinute: 2,
    vaultFloorSol: 3.0,
    dryRun: false,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    (mockConnection.simulateTransaction as jest.Mock).mockResolvedValue({
      value: { err: null },
    });
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

  describe('maxTxSol circuit breaker', () => {
    test('blocks transactions over maxTxSol with blockedBy message', async () => {
      const engine = new TransactionEngine(mockConnection, mockVault, baseConfig);
      const tx = createTransferTx(1.5); // 1.5 SOL > maxTxSol 1.0

      const result = await engine.executeTransaction('flipper', tx, 'test');

      expect(result.success).toBe(false);
      expect(result.blockedBy).toBeDefined();
      expect(result.blockedBy).toContain('exceeds max');
      expect(result.blockedBy).toContain('max 1');
      expect(result.simulationPassed).toBe(false);
      expect(mockConnection.simulateTransaction).not.toHaveBeenCalled();
      expect(mockVault.sign).not.toHaveBeenCalled();
    });

    test('allows transactions at or below maxTxSol', async () => {
      const engine = new TransactionEngine(mockConnection, mockVault, baseConfig);
      const tx = createTransferTx(0.5); // 0.5 SOL <= maxTxSol 1.0

      const result = await engine.executeTransaction('flipper', tx, 'test');

      expect(result.success).toBe(true);
      expect(result.blockedBy).toBeUndefined();
      expect(mockConnection.simulateTransaction).toHaveBeenCalled();
    });
  });

  describe('rate limit circuit breaker', () => {
    test('blocks after maxTxPerWindow transactions', async () => {
      const engine = new TransactionEngine(mockConnection, mockVault, baseConfig);
      const tx = createTransferTx(0.1); // Small tx, under all limits

      // First two should succeed
      const r1 = await engine.executeTransaction('flipper', tx, 'test 1');
      const r2 = await engine.executeTransaction('flipper', tx, 'test 2');

      expect(r1.success).toBe(true);
      expect(r2.success).toBe(true);

      // Third should be blocked by rate limit
      const r3 = await engine.executeTransaction('flipper', tx, 'test 3');

      expect(r3.success).toBe(false);
      expect(r3.blockedBy).toBeDefined();
      expect(r3.blockedBy).toMatch(/Rate limit/i);
      expect(r3.blockedBy).toMatch(/remaining|resets/i);
      expect(r3.simulationPassed).toBe(false);
    });
  });

  describe('vault floor circuit breaker', () => {
    test('blocks if postBalance < floor', async () => {
      const vaultFloorConfig: CircuitBreakerConfig = {
        ...baseConfig,
        maxTxSol: 5, // Allow 2.5 SOL tx so vault floor check is reached
      };
      const engine = new TransactionEngine(
        mockConnection,
        mockVault,
        vaultFloorConfig
      );
      // balance 5 SOL, spend 2.5 SOL -> postBalance 2.5 < floor 3.0
      (mockConnection.getBalance as jest.Mock).mockResolvedValue(
        5 * LAMPORTS_PER_SOL
      );
      (mockVault.getAgentPublicKey as jest.Mock).mockReturnValue(testPubkey);

      const tx = createTransferTx(2.5);

      const result = await engine.executeTransaction('vault', tx, 'test');

      expect(result.success).toBe(false);
      expect(result.blockedBy).toBeDefined();
      expect(result.blockedBy).toMatch(/Vault floor protection/i);
      expect(result.blockedBy).toContain('5.00');
      expect(result.blockedBy).toContain('3');
      expect(result.simulationPassed).toBe(false);
      expect(mockConnection.simulateTransaction).not.toHaveBeenCalled();
    });

    test('allows vault transaction when postBalance >= floor', async () => {
      const vaultFloorConfig: CircuitBreakerConfig = {
        ...baseConfig,
        maxTxSol: 5, // Allow 1.5 SOL tx
      };
      const engine = new TransactionEngine(
        mockConnection,
        mockVault,
        vaultFloorConfig
      );
      // balance 5 SOL, spend 1.5 SOL -> postBalance 3.5 >= floor 3.0
      (mockConnection.getBalance as jest.Mock).mockResolvedValue(
        5 * LAMPORTS_PER_SOL
      );

      const tx = createTransferTx(1.5);

      const result = await engine.executeTransaction('vault', tx, 'test');

      expect(result.success).toBe(true);
      expect(result.blockedBy).toBeUndefined();
      expect(mockConnection.simulateTransaction).toHaveBeenCalled();
    });
  });

  describe('dry run (security: never send when DRY_RUN)', () => {
    test('when dryRun is true, never signs or sends transaction', async () => {
      const dryRunConfig: CircuitBreakerConfig = {
        ...baseConfig,
        dryRun: true,
      };
      const engine = new TransactionEngine(mockConnection, mockVault, dryRunConfig);
      const tx = createTransferTx(0.1);

      const result = await engine.executeTransaction('flipper', tx, 'dry run test');

      expect(result.success).toBe(true);
      expect(result.dryRun).toBe(true);
      expect(result.simulationPassed).toBe(true);
      expect(mockVault.sign).not.toHaveBeenCalled();
      expect(mockConnection.sendRawTransaction).not.toHaveBeenCalled();
    });
  });
});
