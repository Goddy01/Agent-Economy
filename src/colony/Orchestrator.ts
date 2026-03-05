/**
 * Orchestrator — Wires and runs the full agent colony.
 *
 * Loads MASTER_PASSPHRASE from .env, creates KeyVault, WalletManager,
 * TransactionEngine (circuit breakers), MemoLogger, Oracle, OrcaAdapter,
 * RationaleEngine, and Dashboard. Initializes vault (or uses existing),
 * creates agent wallets from the agent registry (default 8 agents for
 * scalability demo), wires agent events to dashboard, starts all agents
 * and periodic dashboard refresh. Judges: circuit breakers are configured
 * from env (MAX_TX_SOL, RATE_LIMIT_TX_PER_MINUTE, VAULT_FLOOR_SOL, DRY_RUN).
 * Set AGENT_IDS=vault,accumulator,flipper for minimal 3-agent setup.
 */
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
import { FunderAgent } from '../agents/Funder';
import type { BaseAgent } from '../agents/BaseAgent';
import { Dashboard } from '../dashboard/WebDashboard';
import { getAgentIds, getAgentKind } from './agentRegistry';
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

  /** All agents by id (vault, accumulator1..n, flipper1..n). */
  private agents: Map<string, BaseAgent> = new Map();
  private sessionId: string;

  constructor() {
    const rpcUrl = process.env.SOLANA_RPC_URL ?? 'https://api.devnet.solana.com';
    let passphrase = process.env.MASTER_PASSPHRASE ?? '';
    passphrase = passphrase.trim();

    if (!passphrase || passphrase.length < 32) {
      throw new Error('MASTER_PASSPHRASE must be set and at least 32 characters in .env');
    }

    this.connection = new Connection(rpcUrl, 'confirmed');
    this.vault = new KeyVault(passphrase);
    this.walletManager = new WalletManager(this.connection, this.vault);

    // Circuit breakers: max SOL per tx, rate limit per agent, vault floor, dry run
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
    this.sessionId = Date.now().toString(36).slice(-8);
  }

  async run(): Promise<void> {
    const agentIds = getAgentIds();
    console.log(`Initializing Agent Colony (${agentIds.length} agents)...\n`);

    this.dashboard.setAgentIds(agentIds);
    this.dashboard.setSessionId(this.sessionId);
    this.memoLogger.setSessionId(this.sessionId);

    // ── Initialize vault ─────────────────────────────────────────
    let mnemonic: string | undefined;
    try {
      mnemonic = await this.vault.initialize();
      console.log('\nSAVE THIS RECOVERY PHRASE — shown once:\n');
      console.log(`  ${mnemonic}\n`);
      console.log('Vault initialized. Starting in 5 seconds...\n');
      await new Promise(r => setTimeout(r, 5000));
    } catch (err) {
      if (String(err).includes('already initialized')) {
        console.log('Using existing vault\n');
      } else {
        throw err;
      }
    }

    // ── Create agent wallets ──────────────────────────────────────
    console.log('Creating agent wallets...');
    for (const agentId of agentIds) {
      const addr = await this.walletManager.createWallet(agentId);
      console.log(`  ${agentId.padEnd(14)} ${addr}`);
    }
    const vaultAddress = this.vault.getAgentPublicKey('vault');
    if (!vaultAddress) throw new Error('Vault wallet missing');
    console.log('');

    // ── Check balances ─────────────────────────────────────────────
    console.log('Checking agent wallet balances...');
    const needsSol: string[] = [];
    for (const agentId of agentIds) {
      const bal = await this.walletManager.getSolBalance(agentId);
      const addr = this.vault.getAgentPublicKey(agentId);
      console.log(`  ${agentId.padEnd(14)} ${bal.toFixed(4)} SOL  ${addr}`);
      if (bal <= 0) needsSol.push(agentId);
    }

    const targetSol = parseFloat(process.env.TARGET_AGENT_SOL ?? '1.0');
    if (needsSol.length > 0) {
      console.log(`\nWallets with no SOL: ${needsSol.join(', ')}. Get devnet SOL at https://faucet.solana.com/, or send SOL to the funder wallet and it will distribute to other agents when the colony starts.\n`);
    } else {
      console.log('');
    }

    // ── Create agents by kind ──────────────────────────────────────
    for (const id of agentIds) {
      const kind = getAgentKind(id);
      if (kind === 'vault') {
        this.agents.set(id, new VaultAgent(
          this.connection, this.vault, this.walletManager,
          this.txEngine, this.memoLogger, this.rationaleEngine
        ));
      } else if (kind === 'funder') {
        this.agents.set(id, new FunderAgent(
          { agentIds, targetSolPerAgent: targetSol },
          this.connection, this.vault, this.walletManager,
          this.txEngine, this.memoLogger, this.rationaleEngine
        ));
      } else if (kind === 'accumulator') {
        this.agents.set(id, new Accumulator(
          id, this.oracle, vaultAddress,
          this.connection, this.vault, this.walletManager,
          this.txEngine, this.memoLogger, this.rationaleEngine
        ));
      } else {
        this.agents.set(id, new Flipper(
          id, this.oracle, this.orca, vaultAddress,
          this.connection, this.vault, this.walletManager,
          this.txEngine, this.memoLogger, this.rationaleEngine
        ));
      }
    }

    const vaultAgent = this.agents.get('vault') as VaultAgent | undefined;

    // ── Wire events to dashboard ──────────────────────────────────
    for (const agent of this.agents.values()) {
      const id = agent.getId();

      agent.on('decision', ({ decision, skipped }) => {
        const skipDecisionLog = decision.type === 'TRANSFER_TO_VAULT' || decision.type === 'BUY' || decision.type === 'SWAP';
        if (!skipped && !skipDecisionLog) {
          let message = decision.rationale ?? decision.reason;
          const p = decision.params as Record<string, unknown>;
          if (decision.type === 'SWAP' && typeof p.amount === 'number') {
            message += ` (${p.amount.toFixed(2)} SOL)`;
          }
          this.dashboard.addLog(id, message, 'decision');
        }
      });

      agent.on('memo', ({ agentId, signature }) => {
        this.dashboard.setLastDecisionLogSignature(agentId, signature);
        this.dashboard.recordSignature(agentId, signature, 'memo');
      });

      agent.on('trade', (data: Record<string, unknown>) => {
        let signature: unknown;
        if (typeof (data as any).signature === 'string') {
          signature = (data as any).signature;
        } else if (typeof (data as any).result?.signature === 'string') {
          signature = (data as any).result.signature;
        }

        let msg: string;
        const type = (data as any).type as string | undefined;
        const decision = (data as any).decision as { reason?: string } | undefined;
        const amount = (data as any).amount as number | undefined;
        const reason = (data as any).reason as string | undefined;

        if (
          type === 'VAULT_CONTRIBUTION' &&
          typeof amount === 'number' &&
          vaultAgent &&
          ((data as any).result?.success ?? true)
        ) {
          vaultAgent.recordIncoming(id, amount);
        }

        if (type === 'FUNDER_DISTRIBUTION' && typeof amount === 'number' && (data as any).to) {
          msg = `Sent ${amount.toFixed(4)} SOL to ${(data as any).to}.`;
        } else if (type === 'VAULT_CONTRIBUTION' && typeof amount === 'number') {
          const base = (reason ?? '').replace(/\s*Sending\s+\d+% to vault\.?\s*(\([^)]*\))?\s*$/i, '').trim();
          msg = base ? `${base} Sent ${amount.toFixed(4)} SOL to vault.` : `Sent ${amount.toFixed(4)} SOL to vault.`;
        } else if (type === 'SWAP' && decision?.reason != null) {
          const amt = (decision as { params?: { amount?: number } })?.params?.amount;
          msg = typeof amt === 'number'
            ? `${decision.reason} (${amt.toFixed(2)} SOL)`
            : decision.reason;
        } else if (type === 'BUY' && decision?.reason != null) {
          msg = decision.reason;
        } else if (typeof decision === 'object' && decision?.reason != null) {
          msg = `${type ?? 'trade'}: ${decision.reason}`;
        } else {
          msg = JSON.stringify(data);
        }
        const truncated = msg.length > 400 ? msg.substring(0, 400) + '…' : msg;
        this.dashboard.addLog(id, truncated, 'trade', typeof signature === 'string' ? signature : undefined);

        if (typeof signature === 'string') {
          const description =
            typeof (data as any).type === 'string'
              ? (data as any).type
              : 'trade';
          this.dashboard.recordSignature(id, signature, description);
        }
      });

      agent.on('blocked', ({ agentId, reason }) => {
        this.dashboard.recordBlocked(agentId, reason);
        this.dashboard.addLog(agentId, `BLOCKED: ${reason}`, 'error');
      });

      agent.on('error', ({ error }) => {
        this.dashboard.addLog(id, `ERROR: ${error}`, 'error');
      });
    }

    // ── Initialize and start all agents ─────────────────────────────
    for (const agent of this.agents.values()) {
      await agent.initialize();
    }
    this.dashboard.start();
    for (const agent of this.agents.values()) {
      agent.start();
    }

    // ── Background: update dashboard with live data ───────────────
    setInterval(async () => {
      try {
        this.oracle.tick();
        this.dashboard.updatePrice(this.oracle.getPrice('SOL/USDC'));
        try {
          const slot = await this.connection.getSlot();
          this.dashboard.updateBlock(slot);
        } catch {}
        for (const [id, agent] of this.agents) {
          const stats = agent.getStats();
          const wallet = await this.walletManager.getWalletInfo(id).catch(() => null);
          const walletOrCached = wallet ?? this.walletManager.getCachedInfo(id) ?? null;
          this.dashboard.updateAgent(id, stats, walletOrCached);
          if (id === 'vault' && walletOrCached) {
            this.dashboard.updateVaultBalance(walletOrCached.solBalance);
          }
        }
      } catch (err) {
        console.warn('Dashboard refresh error (will retry):', err instanceof Error ? err.message : err);
      }
    }, parseInt(process.env.DASHBOARD_REFRESH_MS ?? '5000'));

    process.on('SIGINT', () => {
      console.log('\n\nShutting down colony...');
      for (const agent of this.agents.values()) {
        agent.stop();
      }
      process.exit(0);
    });

    await new Promise(() => {});
  }
}