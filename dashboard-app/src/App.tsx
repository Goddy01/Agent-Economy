/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Activity,
  Shield,
  Zap,
  Terminal,
  Clock,
  Copy,
  Check,
  Download,
  AlertTriangle,
  Cpu,
  ExternalLink,
  Info,
  Trash2,
  History,
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { createChart, createSeriesMarkers, AreaSeries } from 'lightweight-charts';
import type { UTCTimestamp, ISeriesMarkersPluginApi, SeriesMarker, Time } from 'lightweight-charts';

interface AgentStats {
  agentId: string;
  totalTrades: number;
  successfulTrades: number;
  failedTrades: number;
  totalVolumeSOL: number;
  pnlSOL: number;
  pnlUSD?: number;
  positionSOL?: number;
  avgEntryPriceUSD?: number;
  unrealizedPnlUSD?: number;
  vaultContributions: number;
  lastAction: string;
  lastActionTime: number;
}

interface WalletInfo {
  address: string;
  solBalance: number;
  usdcBalance?: number;
}

interface ColonyState {
  agents: Record<string, { stats: AgentStats; wallet: WalletInfo | null }>;
  logs: Array<{
    timestamp: number;
    agentId: string;
    message: string;
    type: 'decision' | 'trade' | 'error' | 'memo';
    signature?: string;
  }>;
  blockedCount: number;
  blockedReasons: Array<{
    agentId: string;
    reason: string;
    timestamp: number;
  }>;
  blockHeight: number;
  oraclePrice: number;
  totalVaultBalance: number;
  startTime: number;
  dryRun: boolean;
  priceHistory: Array<{ t: number; p: number }>;
  trades: Array<{ t: number; agentId: string; side: 'buy' | 'sell'; p: number; amountSol?: number; amountToken?: number; signature?: string }>;
  totalSupply: number;
  vaultProfitHistory: Array<{ t: number; fromAgentId: string; amount: number; amountUsdc?: number; signature?: string }>;
}

const REFRESH_INTERVAL = 3000;
const BOOT_SECONDS = 15;

/** Trader presets that pre-fill trade size, min spread to trade, and tick (user can still edit). */
const TRADER_PRESETS: Record<string, { tradeAmountSol: number; spreadThreshold: number; tickMs: number }> = {
  conservative: { tradeAmountSol: 0.02, spreadThreshold: 0.001, tickMs: 30_000 },
  balanced: { tradeAmountSol: 0.05, spreadThreshold: 0.0005, tickMs: 20_000 },
  aggressive: { tradeAmountSol: 0.1, spreadThreshold: 0.0003, tickMs: 10_000 },
};

const SOLSCAN_TX = (sig: string) => `https://solscan.io/tx/${sig}?cluster=devnet`;

/** Format number with comma-separated thousands (e.g. 10000 → "10,000"). */
function formatNum(n: number, decimals?: number): string {
  if (decimals != null)
    return n.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  return n.toLocaleString();
}

// Responsive grid layout helper for agent sections so 1–4 cards per section
// look balanced without awkward empty columns.
function gridColsFor(count: number): string {
  if (count <= 1) return 'grid-cols-1 md:grid-cols-1 lg:grid-cols-2';
  if (count === 2) return 'grid-cols-1 md:grid-cols-2 lg:grid-cols-2';
  if (count === 3) return 'grid-cols-1 md:grid-cols-2 lg:grid-cols-3';
  return 'grid-cols-1 md:grid-cols-2 lg:grid-cols-4';
}

/** Highlight SOL and token amounts in layman trade messages. */
function highlightAmounts(text: string): React.ReactNode {
  const parts: React.ReactNode[] = [];
  const re = /(\d+\.?\d{0,4})\s*SOL|(\d+\.?\d{0,2})\s*tokens/g;
  let match;
  let lastIndex = 0;
  let key = 0;
  while ((match = re.exec(text)) !== null) {
    parts.push(text.slice(lastIndex, match.index));
    if (match[1]) {
      parts.push(<span key={key++} className="text-emerald-400 font-medium">{match[1]} SOL</span>);
    } else {
      parts.push(<span key={key++} className="text-amber-400 font-medium">{match[2]} tokens</span>);
    }
    lastIndex = match.index + match[0].length;
  }
  parts.push(text.slice(lastIndex));
  return <span>{parts}</span>;
}

function formatLogMessage(message: string): React.ReactNode {
  let parsed: {
    type?: string;
    reason?: string;
    amount?: number;
    result?: { success?: boolean; error?: string; signature?: string; inputAmount?: number; outputAmount?: number; simulated?: boolean };
  };
  try {
    if (message.startsWith('{')) parsed = JSON.parse(message);
    else return highlightAmounts(message);
  } catch {
    return message;
  }
  if (parsed?.type === 'VAULT_CONTRIBUTION') {
    const amount = parsed.amount ?? 0;
    const success = parsed.result?.success !== false;
    return (
      <span className="block">
        {success ? (
          <>Sent <span className="text-emerald-400 font-medium">{formatNum(amount, 4)} SOL</span> to vault.</>
        ) : (
          <>Failed to send {formatNum(amount, 4)} SOL to vault. {parsed.result?.error ?? ''}</>
        )}
      </span>
    );
  }
  if (parsed?.type === 'SWAP_FAILED') {
    const reason = parsed.reason ?? parsed.result?.error ?? 'Unknown';
    const r = parsed.result;
    return (
      <span className="block space-y-1">
        <span className="text-rose-400 font-semibold">SWAP_FAILED</span>
        <span className="block text-white/70">{reason}</span>
        {r && (
          <span className="block text-[10px] text-white/40 font-mono">
            {r.success === false && 'success: false'}
            {r.inputAmount != null && ` · in: ${r.inputAmount} SOL`}
            {r.outputAmount != null && ` · out: ${r.outputAmount} SOL`}
            {r.simulated !== undefined && ` · simulated: ${r.simulated}`}
            {r.error && r.error !== reason && ` · ${r.error}`}
          </span>
        )}
      </span>
    );
  }
  return message;
}

/** Map agentId to chart marker: T1, T2, ... for traders; P for pool. */
function getAgentMarker(agentId: string): string {
  if (agentId === 'pool') return 'P';
  const m = agentId.match(/^trader(\d+)$/);
  if (m) return 'T' + m[1];
  const f = agentId.match(/^flipper(\d+)$/);
  if (f) return 'T' + f[1];
  if (agentId === 'trader') return 'T1';
  if (agentId === 'flipper') return 'T1';
  return agentId.slice(0, 2).toUpperCase();
}

/** TradingView Lightweight Charts - professional price chart with trade markers. */
type TradeForChart = { t: number; agentId: string; side: 'buy' | 'sell'; p: number; amountSol?: number; amountToken?: number; signature?: string };

function LightweightSolChart({
  priceHistory,
  trades,
  currentPrice,
}: {
  priceHistory: Array<{ t: number; p: number }>;
  trades: TradeForChart[];
  currentPrice: number;
  startTime: number;
  totalSupply?: number;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<ReturnType<typeof createChart> | null>(null);
  const seriesRef = useRef<{ setData: (data: Array<{ time: UTCTimestamp; value: number }>) => void } | null>(null);
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const [tooltip, setTooltip] = useState<{ trade: TradeForChart; x: number; y: number; line1: string; line2: string } | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const chart = createChart(containerRef.current, {
      layout: {
        background: { color: '#0D0D0E' },
        textColor: '#9ca3af',
      },
      grid: { vertLines: { color: 'rgba(255,255,255,0.06)' }, horzLines: { color: 'rgba(255,255,255,0.06)' } },
      width: containerRef.current.clientWidth,
      height: 540,
      timeScale: { timeVisible: true, secondsVisible: true },
      rightPriceScale: { borderColor: 'rgba(255,255,255,0.12)', scaleMargins: { top: 0.1, bottom: 0.2 } },
    });
    const series = chart.addSeries(AreaSeries, {
      lineColor: '#22c55e',
      topColor: 'rgba(34, 197, 94, 0.4)',
      bottomColor: 'rgba(34, 197, 94, 0)',
      lineWidth: 2,
    });
    const markersApi = createSeriesMarkers(series, []);
    chartRef.current = chart;
    seriesRef.current = series;
    markersRef.current = markersApi;
    const resize = () => chart.applyOptions({ width: containerRef.current?.clientWidth ?? 800 });
    window.addEventListener('resize', resize);
    return () => {
      window.removeEventListener('resize', resize);
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      markersRef.current = null;
    };
  }, []);

  useEffect(() => {
    const series = seriesRef.current;
    const markersApi = markersRef.current;
    if (!series || !markersApi) return;
    const data = priceHistory.length > 0
      ? priceHistory.map((d) => ({ time: (d.t / 1000) as UTCTimestamp, value: d.p }))
      : [{ time: (Date.now() / 1000 - 60) as UTCTimestamp, value: currentPrice }, { time: (Date.now() / 1000) as UTCTimestamp, value: currentPrice }];
    series.setData(data);
    const markers: SeriesMarker<Time>[] = trades.map((tr) => ({
      time: (tr.t / 1000) as UTCTimestamp,
      position: 'atPriceTop' as const,
      price: tr.p,
      shape: 'circle' as const,
      color: tr.side === 'buy' ? '#22c55e' : '#ef4444',
      text: getAgentMarker(tr.agentId),
    }));
    markersApi.setMarkers(markers);
  }, [priceHistory, trades, currentPrice]);

  // Hover tooltip: hit-test trade markers and show tooltip near cursor
  useEffect(() => {
    const container = containerRef.current;
    const chart = chartRef.current;
    const series = seriesRef.current;
    if (!container || !chart || !series || trades.length === 0) return;

    const HIT_RADIUS_PX = 28;

    const onMove = (e: MouseEvent) => {
      const rect = container.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const timeScale = chart.timeScale();
      const seriesApi = series as unknown as { priceToCoordinate: (price: number) => number | null };
      let best: { trade: TradeForChart; dist: number } | null = null;
      for (const tr of trades) {
        const mx = timeScale.timeToCoordinate((tr.t / 1000) as Time);
        const my = seriesApi.priceToCoordinate(tr.p);
        if (mx === null || my === null) continue;
        const dist = (x - mx) ** 2 + (y - my) ** 2;
        if (dist <= HIT_RADIUS_PX * HIT_RADIUS_PX && (!best || dist < best.dist)) {
          best = { trade: tr, dist };
        }
      }
      if (best) {
        const tr = best.trade;
        const markerContent = getAgentMarker(tr.agentId);
        const solAmt = tr.amountSol != null ? formatNum(tr.amountSol, 4) : '?';
        const usdVal = tr.amountSol != null ? tr.amountSol * tr.p : null;
        const action = tr.side === 'buy' ? 'bought' : 'sold';
        const line1 = `${markerContent} ${action} ${usdVal != null ? '$' + formatNum(usdVal, 2) : solAmt + ' SOL'} at $${formatNum(tr.p, 2)}`;
        const line2 = 'Market Cap';
        setTooltip({ trade: tr, x: e.clientX, y: e.clientY, line1, line2 });
      } else {
        setTooltip(null);
      }
    };

    const onLeave = () => setTooltip(null);

    container.addEventListener('mousemove', onMove);
    container.addEventListener('mouseleave', onLeave);
    return () => {
      container.removeEventListener('mousemove', onMove);
      container.removeEventListener('mouseleave', onLeave);
    };
  }, [trades]);

  const priceChange = priceHistory.length >= 2
    ? ((currentPrice - priceHistory[0]!.p) / priceHistory[0]!.p) * 100
    : 0;

  return (
    <section className="rounded-xl border border-white/5 bg-[#0D0D0E] p-4 relative">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
        <div>
          <p className="text-lg font-bold text-white">
            ${formatNum(currentPrice, 2)}
            <span className={priceChange >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
              {priceChange >= 0 ? '+' : ''}{formatNum(priceChange, 2)}%
            </span>
          </p>
          <p className="text-[10px] text-white/40">Scroll to zoom · Drag to pan · Green = buy · Red = sell</p>
        </div>
        <div className="flex items-center gap-2 text-[10px] text-white/50">
          <span>Green = buy</span>
          <span>Red = sell</span>
        </div>
      </div>
      <div ref={containerRef} className="w-full" style={{ height: 540 }} />
      {tooltip && (
        <div
          className="pointer-events-none fixed z-50 rounded-lg border border-white/10 bg-[#1c1c1e] px-3 py-2 shadow-xl"
          style={{
            left: Math.min(tooltip.x + 12, window.innerWidth - 200),
            top: tooltip.y - 8,
            transform: 'translateY(-100%)',
          }}
        >
          <p className="text-sm font-medium text-white whitespace-nowrap">{tooltip.line1}</p>
          <p className="text-xs text-white/60">{tooltip.line2}</p>
          <span
            className="absolute right-0 top-1/2 w-0 h-0 border-y-8 border-l-8 border-y-transparent border-l-[#1c1c1e] translate-x-full -translate-y-1/2"
            style={{ borderRightWidth: 0 }}
            aria-hidden
          />
        </div>
      )}
    </section>
  );
}

/** Viewport state for zoom/pan. */
interface ChartViewport {
  timeStart: number;
  timeEnd: number;
  priceMin: number;
  priceMax: number;
}

/** SOL price line chart with buy/sell markers (memecoin-style tooltips). Zoom: scroll wheel. Pan: drag. */
function SolPriceChart({
  priceHistory,
  trades,
  currentPrice,
  startTime,
}: {
  priceHistory: Array<{ t: number; p: number }>;
  trades: Array<{ t: number; agentId: string; side: 'buy' | 'sell'; p: number; amountSol?: number; amountToken?: number; signature?: string }>;
  currentPrice: number;
  startTime: number;
}) {
  const width = 800;
  const height = 220;
  const padding = { top: 12, right: 4, bottom: 28, left: 48 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;

  const now = Date.now();
  const fullTimeStart = startTime;
  const fullTimeEnd = now;
  const fullTimeRange = Math.max(1, fullTimeEnd - fullTimeStart);

  const allPrices = [
    currentPrice,
    ...priceHistory.map((d) => d.p),
    ...trades.map((d) => d.p),
  ].filter((p) => p > 0);
  const minP = allPrices.length ? Math.min(...allPrices) : currentPrice * 0.98;
  const maxP = allPrices.length ? Math.max(...allPrices) : currentPrice * 1.02;
  const fullPriceRange = Math.max(0.01, maxP - minP);
  const fullPriceMin = minP - fullPriceRange * 0.1;
  const fullPriceMax = maxP + fullPriceRange * 0.1;
  const fullPriceSpan = Math.max(0.01, fullPriceMax - fullPriceMin);

  const timePaddingLeft = fullTimeRange * 0.03;
  const paddedTimeStart = fullTimeStart - timePaddingLeft;
  const paddedTimeEnd = fullTimeEnd;

  const [viewport, setViewport] = useState<ChartViewport>(() => ({
    timeStart: paddedTimeStart,
    timeEnd: paddedTimeEnd,
    priceMin: fullPriceMin,
    priceMax: fullPriceMax,
  }));
  const [isPanning, setIsPanning] = useState(false);
  const panStart = useRef<{ x: number; y: number; timeStart: number; timeEnd: number; priceMin: number; priceMax: number } | null>(null);
  const chartRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setViewport((v) => {
      const timeStale = v.timeEnd < fullTimeEnd - 2000;
      const priceOutside = currentPrice < v.priceMin || currentPrice > v.priceMax;
      if (timeStale || priceOutside) {
        return {
          timeStart: paddedTimeStart,
          timeEnd: paddedTimeEnd,
          priceMin: fullPriceMin,
          priceMax: fullPriceMax,
        };
      }
      return v;
    });
  }, [paddedTimeStart, paddedTimeEnd, fullPriceMin, fullPriceMax, fullTimeEnd, currentPrice]);

  const timeRange = viewport.timeEnd - viewport.timeStart;
  const priceSpan = Math.max(0.01, viewport.priceMax - viewport.priceMin);

  const x = useCallback((t: number) => padding.left + ((t - viewport.timeStart) / timeRange) * chartWidth, [viewport.timeStart, timeRange]);
  const y = useCallback((p: number) => padding.top + chartHeight - ((p - viewport.priceMin) / priceSpan) * chartHeight, [viewport.priceMin, priceSpan]);

  const svgXToTime = useCallback((svgX: number) => {
    const frac = (svgX - padding.left) / chartWidth;
    return viewport.timeStart + frac * timeRange;
  }, [viewport.timeStart, timeRange]);

  const svgYToPrice = useCallback((svgY: number) => {
    const frac = 1 - (svgY - padding.top) / chartHeight;
    return viewport.priceMin + frac * priceSpan;
  }, [viewport.priceMin, priceSpan]);

  const resetView = useCallback(() => {
    setViewport({
      timeStart: paddedTimeStart,
      timeEnd: paddedTimeEnd,
      priceMin: fullPriceMin,
      priceMax: fullPriceMax,
    });
  }, [paddedTimeStart, paddedTimeEnd, fullPriceMin, fullPriceMax]);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const rect = chartRef.current?.getBoundingClientRect();
    if (!rect) return;
    const svgX = ((e.clientX - rect.left) / rect.width) * width;
    const svgY = ((e.clientY - rect.top) / rect.height) * height;
    const centerTime = svgXToTime(svgX);
    const centerPrice = svgYToPrice(svgY);
    const zoomFactor = e.deltaY > 0 ? 1.08 : 1 / 1.08;
    const newTimeRange = Math.max(60000, Math.min(fullTimeRange * 2, timeRange * zoomFactor));
    let newPriceSpan = Math.max(0.01, Math.min(fullPriceSpan * 2, priceSpan * zoomFactor));
    newPriceSpan *= 1.12;
    setViewport(() => {
      const halfTime = newTimeRange / 2;
      const halfPrice = newPriceSpan / 2;
      return {
        timeStart: Math.max(paddedTimeStart, Math.min(paddedTimeEnd - newTimeRange, centerTime - halfTime)),
        timeEnd: Math.min(paddedTimeEnd, Math.max(paddedTimeStart + newTimeRange, centerTime + halfTime)),
        priceMin: Math.max(fullPriceMin, Math.min(fullPriceMax - newPriceSpan, centerPrice - halfPrice)),
        priceMax: Math.min(fullPriceMax, Math.max(fullPriceMin + newPriceSpan, centerPrice + halfPrice)),
      };
    });
  }, [paddedTimeStart, paddedTimeEnd, fullTimeRange, fullPriceMin, fullPriceMax, fullPriceSpan, timeRange, priceSpan, svgXToTime, svgYToPrice]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button === 0 && !(e.target as Element)?.closest?.('a')) {
      setIsPanning(true);
      panStart.current = { x: e.clientX, y: e.clientY, timeStart: viewport.timeStart, timeEnd: viewport.timeEnd, priceMin: viewport.priceMin, priceMax: viewport.priceMax };
    }
  }, [viewport]);

  useEffect(() => {
    if (!isPanning) return;
    const onMove = (e: MouseEvent) => {
      if (!panStart.current) return;
      const rect = chartRef.current?.getBoundingClientRect();
      if (!rect) return;
      const dx = ((e.clientX - panStart.current.x) / rect.width) * width;
      const dy = ((e.clientY - panStart.current.y) / rect.height) * height;
      const dTime = (dx / chartWidth) * (panStart.current.timeEnd - panStart.current.timeStart);
      const dPrice = -(dy / chartHeight) * (panStart.current.priceMax - panStart.current.priceMin);
      setViewport(() => ({
        timeStart: Math.max(paddedTimeStart, Math.min(paddedTimeEnd - timeRange, panStart.current!.timeStart - dTime)),
        timeEnd: Math.min(paddedTimeEnd, Math.max(paddedTimeStart + timeRange, panStart.current!.timeEnd - dTime)),
        priceMin: Math.max(fullPriceMin, Math.min(fullPriceMax - priceSpan, panStart.current!.priceMin - dPrice)),
        priceMax: Math.min(fullPriceMax, Math.max(fullPriceMin + priceSpan, panStart.current!.priceMax - dPrice)),
      }));
    };
    const onUp = () => {
      setIsPanning(false);
      panStart.current = null;
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [isPanning, paddedTimeStart, paddedTimeEnd, fullPriceMin, fullPriceMax, timeRange, priceSpan]);

  const currentX = x(now);
  const currentY = y(currentPrice);

  const yTicks = [viewport.priceMin, viewport.priceMin + priceSpan * 0.25, viewport.priceMin + priceSpan * 0.5, viewport.priceMin + priceSpan * 0.75, viewport.priceMax];

  const xTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => ({
    x: padding.left + f * chartWidth,
    t: viewport.timeStart + f * timeRange,
  }));

  const linePath =
    priceHistory.length > 0
      ? priceHistory
          .filter((d) => d.t >= viewport.timeStart && d.t <= viewport.timeEnd)
          .map((d, i) => `${i === 0 ? 'M' : 'L'} ${x(d.t)} ${y(d.p)}`)
          .join(' ')
      : '';

  const areaPath =
    priceHistory.length > 0
      ? (() => {
          const visible = priceHistory.filter((d) => d.t >= viewport.timeStart && d.t <= viewport.timeEnd);
          if (visible.length === 0) return '';
          const path = visible.map((d, i) => `${i === 0 ? 'M' : 'L'} ${x(d.t)} ${y(d.p)}`).join(' ');
          return `${path} L ${x(visible[visible.length - 1]!.t)} ${padding.top + chartHeight} L ${x(visible[0]!.t)} ${padding.top + chartHeight} Z`;
        })()
      : '';

  const priceChange = priceHistory.length >= 2
    ? ((currentPrice - priceHistory[0]!.p) / priceHistory[0]!.p) * 100
    : 0;

  const visibleTrades = trades.filter((tr) => tr.t >= viewport.timeStart && tr.t <= viewport.timeEnd);

  return (
    <section className="bg-[#0a0a0b] border border-white/10 rounded-xl p-4 overflow-hidden">
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="flex items-center gap-3">
          <span className="text-sm font-bold text-white">
            ${formatNum(currentPrice, 2)}
          </span>
          <span className={`text-xs font-medium ${priceChange >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
            {priceChange >= 0 ? '+' : ''}{formatNum(priceChange, 2)}%
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-white/50">
            Green = buy · Red = sell
          </span>
          <button
            type="button"
            onClick={resetView}
            className="text-[10px] px-2 py-0.5 rounded bg-white/10 text-white/70 hover:bg-white/20 hover:text-white transition-colors"
          >
            Reset zoom
          </button>
        </div>
      </div>
      <p className="text-[10px] text-white/40 mb-2">
        Scroll to zoom · Drag to pan · Click a marker to open the tx on Solscan.
      </p>
      <div
        ref={chartRef}
        className="cursor-crosshair select-none"
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        style={{ cursor: isPanning ? 'grabbing' : 'crosshair' }}
      >
      <svg width={width} height={height} className="w-full max-w-full h-auto" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="xMidYMid meet">
        <defs>
          <linearGradient id="priceLineGrad" x1="0" y1="1" x2="0" y2="0">
            <stop offset="0%" stopColor="#22c55e" stopOpacity="0.3" />
            <stop offset="100%" stopColor="#22c55e" stopOpacity="0" />
          </linearGradient>
        </defs>
        {/* Grid lines */}
        {yTicks.map((p, i) => (
          <line
            key={`grid-y-${i}`}
            x1={padding.left}
            y1={y(p)}
            x2={width - padding.right}
            y2={y(p)}
            stroke="rgba(255,255,255,0.06)"
            strokeWidth="1"
          />
        ))}
        {xTicks.map((tick, i) => (
          <line
            key={`grid-x-${i}`}
            x1={tick.x}
            y1={padding.top}
            x2={tick.x}
            y2={padding.top + chartHeight}
            stroke="rgba(255,255,255,0.06)"
            strokeWidth="1"
          />
        ))}
        {/* Y-axis labels */}
        {yTicks.map((p, i) => (
          <text
            key={i}
            x={padding.left - 6}
            y={y(p) + 4}
            textAnchor="end"
            className="fill-white/50 font-mono text-[10px]"
          >
            ${formatNum(p, 2)}
          </text>
        ))}
        {/* X-axis time labels - rightmost one right-aligned so it doesn't clip with minimal right padding */}
        {xTicks.map((tick, i) => (
          <text
            key={i}
            x={i === xTicks.length - 1 ? width - padding.right : tick.x}
            y={height - 6}
            textAnchor={i === xTicks.length - 1 ? 'end' : 'middle'}
            className="fill-white/50 font-mono text-[9px]"
          >
            {new Date(tick.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}
          </text>
        ))}
        {/* Current price line */}
        <line x1={padding.left} y1={currentY} x2={width - padding.right} y2={currentY} stroke="rgba(255,255,255,0.12)" strokeWidth="1" strokeDasharray="4 2" />
        {/* Price line area fill */}
        {areaPath && <path d={areaPath} fill="url(#priceLineGrad)" />}
        {/* Price line */}
        {linePath && <path d={linePath} fill="none" stroke="#22c55e" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />}
        {/* Current price dot when no data */}
        {priceHistory.length === 0 && (
          <circle cx={currentX} cy={currentY} r="4" fill="#10b981" />
        )}
        {/* Trade markers: T1, T2, ... with tooltip (e.g. "T1 bought 0.04 SOL at $80.00"); click opens Solscan when signature present */}
        {visibleTrades.map((tr, i) => {
          const solscanUrl = tr.signature
            ? `https://solscan.io/tx/${tr.signature}?cluster=devnet`
            : null;
          const markerContent = getAgentMarker(tr.agentId);
          const solAmt = tr.amountSol != null ? formatNum(tr.amountSol, 4) : '?';
          const usdVal = tr.amountSol != null ? tr.amountSol * tr.p : null;
          const action = tr.side === 'buy' ? 'bought' : 'sold';
          const priceStr = `at $${formatNum(tr.p, 2)}`;
          const line1 = `${markerContent} ${action} ${solAmt} SOL ${priceStr}`;
          const line2 = usdVal != null ? `$${formatNum(usdVal, 2)}` : '';
          const line3 = solscanUrl ? 'Click to view tx on Solscan' : '';
          const tooltipTitle = [line1, line2, line3].filter(Boolean).join('\n');
          const cx = x(tr.t);
          const cy = y(tr.p);
          const fillCol = tr.side === 'buy' ? '#22c55e' : '#ef4444';
          const marker = (
            <g>
              <circle
                cx={cx}
                cy={cy}
                r={12}
                fill={fillCol}
                stroke="rgba(0,0,0,0.4)"
                strokeWidth="1.5"
                style={solscanUrl ? { cursor: 'pointer' } : undefined}
              />
              <text
                x={cx}
                y={cy}
                textAnchor="middle"
                dominantBaseline="central"
                fontSize="12"
                style={{ pointerEvents: 'none' }}
              >
                {markerContent}
              </text>
            </g>
          );
          return (
            <g key={`${tr.t}-${tr.agentId}-${i}`}>
              {solscanUrl ? (
                <a href={solscanUrl} target="_blank" rel="noopener noreferrer" aria-label={tooltipTitle}>
                  {marker}
                </a>
              ) : (
                marker
              )}
              <title>{tooltipTitle}</title>
            </g>
          );
        })}
      </svg>
      </div>
    </section>
  );
}

/** Log message text color: pool = blue, trader = amber, profit/vault = green, error = red. */
function logMessageColorClass(log: { agentId: string; message: string; type: string }): string {
  if (log.type === 'error') return 'text-rose-400';
  if (log.type === 'memo') return 'text-blue-300';
  if (log.type === 'trade' || log.type === 'decision') {
    const msg = typeof log.message === 'string' ? log.message : '';
    // 3 rules from user:
    // 1) Trader log text = yellow
    // 2) Pool log text = blue
    // 3) Profit taking / sending to vault = green
    if (/Sent\s+[\d.]+\s+SOL\s+to\s+vault\./i.test(msg)) return 'text-emerald-400'; // profit → green
    if (log.agentId === 'vault') return 'text-emerald-400';
    if (log.agentId === 'funder') return 'text-violet-400';
    if (log.agentId === 'pool') return 'text-blue-400';  // pool → blue
    if (log.agentId.startsWith('trader') || log.agentId.startsWith('flipper')) return 'text-amber-400';     // trader(s) → yellow
  }
  return 'text-white/60';
}

/** Initial funding per trader (used to derive pre/post balances in history). */
const TRADER_INITIAL_SOL = 0.1;
const TRADER_INITIAL_USDC = 10_000;

const TRADING_HISTORY_PAGE_SIZES = [10, 25, 50, 100];

function TraderHistoryView({
  agentId,
  state,
  onBack,
}: {
  agentId: string;
  state: ColonyState;
  onBack: () => void;
}) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);

  const rawTrades = (state.trades ?? []).filter((t) => t.agentId === agentId);
  const agent = state.agents[agentId];
  const totalSolBought = rawTrades.filter((t) => t.side === 'buy').reduce((s, t) => s + (t.amountSol ?? 0), 0);
  const totalSolSold = rawTrades.filter((t) => t.side === 'sell').reduce((s, t) => s + (t.amountSol ?? 0), 0);
  const pnlUSD = agent?.stats.pnlUSD;
  const unrealizedPnlUSD = agent?.stats.unrealizedPnlUSD;
  const totalPnlUSD = (pnlUSD ?? 0) + (unrealizedPnlUSD ?? 0);

  // Derive pre/post SOL and USDC: use current on-chain balances so first Pre and last Post match reality.
  const currentSol = agent?.wallet?.solBalance ?? TRADER_INITIAL_SOL;
  const initialSol = currentSol - totalSolBought + totalSolSold;

  const tradesAsc = [...rawTrades].sort((a, b) => a.t - b.t);
  let totalUsdcFromBuys = 0;
  let totalUsdcFromSells = 0;
  for (const tr of tradesAsc) {
    const amt = tr.amountSol ?? 0;
    const d = tr.amountToken != null ? tr.amountToken : amt * tr.p;
    if (tr.side === 'buy') totalUsdcFromBuys += d;
    else totalUsdcFromSells += d;
  }
  const currentUsdc = agent?.wallet?.usdcBalance ?? TRADER_INITIAL_USDC;
  const initialUsdc = currentUsdc + totalUsdcFromBuys - totalUsdcFromSells;

  type TradeWithBalances = (typeof rawTrades)[number] & { preSol: number; postSol: number; preUsdc: number; postUsdc: number };
  const withBalances: TradeWithBalances[] = [];
  let runningSol = initialSol;
  let runningUsdc = initialUsdc;
  for (const tr of tradesAsc) {
    const amt = tr.amountSol ?? 0;
    const usdcAmount = tr.amountToken != null ? tr.amountToken : amt * tr.p;
    const preSol = runningSol;
    const preUsdc = runningUsdc;
    let postSol = preSol;
    let postUsdc = preUsdc;
    if (tr.side === 'buy') {
      postSol = preSol + amt;
      postUsdc = preUsdc - usdcAmount;
    } else {
      postSol = preSol - amt;
      postUsdc = preUsdc + usdcAmount;
    }
    withBalances.push({ ...tr, preSol, postSol, preUsdc, postUsdc });
    runningSol = postSol;
    runningUsdc = postUsdc;
  }
  const trades = withBalances.sort((a, b) => b.t - a.t);

  const totalCount = trades.length;
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  const safePage = Math.min(page, totalPages);
  const start = (safePage - 1) * pageSize;
  const paginatedTrades = trades.slice(start, start + pageSize);

  const handlePageSizeChange = (newSize: number) => {
    setPageSize(newSize);
    setPage(1);
  };

  let displayName = agentId;
  if (agentId.startsWith('trader') || agentId.startsWith('flipper')) {
    const numericSuffix = agentId.replace(/^(trader|flipper)/, '');
    const index = numericSuffix === '' ? 1 : parseInt(numericSuffix, 10);
    displayName = `Trader ${Number.isNaN(index) ? '' : index}`.trim();
  }

  const addr = agent?.wallet?.address ?? '';

  return (
    <main className="max-w-[1600px] mx-auto p-6 space-y-6">
      <div className="flex items-center gap-4 mb-6">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-white/10 bg-white/5 hover:bg-white/10 text-white/80 text-sm font-medium transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to dashboard
        </button>
      </div>

      <section className="bg-[#0D0D0E] border border-white/5 rounded-2xl p-6">
        <div className="flex flex-wrap items-center justify-between gap-4 mb-6">
          <div>
            <h1 className="text-xl font-bold text-white uppercase tracking-tight">{displayName} - Trading history</h1>
            <p className="text-[10px] text-white/40 mt-1 font-mono truncate max-w-md">{addr || '-'}</p>
          </div>
          {addr && (
            <a
              href={`https://solscan.io/account/${addr}?cluster=devnet`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-white/10 bg-white/5 hover:bg-white/10 text-white/70 text-xs font-medium transition-colors"
            >
              <ExternalLink className="w-3.5 h-3.5" />
              View wallet on Solscan
            </a>
          )}
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6 p-4 rounded-xl bg-white/5 border border-white/5">
          <div>
            <p className="text-[10px] text-white/40 uppercase font-bold tracking-wider">Total SOL bought</p>
            <p className="text-lg font-mono text-white">{formatNum(totalSolBought, 4)}</p>
          </div>
          <div>
            <p className="text-[10px] text-white/40 uppercase font-bold tracking-wider">Total SOL sold</p>
            <p className="text-lg font-mono text-white">{formatNum(totalSolSold, 4)}</p>
          </div>
          <div>
            <p className="text-[10px] text-white/40 uppercase font-bold tracking-wider">Realized P&L</p>
            <p className={`text-lg font-mono ${(pnlUSD ?? 0) >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
              {pnlUSD != null ? ((pnlUSD >= 0 ? '+' : '') + '$' + formatNum(pnlUSD, 2)) : '-'}
            </p>
          </div>
          <div>
            <p className="text-[10px] text-white/40 uppercase font-bold tracking-wider">Total P&L</p>
            <p className={`text-lg font-mono ${totalPnlUSD >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
              {(totalPnlUSD >= 0 ? '+' : '') + '$' + formatNum(totalPnlUSD, 2)}
            </p>
          </div>
        </div>

        <h2 className="text-sm font-bold text-white/80 uppercase tracking-wider mb-3">Trade list</h2>
        {trades.length === 0 ? (
          <p className="text-sm text-white/50 py-8">No trades recorded yet.</p>
        ) : (
          <>
            <div className="overflow-x-auto rounded-lg border border-white/10">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-white/10 bg-white/5">
                    <th className="px-4 py-3 text-[10px] font-bold text-white/50 uppercase tracking-wider">Time</th>
                    <th className="px-4 py-3 text-[10px] font-bold text-white/50 uppercase tracking-wider">Side</th>
                    <th className="px-4 py-3 text-[10px] font-bold text-white/50 uppercase tracking-wider">Amount SOL</th>
                    <th className="px-4 py-3 text-[10px] font-bold text-white/50 uppercase tracking-wider">Price</th>
                    <th className="px-4 py-3 text-[10px] font-bold text-white/50 uppercase tracking-wider">Cost / Revenue (USD)</th>
                    <th className="px-4 py-3 text-[10px] font-bold text-white/50 uppercase tracking-wider">Pre SOL</th>
                    <th className="px-4 py-3 text-[10px] font-bold text-white/50 uppercase tracking-wider">Post SOL</th>
                    <th className="px-4 py-3 text-[10px] font-bold text-white/50 uppercase tracking-wider">Pre USDC</th>
                    <th className="px-4 py-3 text-[10px] font-bold text-white/50 uppercase tracking-wider">Post USDC</th>
                    <th className="px-4 py-3 text-[10px] font-bold text-white/50 uppercase tracking-wider">Tx</th>
                  </tr>
                </thead>
                <tbody>
                  {paginatedTrades.map((tr, i) => {
                    const usdVal = tr.amountSol != null ? tr.amountSol * tr.p : null;
                    return (
                      <tr key={`${tr.t}-${tr.agentId}-${i}`} className="border-b border-white/5 hover:bg-white/5">
                        <td className="px-4 py-3 font-mono text-white/80">
                          {new Date(tr.t).toLocaleString([], { dateStyle: 'short', timeStyle: 'medium', hour12: false })}
                        </td>
                        <td className="px-4 py-3">
                          <span className={tr.side === 'buy' ? 'text-emerald-400 font-medium' : 'text-rose-400 font-medium'}>
                            {tr.side === 'buy' ? 'Buy' : 'Sell'}
                          </span>
                        </td>
                        <td className="px-4 py-3 font-mono text-white">{formatNum(tr.amountSol ?? 0, 4)}</td>
                        <td className="px-4 py-3 font-mono text-white/80">${formatNum(tr.p, 2)}</td>
                        <td className="px-4 py-3 font-mono text-white/80">
                          {usdVal != null ? '$' + formatNum(usdVal, 2) : '-'}
                        </td>
                        <td className="px-4 py-3 font-mono text-white/70">{formatNum(tr.preSol, 4)}</td>
                        <td className="px-4 py-3 font-mono text-white/70">{formatNum(tr.postSol, 4)}</td>
                        <td className="px-4 py-3 font-mono text-white/70">{formatNum(tr.preUsdc, 2)}</td>
                        <td className="px-4 py-3 font-mono text-white/70">{formatNum(tr.postUsdc, 2)}</td>
                        <td className="px-4 py-3">
                          {tr.signature ? (
                            <a
                              href={`https://solscan.io/tx/${tr.signature}?cluster=devnet`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1 text-amber-400 hover:text-amber-300 text-xs"
                            >
                              <ExternalLink className="w-3 h-3" />
                              View
                            </a>
                          ) : (
                            <span className="text-white/30 text-xs">-</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3 mt-4 py-2 px-1 border-t border-white/10">
              <div className="flex items-center gap-4 text-xs text-white/60">
                <span className="font-mono">
                  Showing {totalCount === 0 ? 0 : start + 1}–{Math.min(start + pageSize, totalCount)} of {totalCount}
                </span>
                <label className="flex items-center gap-2">
                  <span className="text-white/50">Rows per page</span>
                  <select
                    value={pageSize}
                    onChange={(e) => handlePageSizeChange(Number(e.target.value))}
                    className="bg-black/40 border border-white/20 rounded px-2 py-1 text-white/90 focus:outline-none focus:border-amber-500/50"
                  >
                    {TRADING_HISTORY_PAGE_SIZES.map((n) => (
                      <option key={n} value={n}>{n}</option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={safePage <= 1}
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded border border-white/10 bg-white/5 text-white/70 hover:bg-white/10 disabled:opacity-40 disabled:pointer-events-none text-xs font-medium"
                >
                  <ChevronLeft className="w-3.5 h-3.5" />
                  Previous
                </button>
                <span className="px-3 py-1.5 text-xs text-white/60 font-mono">
                  Page {safePage} of {totalPages}
                </span>
                <button
                  type="button"
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  disabled={safePage >= totalPages}
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded border border-white/10 bg-white/5 text-white/70 hover:bg-white/10 disabled:opacity-40 disabled:pointer-events-none text-xs font-medium"
                >
                  Next
                  <ChevronRight className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          </>
        )}
      </section>
    </main>
  );
}

function VaultProfitHistoryView({
  state,
  onBack,
}: {
  state: ColonyState;
  onBack: () => void;
}) {
  const entries = [...(state.vaultProfitHistory ?? [])].sort((a, b) => b.t - a.t);
  const totalUsdc = entries.reduce((s, e) => s + (e.amountUsdc ?? e.amount), 0);

  return (
    <main className="max-w-[1600px] mx-auto p-6 space-y-6">
      <div className="flex items-center gap-4 mb-6">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-white/10 bg-white/5 hover:bg-white/10 text-white/80 text-sm font-medium transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to dashboard
        </button>
      </div>

      <section className="bg-[#0D0D0E] border border-white/5 rounded-2xl p-6">
        <div className="flex flex-wrap items-center justify-between gap-4 mb-6">
          <h1 className="text-xl font-bold text-white uppercase tracking-tight">Vault - Profit history</h1>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6 p-4 rounded-xl bg-white/5 border border-white/5">
          <div>
            <p className="text-[10px] text-white/40 uppercase font-bold tracking-wider">Total contributions</p>
            <p className="text-lg font-mono text-emerald-400">{formatNum(totalUsdc, 2)} USDC</p>
          </div>
          <div>
            <p className="text-[10px] text-white/40 uppercase font-bold tracking-wider">Contributions</p>
            <p className="text-lg font-mono text-white">{entries.length}</p>
          </div>
        </div>

        <h2 className="text-sm font-bold text-white/80 uppercase tracking-wider mb-3">Contribution list</h2>
        {entries.length === 0 ? (
          <p className="text-sm text-white/50 py-8">No profit contributions recorded yet.</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-white/10">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-white/10 bg-white/5">
                  <th className="px-4 py-3 text-[10px] font-bold text-white/50 uppercase tracking-wider">Time</th>
                  <th className="px-4 py-3 text-[10px] font-bold text-white/50 uppercase tracking-wider">From</th>
                  <th className="px-4 py-3 text-[10px] font-bold text-white/50 uppercase tracking-wider">Amount</th>
                  <th className="px-4 py-3 text-[10px] font-bold text-white/50 uppercase tracking-wider w-24">Tx</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry, i) => {
                  const fromName = entry.fromAgentId.startsWith('trader') || entry.fromAgentId.startsWith('flipper')
                    ? `Trader ${(entry.fromAgentId.replace(/^(trader|flipper)/, '') || '1').trim()}`
                    : entry.fromAgentId;
                  return (
                    <tr key={`${entry.t}-${entry.fromAgentId}-${i}`} className="border-b border-white/5 hover:bg-white/5">
                      <td className="px-4 py-3 font-mono text-white/80">
                        {new Date(entry.t).toLocaleString([], { dateStyle: 'short', timeStyle: 'medium', hour12: false })}
                      </td>
                      <td className="px-4 py-3 text-white/80">{fromName}</td>
                      <td className="px-4 py-3 font-mono text-emerald-400">+{formatNum(entry.amountUsdc ?? entry.amount, entry.amountUsdc != null ? 2 : 4)} USDC</td>
                      <td className="px-4 py-3">
                        {entry.signature ? (
                          <a
                            href={`https://solscan.io/tx/${entry.signature}?cluster=devnet`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 text-amber-400 hover:text-amber-300 text-xs"
                          >
                            <ExternalLink className="w-3 h-3" />
                            View
                          </a>
                        ) : (
                          <span className="text-white/30 text-xs">-</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}

export { SolPriceChart };
export default function App() {
  const [state, setState] = useState<ColonyState | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const logEndRef = useRef<HTMLDivElement>(null);
  const [showHelp, setShowHelp] = useState(false);
  const [adding, setAdding] = useState(false);
  const [addMessage, setAddMessage] = useState<string | null>(null);
  const [addError, setAddError] = useState<string | null>(null);
  const [strategy, setStrategy] = useState<Record<string, string>>({});
  const [traderPreset, setTraderPreset] = useState<string>('');
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteResult, setDeleteResult] = useState<{ agentId: string; claimedSol: number; error?: string } | null>(null);
  const [historyAgentId, setHistoryAgentId] = useState<string | null>(null);
  const [showProfitHistoryPage, setShowProfitHistoryPage] = useState(false);

  useEffect(() => {
    const fetchData = async () => {
      try {
        const res = await fetch('/api/state');
        const data = await res.json();
        setState(data);
      } catch (err) {
        console.error('Failed to fetch state:', err);
      }
    };

    fetchData();
    const interval = setInterval(fetchData, REFRESH_INTERVAL);
    return () => clearInterval(interval);
  }, []);

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(text);
    setTimeout(() => setCopied(null), 2000);
  };

  const deleteAgentAndClaim = async (agentId: string) => {
    setDeletingId(agentId);
    setDeleteResult(null);
    try {
      const res = await fetch(`/api/agents/${agentId}`, { method: 'DELETE' });
      const data = await res.json() as { claimedSol?: number; error?: string };
      if (!res.ok) throw new Error(data.error || 'Delete failed');
      setDeleteResult({ agentId, claimedSol: data.claimedSol ?? 0, error: data.error });
      if (!data.error) setTimeout(() => setDeleteResult(null), 5000);
    } catch (err) {
      setDeleteResult({
        agentId,
        claimedSol: 0,
        error: err instanceof Error ? err.message : String(err),
      });
      setTimeout(() => setDeleteResult(null), 5000);
    } finally {
      setDeletingId(null);
    }
  };

  const downloadAudit = async () => {
    try {
      const res = await fetch('/api/audit');
      const data = await res.json();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `audit-${data.sessionId || 'session'}.json`;
      a.click();
    } catch (err) {
      console.error('Audit download failed:', err);
    }
  };

  const submitAddAgents = async () => {
    setAddError(null);
    setAddMessage(null);
    setAdding(true);
    try {
      const count = 1;
      const payload: {
        role: 'trader';
        count: number;
        strategy: Record<string, number>;
      } = {
        role: 'trader' as const,
        count,
        strategy: {},
      };
      // Only send non-blank strategy fields so backend uses env defaults for omitted keys.
      Object.entries(strategy).forEach(([key, value]) => {
        if (value === undefined || value === '') return;
        if (key === 'vaultCut') {
          const parsed = parseFloat(String(value).trim().replace(/%$/, ''));
          if (!Number.isNaN(parsed)) {
            payload.strategy[key] = parsed > 1 ? parsed / 100 : parsed;
          }
          return;
        }
        const n = Number(value);
        if (!Number.isNaN(n)) {
          payload.strategy[key] = n;
        }
      });

      const res = await fetch('/api/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Request failed with status ${res.status}`);
      }
      const data = (await res.json()) as { createdIds?: string[] };
      if (data.createdIds && data.createdIds.length > 0) {
        setAddMessage(
          `Added ${data.createdIds.length} Trader agent(s): ${data.createdIds.join(
            ', '
          )}`
        );
      } else {
        setAddMessage('Agents added successfully.');
      }
    } catch (err) {
      setAddError(err instanceof Error ? err.message : String(err));
    } finally {
      setAdding(false);
    }
  };

  if (!state) {
    return (
      <div className="min-h-screen bg-[#0A0A0B] flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <div className="w-12 h-12 border-4 border-emerald-500/20 border-t-emerald-500 rounded-full animate-spin" />
          <p className="text-emerald-500/60 font-mono text-sm tracking-widest uppercase">Bringing agents online...</p>
        </div>
      </div>
    );
  }

  const uptime = Math.floor((Date.now() - state.startTime) / 1000);

  // Only show boot progress during the first BOOT_SECONDS; after that always show Last Action
  const bootProgress: number | null = uptime >= 0 && uptime < BOOT_SECONDS
    ? Math.max(0, Math.min(100, Math.floor((uptime / BOOT_SECONDS) * 100)))
    : null;

  const agentsEntries = Object.entries(state.agents) as [string, AgentEntry][];
  const capitalAgents = agentsEntries.filter(
    ([id]) => id === 'vault' || id === 'funder' || id === 'pool'
  );
  const traderAgents = agentsEntries.filter(
    ([id]) => id.startsWith('trader') || id.startsWith('flipper')
  );
  const otherAgents = agentsEntries.filter(
    ([id]) =>
      id !== 'vault' &&
      id !== 'funder' &&
      id !== 'pool' &&
      !id.startsWith('trader') && !id.startsWith('flipper')
  );

  return (
    <div className="min-h-screen bg-[#0A0A0B] text-[#E2E2E2] font-sans selection:bg-emerald-500/30">
      <header className="border-b border-white/5 bg-[#0D0D0E] sticky top-0 z-50 backdrop-blur-md">
        <div className="max-w-[1600px] mx-auto px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-8">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 bg-emerald-500 rounded-lg flex items-center justify-center shadow-[0_0_20px_rgba(16,185,129,0.3)]">
                <Cpu className="w-5 h-5 text-black" />
              </div>
              <div>
                <h1 className="text-lg font-bold tracking-tight text-white leading-none">AGENT ECONOMY</h1>
                <p className="text-[10px] text-emerald-500/60 font-mono tracking-widest uppercase mt-1">Solana Devnet v1.0.4</p>
              </div>
            </div>

            <div className="hidden md:flex items-center gap-6 border-l border-white/10 pl-8">
              <div className="flex flex-col">
                <span className="text-[10px] text-white/40 uppercase tracking-wider font-semibold">Block Height</span>
                <span className="font-mono text-sm text-emerald-400">{state.blockHeight.toLocaleString()}</span>
              </div>
              <div className="flex flex-col">
                <span className="text-[10px] text-white/40 uppercase tracking-wider font-semibold">SOL/USDC</span>
                <span className="font-mono text-sm text-white">${formatNum(state.oraclePrice, 2)}</span>
                <span className="text-[10px] text-white/40">USDC is the platform stablecoin</span>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-4">
            {state.dryRun && (
              <span className="px-2 py-1 bg-amber-500/10 text-amber-500 border border-amber-500/20 rounded text-[10px] font-bold uppercase tracking-widest">
                Dry Run Active
              </span>
            )}
            <button
              onClick={() => setShowHelp(true)}
              className="hidden md:inline-flex items-center gap-1.5 px-3 py-1.5 bg-white/5 hover:bg-white/10 border border-white/10 rounded-lg text-[10px] font-medium uppercase tracking-widest text-white/70 transition-all active:scale-95"
            >
              <Info className="w-3.5 h-3.5 text-emerald-400" />
              How this dashboard works
            </button>
            <button
              onClick={downloadAudit}
              className="flex items-center gap-2 px-4 py-2 bg-white/5 hover:bg-white/10 border border-white/10 rounded-lg text-xs font-medium transition-all active:scale-95"
            >
              <Download className="w-3.5 h-3.5" />
              Audit Log
            </button>
          </div>
        </div>
      </header>

      {historyAgentId ? (
        <TraderHistoryView
          agentId={historyAgentId}
          state={state}
          onBack={() => setHistoryAgentId(null)}
        />
      ) : showProfitHistoryPage && state ? (
        <VaultProfitHistoryView state={state} onBack={() => setShowProfitHistoryPage(false)} />
      ) : (
      <main className="max-w-[1600px] mx-auto p-6 space-y-6">
        {/* SOL price chart (TradingView Lightweight Charts) with buy/sell markers */}
        <LightweightSolChart
          priceHistory={state.priceHistory ?? []}
          trades={state.trades ?? []}
          currentPrice={state.oraclePrice}
          startTime={state.startTime}
          totalSupply={state.totalSupply ?? 1e6}
        />

        {/* Scaling control panel: add more agents (styled but familiar layout) */}
        <section className="bg-[#0D0D0E] border border-white/5 rounded-2xl p-4 space-y-3">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-xl bg-emerald-500/10 border border-emerald-500/40 flex items-center justify-center">
                <Cpu className="w-4 h-4 text-emerald-400" />
              </div>
              <div>
                <h2 className="text-xs font-bold uppercase tracking-widest text-white/80">
                  Scale the colony
                </h2>
                <p className="text-[11px] text-white/40">
                  Add more traders - set strategy and count; we&apos;ll spin them up with the same safety rails.
                </p>
              </div>
            </div>
            <div className="hidden md:flex items-center gap-2 text-[11px] text-white/40">
              <span className="uppercase tracking-widest font-bold">Active agents</span>
              <span className="px-2 py-1 rounded-full bg-white/5 font-mono text-white/70">
                {Object.keys(state.agents).length}
              </span>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 items-end">
            <div className="space-y-1">
                  <label className="text-[10px] text-white/40 uppercase font-bold tracking-wider">
                    <span className="flex items-center gap-1">
                      <span>Preset</span>
                      <span className="cursor-help text-white/40 hover:text-emerald-400" title="Pre-fills trade size and min spread to trade."><Info className="w-3 h-3" /></span>
                    </span>
                  </label>
                  <div className="relative">
                    <select
                      value={traderPreset}
                      onChange={(e) => {
                        const key = e.target.value;
                        setTraderPreset(key);
                        if (key && TRADER_PRESETS[key]) {
                          const p = TRADER_PRESETS[key];
                          setStrategy((s) => ({ ...s, tradeAmountSol: String(p.tradeAmountSol), spreadThreshold: String(p.spreadThreshold) }));
                        }
                      }}
                      className="w-full appearance-none bg-black/40 border border-white/10 rounded-lg px-2 py-1.5 text-[11px] text-white focus:outline-none focus:border-emerald-400 focus:ring-1 focus:ring-emerald-500/40 pr-6"
                    >
                      <option value="">Custom</option>
                      <option value="conservative">Conservative</option>
                      <option value="balanced">Balanced</option>
                      <option value="aggressive">Aggressive</option>
                    </select>
                    <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-white/30 text-[10px]">▼</span>
                  </div>
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] text-white/40 uppercase font-bold tracking-wider">
                    <span className="flex items-center gap-1">
                      <span>Trade Size (SOL)</span>
                      <span className="cursor-help text-white/40 hover:text-emerald-400" title="SOL amount per trade."><Info className="w-3 h-3" /></span>
                    </span>
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    placeholder="0.05"
                    value={strategy.tradeAmountSol ?? ''}
                    onChange={(e) => { setTraderPreset(''); setStrategy((s) => ({ ...s, tradeAmountSol: e.target.value })); }}
                    className="w-full bg-black/40 border border-white/10 rounded-lg px-2 py-1.5 text-[11px] text-white focus:outline-none focus:border-emerald-400 focus:ring-1 focus:ring-emerald-500/40"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] text-white/40 uppercase font-bold tracking-wider">
                    <span className="flex items-center gap-1">
                      <span>Min spread to trade</span>
                      <span className="cursor-help text-white/40 hover:text-emerald-400" title="Only trade when the gap between the best buy price and best sell price is at least this size (e.g. 0.0005 = 0.05%). If the gap is smaller, the agent waits and avoids tiny, unprofitable trades."><Info className="w-3 h-3" /></span>
                    </span>
                  </label>
                  <input
                    type="number"
                    step="0.0001"
                    placeholder="0.0005"
                    value={strategy.spreadThreshold ?? ''}
                    onChange={(e) => { setTraderPreset(''); setStrategy((s) => ({ ...s, spreadThreshold: e.target.value })); }}
                    className="w-full bg-black/40 border border-white/10 rounded-lg px-2 py-1.5 text-[11px] text-white focus:outline-none focus:border-emerald-400 focus:ring-1 focus:ring-emerald-500/40"
                  />
                </div>
          </div>

          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3 pt-2">
            <button
              onClick={submitAddAgents}
              disabled={adding}
              className="inline-flex items-center justify-center gap-2 px-4 py-2.5 bg-emerald-500/90 hover:bg-emerald-500 text-black text-xs font-bold uppercase tracking-widest rounded-lg disabled:opacity-50 disabled:cursor-not-allowed transition-all active:scale-95"
            >
              {adding ? 'Adding agents…' : 'Add agents to colony'}
            </button>
            <div className="space-y-1 text-[11px]">
              {addMessage && (
                <p className="text-emerald-400 leading-snug">{addMessage}</p>
              )}
              {addError && (
                <p className="text-rose-400 leading-snug">Error: {addError}</p>
              )}
              {!addMessage && !addError && (
                <p className="text-white/35">
                  New agents are created with HD-derived wallets and appear in the sections below
                  as soon as they start ticking.
                </p>
              )}
            </div>
          </div>
        </section>
        {/* Legacy: log + safety guardrails UI (hidden) */}
        {false && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 bg-[#0D0D0E] border border-white/5 rounded-2xl flex flex-col h-[700px]">
            <div className="p-4 border-b border-white/5 flex items-center justify-between bg-white/[0.02]">
              <div className="flex items-center gap-2">
                <Terminal className="w-4 h-4 text-emerald-500" />
                <h3 className="text-xs font-bold uppercase tracking-widest text-white/80">Log</h3>
              </div>
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 bg-emerald-500 rounded-full animate-pulse" />
                <span className="text-[10px] font-mono text-emerald-500/60 uppercase">Stream</span>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto overflow-x-hidden p-4 font-mono text-xs space-y-2 custom-scrollbar">
              <AnimatePresence initial={false}>
                {state!.logs.slice().reverse().map((log, i) => (
                  <motion.div
                    key={`${log.timestamp}-${i}`}
                    initial={{ opacity: 0, x: -10 }}
                    animate={{ opacity: 1, x: 0 }}
                    className="flex gap-4 group items-start min-w-0"
                  >
                    <span className="text-white/20 shrink-0">{new Date(log.timestamp).toLocaleTimeString([], { hour12: false })}</span>
                    <span className={`shrink-0 uppercase font-bold w-24 ${
                      log.agentId === 'funder' ? 'text-violet-400' :
                      log.agentId === 'pool' ? 'text-blue-400' :
                      (log.agentId.startsWith('trader') || log.agentId.startsWith('flipper')) ? 'text-amber-400' :
                      'text-emerald-400'
                    }`}>[{log.agentId}]</span>
                    <span className={`flex-1 min-w-0 break-words block ${logMessageColorClass(log)}`}>
                      {log.type === 'trade' ? formatLogMessage(log.message) : log.message}
                    </span>
                    {log.signature ? (
                      <a
                        href={SOLSCAN_TX(log.signature)}
                        target="_blank"
                        rel="noreferrer"
                        className="shrink-0 text-white/40 hover:text-emerald-400 transition-colors p-0.5 rounded flex-shrink-0"
                        title="View on Solscan"
                      >
                        <ExternalLink className="w-3.5 h-3.5" />
                      </a>
                    ) : null}
                  </motion.div>
                ))}
              </AnimatePresence>
              <div ref={logEndRef} />
            </div>
          </div>

          <div className="bg-[#0D0D0E] border border-white/5 rounded-2xl flex flex-col h-[700px]">
            <div className="p-4 border-b border-white/5 flex items-center gap-2 bg-white/[0.02]">
              <Shield className="w-4 h-4 text-amber-500" />
              <h3 className="text-xs font-bold uppercase tracking-widest text-white/80">Safety Guardrails</h3>
            </div>

            <div className="p-6 space-y-6">
              <div className="flex items-center justify-between p-4 bg-amber-500/5 border border-amber-500/10 rounded-xl">
                <div>
                  <p className="text-[10px] text-amber-500/60 uppercase font-bold tracking-wider">Blocked Transactions</p>
                  <p className="text-2xl font-bold text-amber-500">{state!.blockedCount}</p>
                </div>
                <AlertTriangle className="w-8 h-8 text-amber-500/20" />
              </div>

              <div className="space-y-4 max-h-[320px] overflow-y-auto pr-1 custom-scrollbar">
                <h4 className="text-[10px] text-white/40 uppercase font-bold tracking-widest">Recent Interventions</h4>
                {state!.blockedReasons.length === 0 ? (
                  <p className="text-xs text-white/20 italic">No safety triggers detected...</p>
                ) : (
                  <div className="space-y-3">
                    {state!.blockedReasons.slice().reverse().map((reason, i) => (
                      <div key={i} className="p-3 bg-white/5 border border-white/5 rounded-lg space-y-1">
                        <div className="flex items-center justify-between">
                          <span className="text-[10px] font-bold text-amber-500 uppercase">{reason.agentId}</span>
                          <span className="text-[10px] text-white/20 font-mono">{new Date(reason.timestamp).toLocaleTimeString()}</span>
                        </div>
                        <p className="text-xs text-white/60 leading-relaxed">{reason.reason}</p>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
        )}

        {/* Treasury, Funding & Pool: vault + funder + pool on one line */}
        {capitalAgents.length > 0 && (
          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-xs font-bold uppercase tracking-widest text-white/60">
                Treasury, Funding &amp; Pool
              </h2>
              <span className="text-[10px] font-mono text-white/30">
                Vault, funder, and liquidity pool - capital and reserve.
              </span>
            </div>
            <div className={`grid gap-6 ${gridColsFor(capitalAgents.length)}`}>
              {capitalAgents.map(([id, agent]) => (
                <AgentCard
                  key={id}
                  id={id}
                  agent={agent}
                  onCopy={copyToClipboard}
                  copied={copied}
                  bootProgress={bootProgress}
                  vaultProfitHistory={id === 'vault' ? (state.vaultProfitHistory ?? []) : undefined}
                  onOpenProfitHistory={id === 'vault' ? () => setShowProfitHistoryPage(true) : undefined}
                  oraclePrice={state.oraclePrice}
                />
              ))}
            </div>
          </section>
        )}

        {/* Traders */}
        {(traderAgents.length > 0 || (deleteResult && (deleteResult.agentId.startsWith('trader') || deleteResult.agentId.startsWith('flipper')))) && (
          <section className="space-y-3">
            {deleteResult && (deleteResult.agentId.startsWith('trader') || deleteResult.agentId.startsWith('flipper')) && (
              <div className={`rounded-lg border px-4 py-2 text-sm font-mono ${deleteResult.error ? 'bg-rose-500/10 border-rose-500/30 text-rose-400' : 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'}`}>
                {deleteResult.error
                  ? `Delete ${deleteResult.agentId}: ${deleteResult.error}`
                  : `Removed ${deleteResult.agentId}; claimed ${formatNum(deleteResult.claimedSol, 4)} SOL to funder.`}
              </div>
            )}
            <div className="flex items-center justify-between">
              <h2 className="text-xs font-bold uppercase tracking-widest text-white/60">
                Traders
              </h2>
              <span className="text-[10px] font-mono text-white/30">
                Spread / volatility-driven swap agents.
              </span>
            </div>
            <div className={`grid gap-6 ${gridColsFor(traderAgents.length)}`}>
              {traderAgents.map(([id, agent]) => (
                <AgentCard
                  key={id}
                  id={id}
                  agent={agent}
                  onCopy={copyToClipboard}
                  copied={copied}
                  bootProgress={bootProgress}
                  onDelete={deleteAgentAndClaim}
                  deletingId={deletingId}
                  onOpenHistory={setHistoryAgentId}
                  oraclePrice={state.oraclePrice}
                />
              ))}
            </div>
          </section>
        )}

        {/* Other utility agents, if any */}
        {otherAgents.length > 0 && (
          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-xs font-bold uppercase tracking-widest text-white/60">
                Utility Agents
              </h2>
              <span className="text-[10px] font-mono text-white/30">
                Supporting processes and helpers.
              </span>
            </div>
            <div className={`grid gap-6 ${gridColsFor(otherAgents.length)}`}>
              {otherAgents.map(([id, agent]) => (
                <AgentCard
                  key={id}
                  id={id}
                  agent={agent}
                  onCopy={copyToClipboard}
                  copied={copied}
                  bootProgress={bootProgress}
                  oraclePrice={state.oraclePrice}
                />
              ))}
            </div>
          </section>
        )}
      </main>
      )}

      <style>{`
        .custom-scrollbar::-webkit-scrollbar {
          width: 4px;
        }
        .custom-scrollbar::-webkit-scrollbar-track {
          background: transparent;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb {
          background: rgba(255, 255, 255, 0.05);
          border-radius: 10px;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover {
          background: rgba(255, 255, 255, 0.1);
        }
      `}</style>
      {/* Help overlay */}
      {showHelp && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="bg-[#0D0D0E] border border-white/10 rounded-2xl max-w-lg w-full mx-4 shadow-2xl">
            <div className="flex items-center justify-between px-5 py-4 border-b border-white/10">
              <div className="flex items-center gap-2">
                <div className="w-7 h-7 rounded-full bg-emerald-500/10 flex items-center justify-center">
                  <Info className="w-4 h-4 text-emerald-400" />
                </div>
                <div>
                  <p className="text-xs font-bold uppercase tracking-widest text-white/80">
                    How to read this dashboard
                  </p>
                  <p className="text-[11px] text-white/40">
                    Quick orientation for judges and operators.
                  </p>
                </div>
              </div>
              <button
                onClick={() => setShowHelp(false)}
                className="text-white/30 hover:text-white/70 text-xs font-mono uppercase tracking-widest"
              >
                Close
              </button>
            </div>
            <div className="px-5 py-4 space-y-3 text-[11px] text-white/70">
              <p>
                <span className="font-semibold text-white">Layout</span> - <strong>Treasury, Funding &amp; Pool</strong>: vault (receives trader profits), funder (you send SOL here; it distributes to agents), and pool (liquidity reserve). <strong>Traders</strong>: spread-based swap agents that trade SOL vs USDC (when configured) and can send realized profit to the vault. USDC is the platform&apos;s stablecoin.
              </p>
              <p>
                <span className="font-semibold text-white">Cards</span> - Each card shows that agent&apos;s SOL balance and, where applicable, USDC balance (pool, funder, traders). Traders also show volume, P&amp;L (realized/unrealized), and a link to trading history. Vault shows USDC balance and profit history.
              </p>
              <p>
                <span className="font-semibold text-white">Colors</span> - Blue = pool, amber = traders, emerald = vault, violet = funder. The thin bar at the top of each card uses the same color so you can scan roles quickly.
              </p>
              <p>
                <span className="font-semibold text-white">Last Action</span> - At the bottom of each card: the agent&apos;s most recent decision or executed trade. During startup, a progress bar appears while agents boot and fetch state.
              </p>
              <p>
                <span className="font-semibold text-white">Scale the colony</span> - Add more traders only. Set preset (or custom trade size and min spread to trade), then click &quot;Add agents to colony&quot;. New traders get HD-derived wallets and the same safety rails (simulate before send, rate limits).
              </p>
              <p>
                <span className="font-semibold text-white">Deleting a trader</span> - Use &quot;Delete &amp; claim&quot; on a trader card to remove that agent and sweep its SOL to the funder. Dynamic traders can be added or removed; vault, funder, and pool are fixed.
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

type AgentEntry = { stats: AgentStats; wallet: WalletInfo | null };

function AgentCard({
  id,
  agent,
  onCopy,
  copied,
  bootProgress,
  vaultProfitHistory,
  onDelete,
  deletingId,
  onOpenHistory,
  onOpenProfitHistory,
  oraclePrice,
}: {
  id: string;
  agent: AgentEntry;
  onCopy: (t: string) => void;
  copied: string | null;
  bootProgress: number | null;
  vaultProfitHistory?: Array<{ t: number; fromAgentId: string; amount: number; amountUsdc?: number; signature?: string }>;
  onDelete?: (agentId: string) => Promise<void>;
  deletingId?: string | null;
  onOpenHistory?: (agentId: string) => void;
  onOpenProfitHistory?: () => void;
  oraclePrice?: number | null;
}) {
  const pnlUSD = agent.stats.pnlUSD;
  const unrealizedPnlUSD = agent.stats.unrealizedPnlUSD;
  const totalPnlUSD = (pnlUSD ?? 0) + (unrealizedPnlUSD ?? 0);
  const isPositive = (pnlUSD ?? 0) >= 0;
  const isTotalPositive = totalPnlUSD >= 0;

  const isPool = id === 'pool';
  const isTrader = id.startsWith('trader') || id.startsWith('flipper');

  const accentClass = isPool
    ? 'bg-blue-500/50'
    : isTrader
    ? 'bg-amber-500/50'
    : 'bg-emerald-500/50';

  const iconBgClass = isPool
    ? 'bg-blue-500/10 border-blue-500/20'
    : isTrader
    ? 'bg-amber-500/10 border-amber-500/20'
    : 'bg-emerald-500/10 border-emerald-500/20';

  const iconColorClass = isPool
    ? 'text-blue-500'
    : isTrader
    ? 'text-amber-500'
    : 'text-emerald-500';

  const labelClass = isPool
    ? 'text-blue-500/60'
    : isTrader
    ? 'text-amber-500/60'
    : 'text-emerald-500/60';

  const Icon = isPool ? Activity : isTrader ? Zap : Shield;

  let displayName = id;
  if (isPool) {
    displayName = 'Pool';
  } else if (isTrader) {
    const numericSuffix = id.replace(/^(trader|flipper)/, '');
    const index = numericSuffix === '' ? 1 : parseInt(numericSuffix, 10);
    displayName = `Trader ${Number.isNaN(index) ? '' : index}`.trim();
  }

  const agentInfoTooltip =
    id === 'vault'
      ? 'Treasury. Receives USDC profit from traders and holds realized profits so they are not lost.'
      : id === 'funder'
        ? 'Reserve holder. Send SOL here; it distributes SOL and USDC to the pool and traders. Top up the funder to fund new traders and the pool.'
        : id === 'pool'
          ? 'Liquidity reserve. Holds SOL and USDC for traders to swap against. Topped up by the funder.'
          : isTrader
            ? 'Spread-based swap agent. Trades SOL vs USDC with the pool and sends realized profit to the vault.'
            : '';

  const addr = agent.wallet?.address ?? '';
  const shouldShowBoot =
    bootProgress !== null &&
    agent.stats.totalTrades === 0 &&
    agent.stats.totalVolumeSOL === 0;

  return (
    <div className="bg-[#0D0D0E] border border-white/5 rounded-2xl p-6 relative overflow-hidden group">
      <div className={`absolute top-0 left-0 right-0 h-1 ${accentClass}`} />

      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className={`w-10 h-10 rounded-xl flex items-center justify-center border ${iconBgClass}`}>
            <Icon className={`w-5 h-5 ${iconColorClass}`} />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-bold text-white uppercase tracking-tight">{displayName}</h2>
              {agentInfoTooltip && (
                <span
                  className="cursor-help text-white/40 hover:text-white transition-colors shrink-0"
                  title={agentInfoTooltip}
                >
                  <Info className="w-3.5 h-3.5" />
                </span>
              )}
            </div>
            <p className={`text-[10px] font-mono ${labelClass}`}>Autonomous Unit</p>
          </div>
        </div>
        {onDelete && isTrader && (
          <button
            type="button"
            onClick={() => onDelete(id)}
            disabled={deletingId === id}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-rose-500/30 bg-rose-500/10 text-rose-400 hover:bg-rose-500/20 text-[10px] font-bold uppercase tracking-widest disabled:opacity-50 disabled:cursor-not-allowed transition-all"
            title="Delete agent and send its SOL balance to the funder wallet"
          >
            <Trash2 className="w-3.5 h-3.5" />
            {deletingId === id ? 'Claiming…' : 'Delete & claim'}
          </button>
        )}
      </div>

      <div className="space-y-4">
        <div>
          <p className="text-3xl font-bold text-white tracking-tighter">{agent.wallet?.solBalance != null ? formatNum(agent.wallet.solBalance, 3) : '0.000'} <span className="text-lg text-white/40">SOL</span></p>
          <div className="flex items-center gap-2 mt-1">
            <span className="text-[10px] font-mono text-white/40 truncate max-w-[120px]">{addr}</span>
            <button onClick={() => onCopy(addr)} className="text-white/20 hover:text-white transition-colors">
              {copied === addr ? <Check className="w-3 h-3 text-emerald-500" /> : <Copy className="w-3 h-3" />}
            </button>
            <a href={`https://solscan.io/account/${addr}?cluster=devnet`} target="_blank" rel="noreferrer" className="text-white/20 hover:text-white transition-colors">
              <ExternalLink className="w-3 h-3" />
            </a>
          </div>
        </div>

        {id === 'pool' && (
          <div className="grid grid-cols-2 gap-4 pt-4 border-t border-white/5">
            <div>
              <p className="text-[10px] text-white/40 uppercase font-bold tracking-wider">USDC Balance</p>
              <p className="text-sm font-mono text-white" title="On-chain USDC balance (from wallet).">
                {formatNum(agent.wallet?.usdcBalance ?? 0, 2)}
              </p>
            </div>
          </div>
        )}

        {id !== 'vault' && id !== 'pool' && (
          <div className="grid grid-cols-2 gap-4 pt-4 border-t border-white/5">
            {id !== 'funder' && (
              <div>
                <p className="text-[10px] text-white/40 uppercase font-bold tracking-wider">
                  {oraclePrice != null && oraclePrice > 0 ? 'Volume ($)' : 'Volume'}
                </p>
                <p className="text-sm font-mono text-white">
                  {oraclePrice != null && oraclePrice > 0
                    ? `$${formatNum(agent.stats.totalVolumeSOL * oraclePrice, 2)}`
                    : `${formatNum(agent.stats.totalVolumeSOL, 2)} SOL`}
                </p>
              </div>
            )}
            {(id.startsWith('trader') || id.startsWith('flipper') || id === 'funder') && (
              <div>
                <p className="text-[10px] text-white/40 uppercase font-bold tracking-wider">USDC Balance</p>
                <p className="text-sm font-mono text-white" title="On-chain USDC balance (from wallet).">
                  {formatNum(agent.wallet?.usdcBalance ?? 0, 2)}
                </p>
              </div>
            )}
            {id !== 'funder' && (
              <div className="col-span-2 space-y-1">
                <p className="text-[10px] text-white/40 uppercase font-bold tracking-wider flex items-center gap-1">
                  <span>P&L</span>
                  <span
                    className="cursor-help text-white/40 hover:text-emerald-400"
                    title="Realized = locked-in from sells (minus gas) − cost of buys (incl. gas + DEX fees). Unrealized = (current price − avg entry) × position SOL (paper). Total = Realized + Unrealized."
                  >
                    <Info className="w-3 h-3" />
                  </span>
                </p>
                {isTrader && (unrealizedPnlUSD != null || pnlUSD != null) ? (
                  <div className="grid grid-cols-3 gap-2 text-[10px]">
                    <div>
                      <p className="text-white/50 uppercase">Realized</p>
                      <p className={`font-mono ${(pnlUSD ?? 0) >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                        {pnlUSD != null ? ((pnlUSD >= 0 ? '+' : '') + '$' + formatNum(pnlUSD, 2)) : '-'}
                      </p>
                    </div>
                    <div>
                      <p className="text-white/50 uppercase">Unrealized</p>
                      <p className={`font-mono ${(unrealizedPnlUSD ?? 0) >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                        {unrealizedPnlUSD != null ? ((unrealizedPnlUSD >= 0 ? '+' : '') + '$' + formatNum(unrealizedPnlUSD, 2)) : '-'}
                      </p>
                    </div>
                    <div>
                      <p className="text-white/50 uppercase">Total</p>
                      <p className={`font-mono ${isTotalPositive ? 'text-emerald-400' : 'text-rose-400'}`}>
                        {(isTotalPositive ? '+' : '') + '$' + formatNum(totalPnlUSD, 2)}
                      </p>
                    </div>
                  </div>
                ) : (
                  <p className={`text-sm font-mono ${isPositive ? 'text-emerald-400' : 'text-rose-400'}`}>
                    {pnlUSD != null ? (isPositive ? '+' : '') + '$' + formatNum(pnlUSD, 2) : '-'}
                  </p>
                )}
              </div>
            )}
            {isTrader && onOpenHistory && (
              <div className="col-span-2 pt-2 border-t border-white/5">
                <button
                  type="button"
                  onClick={() => onOpenHistory(id)}
                  className="inline-flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-widest text-amber-400 hover:text-amber-300 transition-colors"
                >
                  <History className="w-3.5 h-3.5" />
                  View Trading history
                </button>
              </div>
            )}
          </div>
        )}

        {id === 'vault' && (
          <>
            <div className="grid grid-cols-2 gap-4 pt-4 border-t border-white/5">
              <div>
                <p className="text-[10px] text-white/40 uppercase font-bold tracking-wider">USDC Balance</p>
                <p className="text-sm font-mono text-emerald-400">{formatNum(agent.wallet?.usdcBalance ?? 0, 2)} USDC</p>
              </div>
            </div>
            {(vaultProfitHistory?.length ?? 0) > 0 && (
              <div className="pt-4 border-t border-white/5">
                <div className="flex items-center justify-between mb-2">
                  <p className="text-[10px] text-white/40 uppercase font-bold tracking-wider">Profit history</p>
                  {onOpenProfitHistory && (
                    <button
                      type="button"
                      onClick={onOpenProfitHistory}
                      className="inline-flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-widest text-emerald-400 hover:text-emerald-300 transition-colors"
                    >
                      <History className="w-3.5 h-3.5" />
                      View Profit history
                    </button>
                  )}
                </div>
                <div className="max-h-32 overflow-y-auto rounded-lg border border-white/10 bg-white/5">
                  <table className="w-full text-left text-xs">
                    <thead>
                      <tr className="border-b border-white/10 text-white/50">
                        <th className="px-2 py-1.5 font-bold">Time</th>
                        <th className="px-2 py-1.5 font-bold">From</th>
                        <th className="px-2 py-1.5 font-bold">Amount</th>
                        <th className="px-2 py-1.5 font-bold w-12">Tx</th>
                      </tr>
                    </thead>
                    <tbody>
                      {[...(vaultProfitHistory ?? [])]
                        .sort((a, b) => b.t - a.t)
                        .slice(0, 20)
                        .map((entry, i) => {
                          const fromName = entry.fromAgentId.startsWith('trader') || entry.fromAgentId.startsWith('flipper')
                            ? `Trader ${(entry.fromAgentId.replace(/^(trader|flipper)/, '') || '1').trim()}`
                            : entry.fromAgentId;
                          return (
                            <tr key={`${entry.t}-${entry.fromAgentId}-${i}`} className="border-b border-white/5">
                              <td className="px-2 py-1.5 font-mono text-white/70">
                                {new Date(entry.t).toLocaleString([], { dateStyle: 'short', timeStyle: 'short', hour12: false })}
                              </td>
                              <td className="px-2 py-1.5 text-white/80">{fromName}</td>
                              <td className="px-2 py-1.5 font-mono text-emerald-400">
                                +{formatNum(entry.amountUsdc ?? entry.amount, entry.amountUsdc != null ? 2 : 4)} USDC
                              </td>
                              <td className="px-2 py-1.5">
                                {entry.signature ? (
                                  <a
                                    href={`https://solscan.io/tx/${entry.signature}?cluster=devnet`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-amber-400 hover:text-amber-300 inline-flex"
                                  >
                                    <ExternalLink className="w-3 h-3" />
                                  </a>
                                ) : (
                                  <span className="text-white/30">-</span>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
            {id === 'vault' && onOpenProfitHistory && (vaultProfitHistory?.length ?? 0) === 0 && (
              <div className="pt-4 border-t border-white/5">
                <button
                  type="button"
                  onClick={onOpenProfitHistory}
                  className="inline-flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-widest text-emerald-400 hover:text-emerald-300 transition-colors"
                >
                  <History className="w-3.5 h-3.5" />
                  View Profit history
                </button>
              </div>
            )}
          </>
        )}

        <div className="pt-4">
          <div className="flex items-center gap-2 mb-2">
            <Clock className="w-3 h-3 text-white/20" />
            <span className="text-[10px] text-white/40 uppercase font-bold tracking-wider">Last Action</span>
          </div>
          {shouldShowBoot ? (
            <div className="bg-white/5 p-2 rounded-lg border border-white/5">
              <div className="flex items-center justify-between mb-1">
                <span className="text-[10px] text-white/40 uppercase tracking-wider font-bold">Bootstrapping</span>
                <span className="text-[10px] font-mono text-white/70">{bootProgress !== null ? bootProgress : 100}%</span>
              </div>
              <div className="h-1.5 w-full rounded-full bg-white/10 overflow-hidden">
                <div
                  className="h-full bg-emerald-500 transition-all"
                  style={{ width: `${bootProgress !== null ? bootProgress : 100}%` }}
                />
              </div>
            </div>
          ) : (
            <p className="text-xs text-white/80 bg-white/5 p-2 rounded-lg border border-white/5 italic title-case">
              {agent.stats.lastAction}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
