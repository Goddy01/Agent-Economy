/**
 * TransactionEngine unit tests - Circuit breakers and dry run.
 *
 * Covers: rate limit (block 3rd tx), and dry run (success but never sign or
 * sendRawTransaction). Judges: run with npm run test:security together with
 * security-attacks.test.ts.
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
import { SolendAdapter } from '../src/dex/SolendAdapter';

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
    getLatestBlockhash: jest.fn(),
  } as unknown as Connection;

  const mockVault = {
    getAgentPublicKey: jest.fn(),
    sign: jest.fn(),
  } as unknown as KeyVault;

  const baseConfig: CircuitBreakerConfig = {
    maxTxPerMinute: 2,
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

  describe('per-agent risk configuration via CircuitBreakerConfig', () => {
    test('supports different rate limits for conservative vs. aggressive agents', async () => {
      const conservativeConfig: CircuitBreakerConfig = {
        ...baseConfig,
        maxTxPerMinute: 1,
      };
      const aggressiveConfig: CircuitBreakerConfig = {
        ...baseConfig,
        maxTxPerMinute: 3,
      };

      const vaultEngine = new TransactionEngine(mockConnection, mockVault, conservativeConfig);
      const flipperEngine = new TransactionEngine(mockConnection, mockVault, aggressiveConfig);

      const tx = createTransferTx(0.1);

      const v1 = await vaultEngine.executeTransaction('vault', tx, 'vault 1');
      const v2 = await vaultEngine.executeTransaction('vault', tx, 'vault 2');

      expect(v1.success).toBe(true);
      expect(v2.success).toBe(false);
      expect(v2.blockedBy).toMatch(/Rate limit/i);

      const f1 = await flipperEngine.executeTransaction('flipper', tx, 'flip 1');
      const f2 = await flipperEngine.executeTransaction('flipper', tx, 'flip 2');
      const f3 = await flipperEngine.executeTransaction('flipper', tx, 'flip 3');
      const f4 = await flipperEngine.executeTransaction('flipper', tx, 'flip 4');

      const flipperResults = [f1, f2, f3, f4];
      const successCount = flipperResults.filter((r) => r.success).length;
      const rateLimited = flipperResults.find(
        (r) => r.blockedBy && /Rate limit/i.test(r.blockedBy)
      );

      expect(successCount).toBe(3);
      expect(rateLimited).toBeDefined();
    });
  });

  describe('SolendAdapter integration', () => {
    beforeEach(() => {
      (mockConnection.getLatestBlockhash as jest.Mock).mockResolvedValue({
        blockhash: 'test-blockhash',
        lastValidBlockHeight: 1,
      });
    });

    test('propagates TransactionEngine success to Solend deposit result', async () => {
      const mockTxEngine = {
        executeTransaction: jest.fn(),
      } as unknown as TransactionEngine;

      const adapter = new SolendAdapter(
        mockConnection,
        mockVault,
        mockTxEngine as unknown as TransactionEngine,
        {} as any
      );

      const engineResult = {
        success: true,
        signature: 'sig-123',
        simulationPassed: true,
        dryRun: false,
        agentId: 'flipper',
        estimatedFee: 5000,
      };

      (mockTxEngine.executeTransaction as jest.Mock).mockResolvedValue(engineResult);

      const amount = 0.25;
      const result = await adapter.executeDeposit('flipper', amount);

      expect((mockTxEngine.executeTransaction as jest.Mock).mock.calls.length).toBe(1);
      const [agentId, txArg, description] = (mockTxEngine.executeTransaction as jest.Mock).mock
        .calls[0];
      expect(agentId).toBe('flipper');
      expect(txArg).toBeInstanceOf(Transaction);
      expect(description).toContain('Simulated Solend deposit');
      expect(description).toContain(amount.toFixed(4));

      expect(result.success).toBe(true);
      expect(result.signature).toBe(engineResult.signature);
      expect(result.inputAmount).toBe(amount);
      expect(result.simulated).toBe(false);
      expect(result.error).toBeUndefined();
      expect(result.blockedBy).toBeUndefined();
    });

    test('surfaces circuit breaker blocks in Solend deposit result', async () => {
      const mockTxEngine = {
        executeTransaction: jest.fn(),
      } as unknown as TransactionEngine;

      const adapter = new SolendAdapter(
        mockConnection,
        mockVault,
        mockTxEngine as unknown as TransactionEngine,
        {} as any
      );

      const engineResult = {
        success: false,
        simulationPassed: false,
        dryRun: false,
        agentId: 'flipper',
        estimatedFee: 0,
        blockedBy: 'Rate limit: 0 remaining, resets in 10s',
      };

      (mockTxEngine.executeTransaction as jest.Mock).mockResolvedValue(engineResult);

      const result = await adapter.executeDeposit('flipper', 0.1);

      expect(result.success).toBe(false);
      expect(result.blockedBy).toBe(engineResult.blockedBy);
      expect(result.error).toMatch(/Blocked by circuit breaker/i);
    });
  });
});
