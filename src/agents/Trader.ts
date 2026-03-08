/**
 * Trader agent - Intelligent spread-based trading.
 *
 * Uses MockOracle for bid/ask spread. When spread exceeds threshold, decides
 * SWAP (direction from buy pressure) or TRANSFER_TO_VAULT from accumulated
 * profit. Execute: OrcaAdapter builds swap tx (or simulated transfer), memo
 * is attached, TransactionEngine runs circuit breakers + simulation then sign/send.
 * Supports P2P matching with other traders when one wants to buy and another to sell.
 */
import { BaseAgent, AgentConfig } from './BaseAgent';
import { AgentDecision } from './types';
import { MockOracle } from '../coordination/Oracle';
import { OrcaAdapter } from '../dex/OrcaAdapter';
import { SolendAdapter } from '../dex/SolendAdapter';
import { Connection, Transaction, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import { KeyVault } from '../vault/KeyVault';
import { WalletManager } from '../wallet/WalletManager';
import { TransactionEngine } from '../transactions/TransactionEngine';
import { MemoLogger } from '../coordination/MemoLogger';
import { RationaleEngine } from '../ai/RationaleEngine';
import type { Matchmaker } from '../coordination/Matchmaker';
import { buildP2PSwap } from '../dex/TraderAdapter';

export interface TraderStrategyConfig {
  /** Minimum ask-bid spread (fraction, e.g. 0.0005 = 0.05%) to trigger a trade. */
  spreadThreshold: number;
  /** Size of each trade in SOL. */
  tradeAmountSol: number;
  /** Fraction of accumulated profit to periodically send to the vault. */
  vaultCut: number;
  /** Decision loop interval in ms. */
  tickMs: number;
  /** Mean-reversion: min |price - avg24|/avg24 to trade (e.g. 0.005 = 0.5%). Buy when price < avg24, sell when price > avg24. */
  meanReversionThreshold: number;
}

const DEFAULT_TRADER_STRATEGY: TraderStrategyConfig = {
  spreadThreshold: 0.0005,
  tradeAmountSol: 0.05,
  vaultCut: 0.15,
  tickMs: 20_000,
  meanReversionThreshold: 0.005,
};

/** Estimated DEX fee as fraction of notional (e.g. 0.003 = 0.3%). Included in cost basis on buys. */
const DEX_FEE_FRACTION = 0.003;

/** Minimum USDC to send to vault when profit is sent as USDC. */
const MIN_VAULT_CONTRIBUTION_USDC = 0.01;

/** Display rate for Last Action: 0.01 SOL = 500 USDC => 1 SOL = 50_000 USDC. */
const SOL_TO_USDC_DISPLAY = 50_000;

export class Trader extends BaseAgent {
  private oracle: MockOracle;
  private orca: OrcaAdapter;
  private solend: SolendAdapter;
  private vaultAddress: string;
  private poolId: string | null;
  private usdcMint: PublicKey | null;
  private usdcDecimals: number;
  private totalTradeProfit = 0;
  private totalCostUSD = 0;
  private totalProceedsUSD = 0;
  private totalSOLBought = 0;
  private totalSOLSold = 0;
  private strategy: TraderStrategyConfig;
  private matchmaker: Matchmaker | null;

  constructor(
    agentId: string,
    oracle: MockOracle,
    orca: OrcaAdapter,
    solend: SolendAdapter,
    vaultAddress: string,
    connection: Connection,
    vault: KeyVault,
    walletManager: WalletManager,
    txEngine: TransactionEngine,
    memoLogger: MemoLogger,
    rationaleEngine: RationaleEngine,
    strategyOverrides?: Partial<TraderStrategyConfig>,
    poolId?: string,
    matchmaker?: Matchmaker | null,
    usdcMint?: PublicKey | null,
    usdcDecimals?: number
  ) {
    const strategy: TraderStrategyConfig = {
      ...DEFAULT_TRADER_STRATEGY,
      ...strategyOverrides,
    };

    const config: AgentConfig = {
      id: agentId,
      name: agentId.startsWith('trader') || agentId.startsWith('flipper')
        ? `Trader ${(agentId.replace(/^(trader|flipper)/, '') || '1').trim() || '1'}`
        : agentId,
      tickMs: strategy.tickMs,
    };
    super(config, connection, vault, walletManager, txEngine, memoLogger, rationaleEngine);
    this.oracle = oracle;
    this.orca = orca;
    this.solend = solend;
    this.vaultAddress = vaultAddress;
    this.poolId = poolId ?? null;
    this.strategy = strategy;
    this.matchmaker = matchmaker ?? null;
    this.usdcMint = usdcMint ?? null;
    this.usdcDecimals = usdcDecimals ?? 6;
  }

  protected async onInitialize(): Promise<void> {
    // SOL-only trading: no token accounts required.
  }

  /** Update position and avg entry in stats after a trade (cost basis includes gas + DEX fees). */
  private updatePositionStats(): void {
    const positionSOL = this.totalSOLBought - this.totalSOLSold;
    this.stats.positionSOL = positionSOL;
    this.stats.avgEntryPriceUSD = this.totalSOLBought > 0 ? this.totalCostUSD / this.totalSOLBought : undefined;
    // Realized P&L = proceeds from sells − cost basis of the SOL we actually sold (not total cost of all buys).
    const costBasisOfSold =
      this.totalSOLBought > 0 && this.totalSOLSold > 0
        ? (this.totalCostUSD / this.totalSOLBought) * this.totalSOLSold
        : 0;
    this.stats.pnlUSD = this.totalProceedsUSD - costBasisOfSold;
  }

  /** Decision: mean-reversion + spread. Buy when price below 24h avg, sell when above; only when spread covers fees. */
  protected async decide(): Promise<AgentDecision> {
    const spread = this.oracle.getSpread('SOL/USDC');
    const price = this.oracle.getPrice('SOL/USDC');
    const avg24 = this.oracle.get24hAverage('SOL/USDC');
    const balance = await this.getBalance();
    const { spreadThreshold, tradeAmountSol, vaultCut, meanReversionThreshold } = this.strategy;

    if (balance < tradeAmountSol + 0.01) {
      return {
        type: 'HOLD',
        agentId: this.id,
        reason: 'Insufficient balance for trade',
        params: { balance },
        timestamp: Date.now(),
        confidence: 1.0,
      };
    }

    // Mean-reversion edge: (price - avg24) / avg24. Buy when price below avg (deviation < 0), sell when above.
    const deviation = avg24 > 0 ? (price - avg24) / avg24 : 0;

    // Rule: Spread wide enough to cover fees AND clear mean-reversion signal
    if (spread.askBidSpread > spreadThreshold) {
      let direction: 'USDC→SOL' | 'SOL→USDC' | null = null;
      if (deviation <= -meanReversionThreshold) {
        direction = 'USDC→SOL'; // price below average → buy (expect reversion up)
      } else if (deviation >= meanReversionThreshold) {
        direction = 'SOL→USDC'; // price above average → sell (expect reversion down)
      }

      if (direction !== null) {
        // Never sell first: must complete at least one buy before selling SOL.
        if (direction === 'SOL→USDC' && this.totalCostUSD === 0) {
          return {
            type: 'HOLD',
            agentId: this.id,
            reason: 'Must complete a buy before selling',
            params: { spread, deviation },
            timestamp: Date.now(),
            confidence: 1.0,
          };
        }
        const positionSOL = this.totalSOLBought - this.totalSOLSold;
        let amountSol = tradeAmountSol;
        if (direction === 'SOL→USDC') {
          if (positionSOL <= 0) {
            return {
              type: 'HOLD',
              agentId: this.id,
              reason: 'No SOL position to sell (only sell what you bought)',
              params: { spread, positionSOL: 0, deviation },
              timestamp: Date.now(),
              confidence: 1.0,
            };
          }
          amountSol = Math.min(tradeAmountSol, positionSOL);
        }
        const directionDisplay = direction;
        const edgePct = (Math.abs(deviation) * 100).toFixed(2);
        return {
          type: 'SWAP',
          agentId: this.id,
          reason: `Mean reversion: price ${deviation < 0 ? 'below' : 'above'} 24h avg by ${edgePct}%. ${directionDisplay} trade.`,
          params: {
            direction,
            amount: amountSol,
            expectedProfit: Math.abs(deviation) * amountSol * price + spread.askBidSpread * amountSol,
            spread,
            deviation,
          },
          timestamp: Date.now(),
          confidence: Math.min(1.0, Math.abs(deviation) / 0.02 + spread.askBidSpread / 0.01),
        };
      }
    }

    // Periodic vault contribution from accumulated profits (threshold low enough that small edges still trigger)
    const MIN_VAULT_CONTRIBUTION = 0.002;
    const SOL_RESERVE_FOR_FEES = 0.02;
    if (this.totalTradeProfit > 0.02) {
      const maxSend = Math.max(0, balance - SOL_RESERVE_FOR_FEES);
      const contribution = Math.min(maxSend, Math.max(MIN_VAULT_CONTRIBUTION, this.totalTradeProfit * vaultCut));
      if (contribution >= MIN_VAULT_CONTRIBUTION) {
        return {
          type: 'TRANSFER_TO_VAULT',
          agentId: this.id,
          reason: `Accumulated ${this.totalTradeProfit.toFixed(4)} SOL profit. Sending ${vaultCut * 100}% to vault.`,
          params: { contribution, totalProfit: this.totalTradeProfit },
          timestamp: Date.now(),
          confidence: 1.0,
        };
      }
    }

    return {
      type: 'HOLD',
      agentId: this.id,
      reason: `Spread ${(spread.askBidSpread * 100).toFixed(3)}% below ${(spreadThreshold * 100)}% threshold. Waiting.`,
      params: { spread },
      timestamp: Date.now(),
      confidence: 1.0,
    };
  }

  protected formatLastAction(decision: AgentDecision): string {
    if (decision.type === 'HOLD') return 'scanning for buy opportunities';
    if (decision.type === 'SWAP') {
      const dir = decision.params.direction as string;
      return dir === 'USDC→SOL' ? 'scanning for buy opportunities' : 'scanning for sell opportunities';
    }
    if (decision.type === 'TRANSFER_TO_VAULT') return 'scanning for sell opportunities';
    return decision.reason;
  }

  protected async execute(decision: AgentDecision): Promise<void> {
    if (decision.type === 'SWAP') {
      try {
        const direction = decision.params.direction as string;
        const amountSol = decision.params.amount as number;
        const oppositeDirection = direction === 'SOL→USDC' ? 'USDC→SOL' : 'SOL→USDC';
        const p2pEnabled = process.env.P2P_MATCHING_ENABLED === 'true';

        // Phase 3: Try P2P match first when matchmaker is available
        if (p2pEnabled && this.matchmaker) {
          const match = this.matchmaker.tryMatch(oppositeDirection, amountSol);
          if (match) {
            const { traderId: peerId } = match;
            const spreadData = this.oracle.getSpread('SOL/USDC');
            const spread = Math.max(0.0005, spreadData.askBidSpread);
            const { tx, estimatedOutputSol } = await buildP2PSwap(
              this.connection,
              this.vault,
              this.id,
              peerId,
              direction,
              amountSol,
              spread
            );
            const price = this.oracle.getPrice('SOL/USDC');
            const side = direction === 'SOL→USDC' ? 'sell' : 'buy';
            this.memoLogger.addMemoInstruction(tx, this.id, decision, {
              amountSol,
              priceUsd: price,
              side,
            });

            const result = await this.txEngine.executeTraderSwap(
              this.id,
              peerId,
              tx,
              `P2P swap: ${direction} ${amountSol} SOL with ${peerId}`
            );

            const outputAmount = estimatedOutputSol ?? (direction === 'SOL→USDC' ? amountSol * 0.99 : amountSol);
            const swapResult = {
              success: result.success,
              signature: result.signature,
              inputAmount: amountSol,
              outputAmount,
              simulated: (result.dryRun ?? false) || false,
              error: result.error ?? (result.blockedBy ? `Blocked by circuit breaker: ${result.blockedBy}` : undefined),
              p2p: true,
            };

            if (swapResult.success) {
              const price = this.oracle.getPrice('SOL/USDC');
              const feeLamports = result.estimatedFee ?? 0;
              const feeUSD = (feeLamports / LAMPORTS_PER_SOL) * price;
              const dexFeeUSD = amountSol * price * DEX_FEE_FRACTION;
              let realizedSOL = 0;
              if (direction === 'SOL→USDC') {
                const costBasisUSD = this.totalSOLBought > 0 ? (this.totalCostUSD / this.totalSOLBought) * amountSol : 0;
                const proceedsUSD = amountSol * price - feeUSD;
                this.totalProceedsUSD += proceedsUSD;
                this.totalSOLSold += amountSol;
                const realizedUSD = proceedsUSD - costBasisUSD;
                realizedSOL = price > 0 ? realizedUSD / price : 0;
              } else {
                this.totalCostUSD += amountSol * price + feeUSD + dexFeeUSD;
                this.totalSOLBought += amountSol;
              }
              this.updatePositionStats();

              this.totalTradeProfit += realizedSOL;
              this.stats.pnlSOL += realizedSOL;
              const usdcAmount = amountSol * SOL_TO_USDC_DISPLAY;
              this.stats.lastAction = direction === 'SOL→USDC'
                ? `sold ${amountSol.toFixed(4)} SOL for ${usdcAmount.toFixed(2)} USDC`
                : `bought ${amountSol.toFixed(4)} SOL with ${usdcAmount.toFixed(2)} USDC`;
              this.stats.lastActionTime = Date.now();
              this.recordTrade(true, amountSol);

              if (result.signature) {
                this.memoLogger.recordMemo(this.id, decision, result.signature);
                this.emit('memo', { agentId: this.id, signature: result.signature });
              }
              this.emit('trade', {
                type: 'SWAP',
                decision,
                result: swapResult,
                swapMetadata: { counterparty: peerId, swapKind: 'p2p' as const, direction, amountSol },
              });
            } else {
              this.recordTrade(false, 0);
              const reason = swapResult.error ?? 'P2P swap failed (see logs)';
              this.emit('trade', { type: 'SWAP_FAILED', reason, result: swapResult });
              if (reason.includes('Blocked by circuit breaker')) {
                this.emit('blocked', { agentId: this.id, reason });
              }
              const hasPosition = this.totalCostUSD > 0 && (this.totalSOLBought - this.totalSOLSold) > 0;
              this.stats.lastAction = hasPosition ? 'scanning for sell opportunities' : 'scanning for buy opportunities';
              this.stats.lastActionTime = Date.now();
            }
            return;
          }

          // No match: post intent for future matches, then fall through to pool
          this.matchmaker.postIntent(this.id, direction, amountSol, 10_000);
        }

        // Fallback: Pool (SOL-only) or Memo
        const { tx, realSwap, estimatedOutputSol, poolSwap, amountUsdc } = await this.orca.buildSwapTransactionForMemo(this.id, direction, amountSol);
        const dir = direction;
        const price = this.oracle.getPrice('SOL/USDC');
        const side = dir === 'SOL→USDC' ? 'sell' : 'buy';
        this.memoLogger.addMemoInstruction(tx as Transaction, this.id, decision, {
          amountSol,
          priceUsd: price,
          side,
        });

        const result = poolSwap && this.poolId
          ? await this.txEngine.executePoolSwap(this.id, this.poolId, tx as Transaction, `Pool swap: ${dir} ${amountSol} SOL`)
          : await this.txEngine.executeTransaction(
              this.id,
              tx,
              realSwap ? `Swap: ${dir} ${amountSol} SOL` : `Swap (memo): ${dir} ${amountSol} SOL`
            );

        const outputAmount = estimatedOutputSol ?? (dir === 'SOL→USDC' ? amountSol * 150 : amountSol);
        const swapResult = {
          success: result.success,
          signature: result.signature,
          inputAmount: amountSol,
          outputAmount,
          simulated: (result.dryRun ?? false) || !realSwap,
          error: result.error ?? (result.blockedBy ? `Blocked by circuit breaker: ${result.blockedBy}` : undefined),
        };

        if (swapResult.success) {
          const isRealPoolSwap = Boolean(poolSwap && this.poolId);
          let realizedSOL = 0;
          if (isRealPoolSwap) {
            const feeLamports = result.estimatedFee ?? 0;
            const feeUSD = (feeLamports / LAMPORTS_PER_SOL) * price;
            const dexFeeUSD = amountSol * price * DEX_FEE_FRACTION;
            if (dir === 'SOL→USDC') {
              // Sell: realized profit = proceeds - cost basis for sold amount (only sells create real profit).
              const costBasisUSD = this.totalSOLBought > 0 ? (this.totalCostUSD / this.totalSOLBought) * amountSol : 0;
              const proceedsUSD = amountSol * price - feeUSD;
              this.totalProceedsUSD += proceedsUSD;
              this.totalSOLSold += amountSol;
              const realizedUSD = proceedsUSD - costBasisUSD;
              realizedSOL = price > 0 ? realizedUSD / price : 0;
            } else {
              // Buy: no realized profit until we sell.
              this.totalCostUSD += amountSol * price + feeUSD + dexFeeUSD;
              this.totalSOLBought += amountSol;
            }
            this.updatePositionStats();
          }

          this.totalTradeProfit += realizedSOL;
          this.stats.pnlSOL += realizedSOL;
          // Use actual pool amounts so last action matches Solscan exactly (same decimals as on-chain).
          const usdcAmount = isRealPoolSwap && amountUsdc != null && amountUsdc > 0
            ? amountUsdc
            : amountSol * SOL_TO_USDC_DISPLAY;
          const exactSol = Math.floor(amountSol * LAMPORTS_PER_SOL) / LAMPORTS_PER_SOL;
          const solStr = isRealPoolSwap ? exactSol.toFixed(9) : amountSol.toFixed(4);
          const usdcStr = isRealPoolSwap && amountUsdc != null && amountUsdc > 0 ? usdcAmount.toFixed(6) : usdcAmount.toFixed(2);
          this.stats.lastAction = dir === 'SOL→USDC'
            ? `sold ${solStr} SOL for ${usdcStr} USDC`
            : `bought ${solStr} SOL with ${usdcStr} USDC`;
          this.stats.lastActionTime = Date.now();
          this.recordTrade(true, isRealPoolSwap ? amountSol : 0);

          // Only send to vault when we actually sold and realized profit (never on buy). Use low threshold so small profits still get sent.
          const MIN_VAULT_CONTRIBUTION = 0.002;
          const SOL_RESERVE_FOR_FEES = 0.02;
          if (isRealPoolSwap && dir === 'SOL→USDC' && realizedSOL > MIN_VAULT_CONTRIBUTION) {
            if (this.usdcMint && price > 0) {
              const usdcBalance = await this.walletManager.getTokenBalance(this.id, this.usdcMint);
              const contributionUsdc = Math.min(realizedSOL * price, usdcBalance);
              if (contributionUsdc >= MIN_VAULT_CONTRIBUTION_USDC) {
                const vaultTx = await this.walletManager.buildTokenTransferTransaction(
                  this.id,
                  this.vaultAddress,
                  this.usdcMint,
                  contributionUsdc,
                  this.usdcDecimals
                );
                this.memoLogger.addMemoInstruction(vaultTx, this.id, {
                  type: 'TRANSFER_TO_VAULT',
                  agentId: this.id,
                  reason: `Trade profit ${contributionUsdc.toFixed(2)} USDC to vault`,
                  params: { contribution: contributionUsdc / price },
                  timestamp: Date.now(),
                  confidence: 1,
                });
                const vaultResult = await this.txEngine.executeTransaction(
                  this.id,
                  vaultTx,
                  `Vault: trade profit ${contributionUsdc.toFixed(2)} USDC`
                );
                if (vaultResult.success) {
                  const solEquivalent = contributionUsdc / price;
                  this.totalTradeProfit -= solEquivalent;
                  this.stats.vaultContributions += solEquivalent;
                  if (vaultResult.signature) {
                    this.memoLogger.recordMemo(this.id, {
                      type: 'TRANSFER_TO_VAULT',
                      agentId: this.id,
                      reason: `Trade profit ${contributionUsdc.toFixed(2)} USDC to vault`,
                      params: { contribution: solEquivalent },
                      timestamp: Date.now(),
                      confidence: 1,
                    }, vaultResult.signature);
                    this.emit('memo', { agentId: this.id, signature: vaultResult.signature });
                  }
                  this.emit('trade', { type: 'VAULT_CONTRIBUTION', amount: solEquivalent, amountUsdc: contributionUsdc, result: vaultResult, reason: `Trade profit to vault` });
                }
              }
            } else {
              const balance = await this.getBalance();
              const contribution = Math.min(realizedSOL, Math.max(0, balance - SOL_RESERVE_FOR_FEES));
              if (contribution >= MIN_VAULT_CONTRIBUTION) {
                const vaultTx = await this.walletManager.buildTransferTransaction(
                  this.id,
                  this.vaultAddress,
                  contribution
                );
                this.memoLogger.addMemoInstruction(vaultTx, this.id, {
                  type: 'TRANSFER_TO_VAULT',
                  agentId: this.id,
                  reason: `Trade profit ${contribution.toFixed(4)} SOL to vault`,
                  params: { contribution },
                  timestamp: Date.now(),
                  confidence: 1,
                });
                const vaultResult = await this.txEngine.executeTransaction(
                  this.id,
                  vaultTx,
                  `Vault: trade profit ${contribution.toFixed(4)} SOL`
                );
                if (vaultResult.success) {
                  this.totalTradeProfit -= contribution;
                  this.stats.vaultContributions += contribution;
                  if (vaultResult.signature) {
                    this.memoLogger.recordMemo(this.id, {
                      type: 'TRANSFER_TO_VAULT',
                      agentId: this.id,
                      reason: `Trade profit ${contribution.toFixed(4)} SOL to vault`,
                      params: { contribution },
                      timestamp: Date.now(),
                      confidence: 1,
                    }, vaultResult.signature);
                    this.emit('memo', { agentId: this.id, signature: vaultResult.signature });
                  }
                  this.emit('trade', { type: 'VAULT_CONTRIBUTION', amount: contribution, result: vaultResult, reason: `Trade profit to vault` });
                }
              }
            }
          }

          const depositSize = Math.max(0, Math.min(realizedSOL, amountSol * 0.1));
          if (depositSize > 0 && !(isRealPoolSwap && dir === 'SOL→USDC' && realizedSOL > MIN_VAULT_CONTRIBUTION)) {
            const depositResult = await this.solend.executeDeposit(this.id, depositSize);
            this.emit('trade', {
              type: 'LEND',
              amount: depositSize,
              result: depositResult,
              reason: `Simulated Solend deposit of ${depositSize.toFixed(4)} SOL from trade profit.`,
            });
          }

          if (result.signature) {
            this.memoLogger.recordMemo(this.id, decision, result.signature);
            this.emit('memo', { agentId: this.id, signature: result.signature });
          }
          const swapMetadata = poolSwap && this.poolId
            ? { counterparty: 'pool', swapKind: 'sol', direction: dir, amountSol, amountUsdc }
            : { counterparty: 'memo', swapKind: 'memo', direction: dir, amountSol };
          this.emit('trade', { type: 'SWAP', decision, result: swapResult, swapMetadata });
        } else {
          this.recordTrade(false, 0);
          const reason = swapResult.error ?? 'Swap failed (see logs)';
          this.emit('trade', { type: 'SWAP_FAILED', reason, result: swapResult });
          if (reason.includes('Blocked by circuit breaker')) {
            this.emit('blocked', { agentId: this.id, reason });
          }
          const hasPosition = this.totalCostUSD > 0 && (this.totalSOLBought - this.totalSOLSold) > 0;
          this.stats.lastAction = hasPosition ? 'scanning for sell opportunities' : 'scanning for buy opportunities';
          this.stats.lastActionTime = Date.now();
        }
      } catch (err) {
        this.recordTrade(false, 0);
        const reason = String(err);
        this.emit('trade', { type: 'SWAP_FAILED', reason });
        const hasPosition = this.totalCostUSD > 0 && (this.totalSOLBought - this.totalSOLSold) > 0;
        this.stats.lastAction = hasPosition ? 'scanning for sell opportunities' : 'scanning for buy opportunities';
        this.stats.lastActionTime = Date.now();
      }
    }

    if (decision.type === 'TRANSFER_TO_VAULT') {
      const { contribution } = decision.params as { contribution: number };
      const price = this.oracle.getPrice('SOL/USDC');

      if (this.usdcMint && price > 0) {
        const usdcBalance = await this.walletManager.getTokenBalance(this.id, this.usdcMint);
        const contributionUsdc = contribution * price;
        const amountUsdc = Math.min(contributionUsdc, usdcBalance);
        if (amountUsdc >= MIN_VAULT_CONTRIBUTION_USDC) {
          const tx = await this.walletManager.buildTokenTransferTransaction(
            this.id,
            this.vaultAddress,
            this.usdcMint,
            amountUsdc,
            this.usdcDecimals
          );
          this.memoLogger.addMemoInstruction(tx, this.id, decision);
          const result = await this.txEngine.executeTransaction(
            this.id,
            tx,
            `Vault contribution (USDC): ${amountUsdc.toFixed(2)} USDC`
          );
          if (result.success) {
            const solEquivalent = amountUsdc / price;
            this.totalTradeProfit -= solEquivalent;
            this.stats.vaultContributions += solEquivalent;
            this.recordTrade(true, solEquivalent);
            if (result.signature) {
              this.memoLogger.recordMemo(this.id, decision, result.signature);
              this.emit('memo', { agentId: this.id, signature: result.signature });
            }
            this.emit('trade', { type: 'VAULT_CONTRIBUTION', amount: solEquivalent, amountUsdc: amountUsdc, result, reason: decision.reason });
          } else {
            this.recordTrade(false, 0);
            this.emit('trade', { type: 'VAULT_CONTRIBUTION_FAILED', reason: result.blockedBy ?? result.error });
            if (result.blockedBy) {
              this.emit('blocked', { agentId: this.id, reason: result.blockedBy });
            }
          }
        } else {
          this.recordTrade(false, 0);
          this.emit('trade', { type: 'VAULT_CONTRIBUTION_FAILED', reason: 'Insufficient USDC for vault contribution' });
        }
      } else {
        const tx = await this.walletManager.buildTransferTransaction(
          this.id,
          this.vaultAddress,
          contribution
        );
        this.memoLogger.addMemoInstruction(tx, this.id, decision);
        const result = await this.txEngine.executeTransaction(
          this.id,
          tx,
          `Vault contribution from trade profits`
        );
        if (result.success) {
          this.totalTradeProfit -= contribution;
          this.stats.vaultContributions += contribution;
          this.recordTrade(true, contribution);
          if (result.signature) {
            this.memoLogger.recordMemo(this.id, decision, result.signature);
            this.emit('memo', { agentId: this.id, signature: result.signature });
          }
          this.emit('trade', { type: 'VAULT_CONTRIBUTION', amount: contribution, result, reason: decision.reason });
        } else {
          this.recordTrade(false, 0);
          this.emit('trade', { type: 'VAULT_CONTRIBUTION_FAILED', reason: result.blockedBy ?? result.error });
          if (result.blockedBy) {
            this.emit('blocked', { agentId: this.id, reason: result.blockedBy });
          }
        }
      }
      this.stats.lastAction = 'scanning for sell opportunities';
      this.stats.lastActionTime = Date.now();
    }
  }
}
