/**
 * Orchestrator - Wires and runs the full agent colony.
 *
 * Loads MASTER_PASSPHRASE from .env, creates KeyVault, WalletManager,
 * TransactionEngine (circuit breakers), MemoLogger, Oracle, OrcaAdapter,
 * RationaleEngine, and Dashboard. Initializes vault (or uses existing),
 * creates agent wallets from the agent registry (default 8 agents for
 * scalability demo), wires agent events to dashboard, starts all agents
 * and periodic dashboard refresh. Judges: circuit breakers are configured
 * from env (RATE_LIMIT_TX_PER_MINUTE, DRY_RUN).
 * Set AGENT_IDS=vault,funder,pool,trader for minimal setup.
 */
import { Connection, PublicKey } from '@solana/web3.js';
import { KeyVault } from '../vault/KeyVault';
import { WalletManager } from '../wallet/WalletManager';
import { TransactionEngine, CircuitBreakerConfig } from '../transactions/TransactionEngine';
import { MemoLogger } from '../coordination/MemoLogger';
import { MockOracle } from '../coordination/Oracle';
import { Matchmaker } from '../coordination/Matchmaker';
import { OrcaAdapter } from '../dex/OrcaAdapter';
import { SolendAdapter } from '../dex/SolendAdapter';
import { RationaleEngine } from '../ai/RationaleEngine';
import { Trader, TraderStrategyConfig } from '../agents/Trader';
import { VaultAgent } from '../agents/Vault';
import { FunderAgent } from '../agents/Funder';
import { PoolAgent } from '../agents/Pool';
import type { BaseAgent } from '../agents/BaseAgent';
import { Dashboard } from '../dashboard/WebDashboard';
import { getAgentIds, getAgentKind, AgentKind } from './agentRegistry';
import { appendDynamicAgents, getNextAgentId, removeDynamicAgent } from './dynamicAgentsConfig';
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
  private solend: SolendAdapter;
  private rationaleEngine: RationaleEngine;
  private dashboard: Dashboard;

  /** All agents by id (vault, funder, pool, trader1..n). */
  private agents: Map<string, BaseAgent> = new Map();
  private sessionId: string;
  private traderDefaults: TraderStrategyConfig;
  private matchmaker: Matchmaker;
  private usdcMint: PublicKey | null;

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

    // Circuit breakers: rate limit per agent, dry run
    const circuitConfig: CircuitBreakerConfig = {
      maxTxPerMinute: parseInt(process.env.RATE_LIMIT_TX_PER_MINUTE ?? '10'),
      dryRun: process.env.DRY_RUN === 'true',
    };

    this.txEngine = new TransactionEngine(this.connection, this.vault, circuitConfig);
    this.memoLogger = new MemoLogger(this.connection, this.vault);
    this.oracle = new MockOracle();
    this.rationaleEngine = new RationaleEngine();
    this.usdcMint = process.env.USDC_MINT?.trim()
      ? new PublicKey(process.env.USDC_MINT.trim())
      : null;
    this.orca = new OrcaAdapter(this.connection, this.vault, this.txEngine, this.walletManager, {
      poolId: 'pool',
      oracle: this.oracle,
      usdcMint: this.usdcMint,
    });
    this.solend = new SolendAdapter(this.connection, this.vault, this.txEngine, this.walletManager);
    this.dashboard = new Dashboard();
    this.sessionId = Date.now().toString(36).slice(-8);

    this.traderDefaults = {
      spreadThreshold: parseFloat(process.env.TRADER_SPREAD_THRESHOLD ?? process.env.FLIPPER_SPREAD_THRESHOLD ?? '0.0005'),
      tradeAmountSol: parseFloat(process.env.TRADER_TRADE_AMOUNT_SOL ?? process.env.FLIPPER_TRADE_AMOUNT_SOL ?? '0.05'),
      vaultCut: parseFloat(process.env.TRADER_VAULT_CUT ?? process.env.FLIPPER_VAULT_CUT ?? '0.15'),
      tickMs: parseInt(process.env.TRADER_TICK_MS ?? process.env.FLIPPER_TICK_MS ?? '20000', 10),
      meanReversionThreshold: parseFloat(process.env.TRADER_MEAN_REVERSION_THRESHOLD ?? '0.005'),
    };
    this.matchmaker = new Matchmaker();
  }

  private hash01(input: string): number {
    // Deterministic 0..1 hash for per-agent strategy jitter (no shared "volume").
    let h = 2166136261;
    for (let i = 0; i < input.length; i++) {
      h ^= input.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    // >>> 0 makes it unsigned; divide by uint32 max.
    return (h >>> 0) / 4294967295;
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
      console.log('\nSAVE THIS RECOVERY PHRASE - shown once:\n');
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

    const funderMinSendSol = parseFloat(process.env.FUNDER_MIN_SEND_SOL ?? '0.005');
    const funderReserveSol = parseFloat(process.env.FUNDER_RESERVE_SOL ?? '0.01');
    const funderTickMs = parseInt(process.env.FUNDER_TICK_MS ?? '45000', 10);
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
          {
            agentIds,
            targetSolPerAgent: targetSol,
            minSendSol: funderMinSendSol,
            reserveSol: funderReserveSol,
            tickMs: funderTickMs,
          },
          this.connection, this.vault, this.walletManager,
          this.txEngine, this.memoLogger, this.rationaleEngine
        ));
      } else if (kind === 'pool') {
        this.agents.set(id, new PoolAgent(
          id,
          this.connection, this.vault, this.walletManager,
          this.txEngine, this.memoLogger, this.rationaleEngine
        ));
      } else {
        const u = this.hash01(id);
        const u2 = this.hash01(id + ':tick');
        const traderStrategy: TraderStrategyConfig = {
          ...this.traderDefaults,
          // Per-agent jitter to diversify activity and volume.
          tradeAmountSol: this.traderDefaults.tradeAmountSol * (0.7 + u * 0.6), // 0.7x..1.3x
          tickMs: Math.max(2500, Math.round(this.traderDefaults.tickMs * (0.85 + u2 * 0.3))), // 0.85x..1.15x
        };
        this.agents.set(id, new Trader(
          id, this.oracle, this.orca, this.solend, vaultAddress,
          this.connection, this.vault, this.walletManager,
          this.txEngine, this.memoLogger, this.rationaleEngine,
          traderStrategy,
          'pool',
          this.matchmaker,
          this.usdcMint ?? undefined,
          6
        ));
      }
    }

    // ── Wire events to dashboard ──────────────────────────────────
    for (const agent of this.agents.values()) {
      this.wireAgentEvents(agent);
    }

    // Allow dashboard to add more agents dynamically at runtime.
    this.dashboard.setAgentManager({
      addAgents: (payload) => this.addAgentsFromDashboard(payload),
      removeAgent: (agentId) => this.removeAgentAndClaim(agentId),
    });

    // ── Initialize and start all agents ─────────────────────────────
    for (const agent of this.agents.values()) {
      await agent.initialize();
    }

    // ── Fund Pool if below threshold (one-time at startup) ───────────
    const poolInitialSol = parseFloat(process.env.POOL_INITIAL_SOL ?? '5');
    if (agentIds.includes('pool') && poolInitialSol > 0 && process.env.DRY_RUN !== 'true') {
      const poolBalance = await this.walletManager.getSolBalance('pool');
      if (poolBalance < poolInitialSol) {
        const funderBalance = await this.walletManager.getSolBalance('funder');
        const funderReserve = parseFloat(process.env.FUNDER_RESERVE_SOL ?? '0.01');
        const minSendSol = parseFloat(process.env.FUNDER_MIN_SEND_SOL ?? '0.005');
        const amount = Math.min(poolInitialSol - poolBalance, Math.max(0, funderBalance - funderReserve));
        if (amount < minSendSol) {
          console.warn(`  Pool funding skipped: Funder balance too low (${funderBalance.toFixed(4)} SOL, reserve ${funderReserve.toFixed(4)}). Pool has ${poolBalance.toFixed(4)} SOL; need ${(poolInitialSol - poolBalance).toFixed(4)} more. Airdrop to funder or send SOL to pool manually so traders get real swaps instead of 0 SOL memo fallback.\n`);
        } else {
          try {
            const tx = await this.walletManager.buildTransferTransaction('funder', this.vault.getAgentPublicKey('pool'), amount);
            const result = await this.txEngine.executeTransaction('funder', tx, 'Initial Pool funding');
            if (result.success) {
              console.log(`  Funded pool with ${amount.toFixed(4)} SOL\n`);
              this.dashboard.addLog('funder', `Funder sent ${amount.toFixed(4)} SOL to the Pool.`, 'trade', result.signature);
            } else {
              console.warn(`  Pool funding skipped: ${result.blockedBy ?? result.error ?? 'Transfer failed'}. Pool has ${poolBalance.toFixed(4)} SOL.\n`);
            }
          } catch (e) {
            console.warn('  Pool initial funding skipped:', e instanceof Error ? e.message : e);
          }
        }
      }
    }

    // ── One-time USDC funding for traders (when USDC_MINT is set) ───────────
    const USDC_DECIMALS = 6;
    const traderUsdcThreshold = 9999;
    const traderUsdcTopup = 10000;
    if (
      this.usdcMint &&
      agentIds.includes('funder') &&
      process.env.DRY_RUN !== 'true'
    ) {
      const traderIds = agentIds.filter(
        (id) => id.startsWith('trader') || id.startsWith('flipper')
      );
      for (const traderId of traderIds) {
        try {
          const balance = await this.walletManager.getTokenBalance(
            traderId,
            this.usdcMint
          );
          if (balance >= traderUsdcThreshold) continue;
          const toAddress = this.vault.getAgentPublicKey(traderId);
          if (!toAddress) continue;
          const tx = await this.walletManager.buildTokenTransferTransaction(
            'funder',
            toAddress,
            this.usdcMint,
            traderUsdcTopup,
            USDC_DECIMALS
          );
          const result = await this.txEngine.executeTransaction(
            'funder',
            tx,
            `Initial USDC to ${traderId}`
          );
          if (result.success) {
            console.log(`  Sent ${traderUsdcTopup} USDC to ${traderId}\n`);
          }
        } catch (e) {
          console.warn(`  USDC top-up to ${traderId} skipped:`, e instanceof Error ? e.message : e);
        }
      }
    }

    // ── One-time SOL funding for traders (0.2 SOL each) ─────────────────────
    const initialTraderSol = parseFloat(process.env.INITIAL_TRADER_SOL ?? '0.2');
    if (
      initialTraderSol > 0 &&
      agentIds.includes('funder') &&
      process.env.DRY_RUN !== 'true'
    ) {
      const traderIds = agentIds.filter(
        (id) => id.startsWith('trader') || id.startsWith('flipper')
      );
      for (const traderId of traderIds) {
        try {
          const balance = await this.walletManager.getSolBalance(traderId);
          if (balance >= initialTraderSol) continue;
          const toAddress = this.vault.getAgentPublicKey(traderId);
          if (!toAddress) continue;
          const funderBalance = await this.walletManager.getSolBalance('funder');
          const reserveSol = parseFloat(process.env.FUNDER_RESERVE_SOL ?? '0.01');
          const amount = Math.min(initialTraderSol, Math.max(0, funderBalance - reserveSol));
          if (amount < parseFloat(process.env.FUNDER_MIN_SEND_SOL ?? '0.005')) continue;
          const tx = await this.walletManager.buildTransferTransaction('funder', toAddress, amount);
          const result = await this.txEngine.executeTransaction(
            'funder',
            tx,
            `Initial SOL to ${traderId}`
          );
          if (result.success) {
            console.log(`  Sent ${amount.toFixed(4)} SOL to ${traderId}\n`);
            this.dashboard.recordInflow(traderId, amount);
          }
        } catch (e) {
          console.warn(`  SOL top-up to ${traderId} skipped:`, e instanceof Error ? e.message : e);
        }
      }
    }

    this.dashboard.start();
    for (const agent of this.agents.values()) {
      agent.start();
    }

    // ── Background: periodic Pool top-up so traders get real swaps instead of 0 SOL memo fallback ───────────
    const poolTopupThreshold = parseFloat(process.env.POOL_TOPUP_THRESHOLD_SOL ?? '1');
    const poolTopupIntervalMs = parseInt(process.env.POOL_TOPUP_INTERVAL_MS ?? '60000', 10);
    if (agentIds.includes('pool') && poolTopupThreshold > 0 && poolTopupIntervalMs > 0 && process.env.DRY_RUN !== 'true') {
      setInterval(async () => {
        try {
          const poolBalance = await this.walletManager.getSolBalance('pool');
          if (poolBalance >= poolTopupThreshold) return;
          const funderBalance = await this.walletManager.getSolBalance('funder');
          const funderReserve = parseFloat(process.env.FUNDER_RESERVE_SOL ?? '0.01');
          const minSendSol = parseFloat(process.env.FUNDER_MIN_SEND_SOL ?? '0.005');
          const need = poolTopupThreshold - poolBalance;
          const amount = Math.min(need, Math.max(0, funderBalance - funderReserve));
          if (amount < minSendSol) return;
          const tx = await this.walletManager.buildTransferTransaction('funder', this.vault.getAgentPublicKey('pool'), amount);
          const result = await this.txEngine.executeTransaction('funder', tx, 'Pool top-up (periodic)');
          if (result.success) {
            console.log(`  Pool top-up: sent ${amount.toFixed(4)} SOL to pool (balance was ${poolBalance.toFixed(4)} SOL).\n`);
            this.dashboard.addLog('funder', `Funder sent ${amount.toFixed(4)} SOL to the Pool (top-up).`, 'trade', result.signature);
          }
        } catch (err) {
          // Non-fatal; next interval will retry
        }
      }, poolTopupIntervalMs);
    }

    // ── Background: periodic Pool USDC top-up from funder (when USDC_MINT set) ───────────
    const poolTopupUsdcThreshold = parseFloat(process.env.POOL_TOPUP_USDC_THRESHOLD ?? '10000');
    const poolTopupUsdcAmount = parseFloat(process.env.POOL_TOPUP_USDC_AMOUNT ?? '20000');
    if (
      this.usdcMint &&
      agentIds.includes('pool') &&
      agentIds.includes('funder') &&
      poolTopupUsdcThreshold > 0 &&
      poolTopupUsdcAmount > 0 &&
      process.env.DRY_RUN !== 'true'
    ) {
      const poolTopupUsdcIntervalMs = parseInt(process.env.POOL_TOPUP_INTERVAL_MS ?? '60000', 10);
      setInterval(async () => {
        try {
          const poolUsdc = await this.walletManager.getTokenBalance('pool', this.usdcMint!);
          if (poolUsdc >= poolTopupUsdcThreshold) return;
          const funderUsdc = await this.walletManager.getTokenBalance('funder', this.usdcMint!);
          const funderUsdcReserve = parseFloat(process.env.FUNDER_RESERVE_USDC ?? '5000');
          const need = poolTopupUsdcThreshold - poolUsdc;
          const amount = Math.min(need, poolTopupUsdcAmount, Math.max(0, funderUsdc - funderUsdcReserve));
          if (amount < 1) return;
          const poolAddress = this.vault.getAgentPublicKey('pool');
          if (!poolAddress) return;
          const tx = await this.walletManager.buildTokenTransferTransaction(
            'funder',
            poolAddress,
            this.usdcMint!,
            amount,
            6
          );
          const result = await this.txEngine.executeTransaction('funder', tx, 'Pool USDC top-up (periodic)');
          if (result.success) {
            console.log(`  Pool USDC top-up: sent ${amount.toFixed(0)} USDC to pool (balance was ${poolUsdc.toFixed(0)} USDC).\n`);
            this.dashboard.addLog('funder', `Funder sent ${amount.toFixed(0)} USDC to the Pool (top-up).`, 'trade', result.signature);
          }
        } catch (err) {
          // Non-fatal; next interval will retry
        }
      }, poolTopupUsdcIntervalMs);
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
        const currentPrice = this.oracle.getPrice('SOL/USDC');
        for (const [id, agent] of this.agents) {
          const rawStats = agent.getStats();
          const stats = { ...rawStats };
          if (stats.positionSOL != null && stats.positionSOL > 0 && stats.avgEntryPriceUSD != null) {
            stats.unrealizedPnlUSD = (currentPrice - stats.avgEntryPriceUSD) * stats.positionSOL;
          }
          const wallet = await this.walletManager.getWalletInfo(id).catch(() => null);
          const walletOrCached = wallet ?? this.walletManager.getCachedInfo(id) ?? null;
          if (walletOrCached && this.usdcMint) {
            walletOrCached.usdcBalance = await this.walletManager.getTokenBalance(id, this.usdcMint);
          }
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

  private wireAgentEvents(agent: BaseAgent): void {
    const id = agent.getId();

    agent.on('decision', ({ decision, skipped }) => {
      const skipDecisionLog =
        decision.type === 'TRANSFER_TO_VAULT' || decision.type === 'BUY' || decision.type === 'SWAP';
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

      const vaultAgent = this.agents.get('vault') as VaultAgent | undefined;

      const amountUsdc = (data as any).amountUsdc as number | undefined;
      if (
        type === 'VAULT_CONTRIBUTION' &&
        typeof amount === 'number' &&
        vaultAgent &&
        ((data as any).result?.success ?? true)
      ) {
        vaultAgent.recordIncoming(id, amount);
        this.dashboard.recordVaultContribution(id, amount, (data as any).result?.signature, typeof amountUsdc === 'number' ? amountUsdc : undefined);
      }

      if (type === 'FUNDER_DISTRIBUTION' && typeof amount === 'number' && (data as any).to) {
        const toAgentId = (data as any).to as string;
        this.dashboard.recordInflow(toAgentId, amount);
        msg = `Funder sent ${amount.toFixed(4)} SOL to ${toAgentId}.`;
      } else if (type === 'VAULT_CONTRIBUTION' && typeof amount === 'number') {
        msg = typeof amountUsdc === 'number'
          ? `${id} sent ${amountUsdc.toFixed(2)} USDC to the Vault.`
          : `${id} sent ${amount.toFixed(4)} SOL to the Vault.`;
      } else if (type === 'SWAP') {
        const swapMeta = (data as any).swapMetadata as {
          counterparty?: string;
          swapKind?: 'sol' | 'p2p' | 'memo';
          direction?: string;
          amountSol?: number;
        } | undefined;
        const amt = swapMeta?.amountSol ?? (decision as { params?: { amount?: number } })?.params?.amount;
        const amtSol = typeof amt === 'number' ? amt : 0;
        const dir = swapMeta?.direction ?? (decision as { params?: { direction?: string } })?.params?.direction;

        if (swapMeta?.counterparty === 'pool' && swapMeta?.swapKind === 'sol') {
          msg = `${id} swapped ${amtSol.toFixed(4)} SOL with the Pool.`;
        } else if (swapMeta?.counterparty === 'memo') {
          msg = `${id} recorded a swap decision (${amtSol.toFixed(4)} SOL) - no liquidity available.`;
        } else if (swapMeta?.counterparty && swapMeta?.swapKind === 'p2p') {
          const peer = swapMeta.counterparty;
          msg = `${id} and ${peer} swapped ${amtSol.toFixed(4)} SOL peer-to-peer.`;
        } else if (decision?.reason != null) {
          msg = typeof amt === 'number' ? `${decision.reason} (${amt.toFixed(2)} SOL)` : decision.reason;
        } else {
          msg = `Swap: ${amtSol.toFixed(4)} SOL`;
        }
      } else if (type === 'LEND' && typeof amount === 'number') {
        msg = `${id} deposited ${amount.toFixed(4)} SOL to Solend (simulated).`;
      } else if (type === 'BUY' && decision?.reason != null) {
        msg = decision.reason;
      } else if (typeof decision === 'object' && decision?.reason != null) {
        msg = `${type ?? 'trade'}: ${decision.reason}`;
      } else {
        msg = JSON.stringify(data);
      }
      const truncated = msg.length > 400 ? msg.substring(0, 400) + '…' : msg;
      this.dashboard.addLog(id, truncated, 'trade', typeof signature === 'string' ? signature : undefined);

      // Record buy/sell for SOL price chart (include signature so chart markers link to Solscan)
      const price = this.oracle.getPrice('SOL/USDC');
      const txSignature = typeof signature === 'string' ? signature : undefined;
      if (type === 'BUY') {
        const amountSol = typeof (data as any).amount === 'number'
          ? (data as any).amount
          : (decision as { params?: { buyAmount?: number } } | undefined)?.params?.buyAmount;
        this.dashboard.recordTrade(id, 'buy', price, amountSol, undefined, txSignature);
      } else if (type === 'SWAP') {
        const swapMeta = (data as any).swapMetadata as { direction?: string; amountSol?: number; amountUsdc?: number; swapKind?: string } | undefined;
        const params = (decision as { params?: { direction?: string; amount?: number } })?.params;
        // Only record trades when SOL actually moved (pool or P2P). Memo-only "swaps" have no liquidity and must not be counted.
        if (params && swapMeta?.swapKind !== 'memo') {
          const direction = swapMeta?.direction ?? params.direction;
          const amountSol = swapMeta?.amountSol ?? params.amount;
          const amountToken = swapMeta?.amountUsdc;
          const side = direction === 'SOL→USDC' ? 'sell' : 'buy';
          this.dashboard.recordTrade(id, side, price, amountSol, amountToken, txSignature);
        }
      }

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

  private async addAgentsFromDashboard(payload: {
    role: 'trader';
    count?: number;
    strategy?: Record<string, unknown>;
  }): Promise<{ createdIds: string[] }> {
    const kind: AgentKind = 'trader';

    const count = Math.max(1, Math.min(payload.count ?? 1, 16));
    const existingIds = Array.from(this.agents.keys());
    const createdIds: string[] = [];

    const dynamicEntries: { id: string; kind: AgentKind; strategy?: Record<string, unknown> }[] = [];

    const funder = this.agents.get('funder') as FunderAgent | undefined;

    for (let i = 0; i < count; i++) {
      const id = getNextAgentId(kind, existingIds);
      existingIds.push(id);

      // Create wallet for the new agent (idempotent if called again with same id).
      await this.walletManager.createWallet(id);

      const overrides = (payload.strategy ?? {}) as Partial<TraderStrategyConfig>;
      const u = this.hash01(id);
      const u2 = this.hash01(id + ':tick');
      const strategy: TraderStrategyConfig = { ...this.traderDefaults, ...overrides };
      if (!('tradeAmountSol' in overrides)) {
        strategy.tradeAmountSol = strategy.tradeAmountSol * (0.7 + u * 0.6);
      }
      if (!('tickMs' in overrides)) {
        strategy.tickMs = Math.max(2500, Math.round(strategy.tickMs * (0.85 + u2 * 0.3)));
      }
      const vaultAddress = this.vault.getAgentPublicKey('vault');
      const agent = new Trader(
        id,
        this.oracle,
        this.orca,
        this.solend,
        vaultAddress,
        this.connection,
        this.vault,
        this.walletManager,
        this.txEngine,
        this.memoLogger,
        this.rationaleEngine,
        strategy,
        'pool',
        this.matchmaker,
        this.usdcMint ?? undefined,
        6
      );
      this.agents.set(id, agent);
      this.wireAgentEvents(agent);
      if (funder?.addPeer) funder.addPeer(id);

      dynamicEntries.push({
        id,
        kind,
        strategy: payload.strategy ?? {},
      });

      createdIds.push(id);
    }

    // Persist new agents so they come back on restart.
    appendDynamicAgents(dynamicEntries);

    // Make sure dashboard is aware of new agent ids.
    this.dashboard.setAgentIds(Array.from(this.agents.keys()));

    // Send initial USDC to new traders when USDC_MINT is set (so they can buy SOL).
    const USDC_DECIMALS = 6;
    const newTraderUsdcAmount = 10000;
    if (this.usdcMint && createdIds.length > 0) {
      for (const traderId of createdIds) {
        try {
          const toAddress = this.vault.getAgentPublicKey(traderId);
          if (!toAddress) continue;
          const tx = await this.walletManager.buildTokenTransferTransaction(
            'funder',
            toAddress,
            this.usdcMint,
            newTraderUsdcAmount,
            USDC_DECIMALS
          );
          await this.txEngine.executeTransaction(
            'funder',
            tx,
            `Initial USDC to new trader ${traderId}`
          );
        } catch {
          // Non-fatal; trader may still get USDC from funder later
        }
      }
    }

    // Initialize + start the new agents.
    for (const id of createdIds) {
      const agent = this.agents.get(id);
      if (agent) {
        await agent.initialize();
        agent.start();
        // Immediately request a 1 SOL top-up from the funder (when available)
        // so new agents become active quickly for the scalability demo.
        await this.fundNewAgentWallet(id).catch(() => {
          // Best-effort: ignore failures here; the regular Funder agent
          // will still top up low-balance agents on its own schedule.
        });
      }
    }

    return { createdIds };
  }

  /** Delete a dynamic agent (trader), claim its SOL to the funder wallet, and remove from colony. */
  async removeAgentAndClaim(agentId: string): Promise<{ claimedSol: number; error?: string }> {
    if (agentId === 'vault' || agentId === 'funder' || agentId === 'pool') {
      return { claimedSol: 0, error: 'Cannot delete vault, funder, or pool' };
    }
    if (!agentId.startsWith('trader') && !agentId.startsWith('flipper')) {
      return { claimedSol: 0, error: 'Only traders can be removed' };
    }

    const agent = this.agents.get(agentId);
    if (!agent) {
      return { claimedSol: 0, error: 'Agent not found' };
    }

    agent.stop();
    let balance = await this.walletManager.getSolBalance(agentId);
    // When RPC fails (e.g. devnet rate limit) getSolBalance returns 0. Use dashboard's last-known balance.
    if (balance <= 0) {
      const dashboardBalance = this.dashboard.getAgentBalance(agentId);
      if (typeof dashboardBalance === 'number' && dashboardBalance > 0) {
        balance = dashboardBalance;
      }
    }
    // Leave enough for rent-exempt minimum (~0.00089 SOL) + tx fee (~0.000005); use 0.001 SOL to avoid InsufficientFundsForRent
    const rentReserveSol = 0.001;
    const claimAmount = Math.max(0, balance - rentReserveSol);
    let claimedSol = 0;
    let transferError: string | undefined;

    if (claimAmount >= 0.0001) {
      const funderAddress = this.vault.getAgentPublicKey('funder');
      const tx = await this.walletManager.buildTransferTransaction(agentId, funderAddress, claimAmount);
      const result = await this.txEngine.executeTransaction(
        agentId,
        tx,
        'Claim agent balance to funder'
      );
      if (result.success) {
        claimedSol = claimAmount;
      } else {
        transferError = result.blockedBy ?? result.error ?? 'Transfer failed';
        // Do not remove the agent so funds are not orphaned; report error to user.
        return { claimedSol: 0, error: transferError };
      }
    }

    this.agents.delete(agentId);
    removeDynamicAgent(agentId);
    const funder = this.agents.get('funder') as FunderAgent | undefined;
    if (funder?.removePeer) funder.removePeer(agentId);
    this.dashboard.setAgentIds(Array.from(this.agents.keys()));
    this.dashboard.removeAgent(agentId);

    return { claimedSol };
  }

  private async fundNewAgentWallet(agentId: string): Promise<void> {
    const funder = this.agents.get('funder');
    if (!funder) return;
    if (process.env.DRY_RUN === 'true') return;

    const reserveSol = parseFloat(process.env.FUNDER_RESERVE_SOL ?? '0.01');
    const minSendSol = parseFloat(process.env.FUNDER_MIN_SEND_SOL ?? '0.005');
    const desiredAmount = 0.2; // 0.2 SOL for each newly created trader

    const funderBalance = await this.walletManager.getSolBalance('funder');
    const maxAvailable = Math.max(0, funderBalance - reserveSol);
    const amountSol = Math.min(desiredAmount, maxAvailable);

    if (amountSol < minSendSol) return;

    const toAddress = this.vault.getAgentPublicKey(agentId);
    const tx = await this.walletManager.buildTransferTransaction('funder', toAddress, amountSol);
    const result = await this.txEngine.executeTransaction(
      'funder',
      tx,
      'funder auto-topup (new agent)'
    );
    if (result.success) {
      this.dashboard.recordInflow(agentId, amountSol);
    }
  }
}