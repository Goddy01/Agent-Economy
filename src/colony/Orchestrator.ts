import { Connection } from '@solana/web3.js';
import { KeyVault } from '../vault/KeyVault';
import { WalletManager } from '../wallet/WalletManager';
import { TransactionEngine, CircuitBreakerConfig } from '../transactions/TransactionEngine';
import { MemoLogger } from '../coordination/MemoLogger';
import { MockOracle } from '../coordination/Oracle';
import { OrcaAdapter } from '../dex/OrcaAdapter';
import { RationaleEngine } from '../ai/RationaleEngine';
import { Accumulator } from '../agents/Accumulator';
import { Flipper } from '../agents/Flipper';
import { VaultAgent } from '../agents/Vault';
import { Dashboard } from '../dashboard/Dashboard';
import * as dotenv from 'dotenv';

dotenv.config();

export class Orchestrator {
  private connection: Connection;
  private vault: KeyVault;
  private walletManager: WalletManager;
  private txEngine: TransactionEngine;
  private memoLogger: MemoLogger;
  private oracle: MockOracle;
  private orca: OrcaAdapter;
  private rationaleEngine: RationaleEngine;
  private dashboard: Dashboard;

  private accumulator?: Accumulator;
  private flipper?: Flipper;
  private vaultAgent?: VaultAgent;

  constructor() {
    const rpcUrl = process.env.SOLANA_RPC_URL ?? 'https://api.devnet.solana.com';
    const passphrase = process.env.MASTER_PASSPHRASE;

    if (!passphrase || passphrase.length < 32) {
      throw new Error('MASTER_PASSPHRASE must be set and at least 32 characters in .env');
    }

    this.connection = new Connection(rpcUrl, 'confirmed');
    this.vault = new KeyVault(passphrase);
    this.walletManager = new WalletManager(this.connection, this.vault);

    const circuitConfig: CircuitBreakerConfig = {
      maxTxSol: parseFloat(process.env.MAX_TX_SOL ?? '0.5'),
      maxTxPerMinute: parseInt(process.env.RATE_LIMIT_TX_PER_MINUTE ?? '10'),
      vaultFloorSol: parseFloat(process.env.VAULT_FLOOR_SOL ?? '5.0'),
      dryRun: process.env.DRY_RUN === 'true',
    };

    this.txEngine = new TransactionEngine(this.connection, this.vault, circuitConfig);
    this.memoLogger = new MemoLogger(this.connection, this.vault);
    this.oracle = new MockOracle();
    this.rationaleEngine = new RationaleEngine();
    this.orca = new OrcaAdapter(this.connection, this.vault, this.txEngine, this.walletManager);
    this.dashboard = new Dashboard();
  }

  async run(): Promise<void> {
    console.log('🚀 Initializing Agent Colony...\n');

    // ── Initialize vault ─────────────────────────────────────────
    let mnemonic: string | undefined;
    try {
      mnemonic = await this.vault.initialize();
      console.log('\n⚠️  SAVE THIS RECOVERY PHRASE — shown once:\n');
      console.log(`  ${mnemonic}\n`);
      console.log('Vault initialized. Starting in 5 seconds...\n');
      await new Promise(r => setTimeout(r, 5000));
    } catch (err) {
      if (String(err).includes('already initialized')) {
        console.log('✅ Using existing vault\n');
      } else {
        throw err;
      }
    }

    // ── Create agent wallets ──────────────────────────────────────
    console.log('Creating agent wallets...');
    const vaultAddress = await this.walletManager.createWallet('vault');
    const accAddress = await this.walletManager.createWallet('accumulator');
    const flipAddress = await this.walletManager.createWallet('flipper');

    console.log(`  Vault:       ${vaultAddress}`);
    console.log(`  Accumulator: ${accAddress}`);
    console.log(`  Flipper:     ${flipAddress}\n`);

    // ── Airdrop devnet SOL ────────────────────────────────────────
    console.log('Requesting devnet airdrops...');
    try {
      await this.walletManager.requestAirdrop('vault', 2);
      await this.walletManager.requestAirdrop('vault', 2); // 4 SOL total (vault needs floor)
      await this.walletManager.requestAirdrop('accumulator', 2);
      await this.walletManager.requestAirdrop('flipper', 2);
      console.log('✅ Airdrops complete\n');
    } catch (err) {
      console.warn('⚠️  Airdrop failed (may already have funds):', err);
    }

    // ── Wire up agents ────────────────────────────────────────────
    this.vaultAgent = new VaultAgent(
      this.connection, this.vault, this.walletManager,
      this.txEngine, this.memoLogger, this.rationaleEngine
    );

    this.accumulator = new Accumulator(
      this.oracle, vaultAddress,
      this.connection, this.vault, this.walletManager,
      this.txEngine, this.memoLogger, this.rationaleEngine
    );

    this.flipper = new Flipper(
      this.oracle, this.orca, vaultAddress,
      this.connection, this.vault, this.walletManager,
      this.txEngine, this.memoLogger, this.rationaleEngine
    );

    // ── Wire events to dashboard ──────────────────────────────────
    for (const agent of [this.accumulator, this.flipper, this.vaultAgent]) {
      const id = agent.getId() as 'accumulator' | 'flipper' | 'vault';

      agent.on('decision', ({ decision, skipped }) => {
        if (!skipped) {
          this.dashboard.addLog(id, decision.rationale ?? decision.reason, 'decision');
        }
      });

      agent.on('trade', (data) => {
        this.dashboard.addLog(id, JSON.stringify(data).substring(0, 80), 'trade');
      });

      agent.on('received', ({ from, amount }) => {
        this.dashboard.addLog('vault', `Received ${amount.toFixed(4)} SOL from ${from}`, 'trade');
        if (this.vaultAgent) this.vaultAgent.recordIncoming(from, amount);
      });

      agent.on('error', ({ error }) => {
        this.dashboard.addLog(id, `ERROR: ${error}`, 'error');
      });
    }

    // ── Initialize all agents ─────────────────────────────────────
    await this.vaultAgent.initialize();
    await this.accumulator.initialize();
    await this.flipper.initialize();

    // ── Start dashboard ───────────────────────────────────────────
    this.dashboard.start();

    // ── Start agents ──────────────────────────────────────────────
    this.vaultAgent.start();
    this.accumulator.start();
    this.flipper.start();

    // ── Background: update dashboard with live data ───────────────
    setInterval(async () => {
      this.oracle.tick();
      this.dashboard.updatePrice(this.oracle.getPrice('SOL/USDC'));

      try {
        const slot = await this.connection.getSlot();
        this.dashboard.updateBlock(slot);
      } catch {}

      for (const [id, agent] of [
        ['accumulator', this.accumulator!],
        ['flipper', this.flipper!],
        ['vault', this.vaultAgent!],
      ] as const) {
        const stats = agent.getStats();
        const wallet = await this.walletManager.getWalletInfo(id).catch(() => null);
        this.dashboard.updateAgent(id as any, stats, wallet);

        if (id === 'vault' && wallet) {
          this.dashboard.updateVaultBalance(wallet.solBalance);
        }
      }
    }, parseInt(process.env.DASHBOARD_REFRESH_MS ?? '2000'));

    // ── Graceful shutdown ─────────────────────────────────────────
    process.on('SIGINT', () => {
      console.log('\n\nShutting down colony...');
      this.accumulator?.stop();
      this.flipper?.stop();
      this.vaultAgent?.stop();
      process.exit(0);
    });

    // Keep running until killed
    await new Promise(() => {});
  }
}