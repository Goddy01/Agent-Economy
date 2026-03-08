/**
 * WebDashboard - HTTP server and in-memory state for the colony UI.
 *
 * Serves / with an embedded HTML page that polls /api/state for agent stats,
 * logs, block height, price, vault balance, and safety (blocked count).
 * /api/audit returns sessionId, blockedReasons, signatures for judge download.
 * If dashboard-app/dist exists, static files are served from there instead.
 */
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import type { WalletInfo } from '../wallet/WalletManager';
import type { AgentStats } from '../agents/types';

const DASHBOARD_DIST = path.join(process.cwd(), 'dashboard-app', 'dist');
const MIMES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
};

export interface ColonyState {
  /** Dynamic agent list (e.g. vault, funder, pool, trader1..n). */
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
  /** SOL/USDC price samples over time for chart (t: timestamp, p: price). */
  priceHistory: Array<{ t: number; p: number }>;
  /** Agent buy/sell events for chart markers (t: timestamp, p: price at trade, signature for Solscan link). */
  trades: Array<{ t: number; agentId: string; side: 'buy' | 'sell'; p: number; amountSol?: number; amountToken?: number; signature?: string }>;
  /** Total supply for market cap display (from COLONY_TOKEN_TOTAL_SUPPLY). */
  totalSupply: number;
  /** Vault profit history: contributions from traders (time, fromAgentId, amount SOL or USDC, optional amountUsdc, optional tx signature). */
  vaultProfitHistory: Array<{ t: number; fromAgentId: string; amount: number; amountUsdc?: number; signature?: string }>;
}

interface AuditSignature {
  agentId: string;
  signature: string;
  description: string;
  timestamp: number;
}

/**
 * POST /api/agents body. Strategy keys:
 * - Trader: tradeAmountSol, spreadThreshold, tickMs (and optionally vaultCut).
 */
interface AddAgentsRequest {
  role: 'trader';
  count?: number;
  strategy?: Record<string, unknown>;
}

interface AddAgentsResponse {
  createdIds: string[];
}

interface RemoveAgentResponse {
  claimedSol: number;
  error?: string;
}

interface AgentManager {
  addAgents(payload: AddAgentsRequest): Promise<AddAgentsResponse>;
  removeAgent(agentId: string): Promise<RemoveAgentResponse>;
}

const PORT = parseInt(process.env.DASHBOARD_PORT ?? '3555', 10);
const REFRESH_MS = parseInt(process.env.DASHBOARD_REFRESH_MS ?? '5000', 10);
const VAULT_FLOOR = process.env.VAULT_FLOOR_SOL ?? '5.0';

const HTML_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>AI Agent Colony - Solana Devnet</title>
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
      background: #0d0e12;
      color: #e6edf3;
      margin: 0;
      padding: 0;
      min-height: 100vh;
    }
    .topbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 0.75rem;
      padding: 0.75rem 1.25rem;
      background: #161b22;
      border-bottom: 1px solid #30363d;
    }
    .topbar-left { display: flex; align-items: center; gap: 1rem; }
    .logo { font-size: 1.1rem; font-weight: 700; color: #fff; letter-spacing: 0.02em; }
    .topbar-right { display: flex; align-items: center; gap: 1rem; flex-wrap: wrap; }
    .topbar span { color: #8b949e; font-size: 0.875rem; }
    .topbar strong { color: #58a6ff; font-weight: 600; }
    .badge { padding: 0.2rem 0.5rem; border-radius: 6px; font-size: 0.75rem; font-weight: 600; background: #238636; color: #fff; }
    .badge.dry { background: #9e6a03; color: #fff; }
    .main { padding: 1.25rem; }
    .cards {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
      gap: 1rem;
      margin-bottom: 1.5rem;
    }
    .card {
      border: 1px solid #30363d;
      border-radius: 12px;
      padding: 1.25rem;
      background: #1a1d24;
    }
    .card.pool { border-left: 4px solid #79c0ff; }
    .card.trader { border-left: 4px solid #d29922; }
    .card.vault { border-left: 4px solid #3fb950; }
    .card.funder { border-left: 4px solid #a371f7; }
    .card.safety { border-left: 4px solid #d29922; }
    .card h2 { font-size: 0.75rem; margin: 0 0 0.75rem 0; text-transform: uppercase; letter-spacing: 0.05em; color: #8b949e; font-weight: 600; }
    .card.pool h2 { color: #79c0ff; }
    .card.trader h2 { color: #d29922; }
    .card.vault h2 { color: #3fb950; }
    .card.funder h2 { color: #a371f7; }
    .card .balance { font-size: 1.5rem; font-weight: 700; margin: 0 0 0.5rem 0; color: #e6edf3; }
    .card .row { color: #8b949e; font-size: 0.8125rem; margin: 0.25rem 0; }
    .card .addr-wrap { display: flex; align-items: center; gap: 0.35rem; margin-top: 0.5rem; font-size: 0.75rem; }
    .card .addr-wrap a { color: #58a6ff; text-decoration: none; }
    .card .addr-wrap a:hover { text-decoration: underline; }
    .copy-btn { background: none; border: none; padding: 0.2rem; cursor: pointer; color: #6e7681; border-radius: 4px; display: inline-flex; align-items: center; }
    .copy-btn:hover { color: #8b949e; background: #21262d; }
    .card .pnl-positive { color: #3fb950; }
    .card .pnl-negative { color: #f85149; }
    .log-box {
      background: #1a1d24;
      border: 1px solid #30363d;
      border-radius: 12px;
      overflow: hidden;
      max-height: 360px;
      display: flex;
      flex-direction: column;
    }
    .log-box h3 { margin: 0; padding: 0.75rem 1rem; font-size: 0.8125rem; font-weight: 600; color: #8b949e; text-transform: uppercase; letter-spacing: 0.05em; background: #161b22; border-bottom: 1px solid #30363d; }
    #logs { overflow-y: auto; max-height: 300px; }
    .log-table { width: 100%; border-collapse: collapse; font-size: 0.8125rem; }
    .log-table th { text-align: left; padding: 0.5rem 1rem; color: #8b949e; font-weight: 600; background: #161b22; border-bottom: 1px solid #30363d; }
    .log-table td { padding: 0.5rem 1rem; border-bottom: 1px solid #21262d; vertical-align: top; }
    .log-table th:nth-child(1), .log-table td:nth-child(1) { width: 6rem; color: #6e7681; }
    .log-table th:nth-child(2), .log-table td:nth-child(2) { width: 6rem; }
    .log-table .agent.decision { color: #e6edf3; }
    .log-table .agent.trade { color: #3fb950; }
    .log-table .agent.error { color: #f85149; }
    .log-table .agent.memo { color: #58a6ff; }
    /* Default message color (may be overridden inline for clarity per-agent) */
    .log-table .msg { color: #8b949e; }
    .log-table .msg .swap-failed .err { color: #f85149; }
    .log-table .msg .swap-failed .reason { color: #e6edf3; }
    .log-table .msg .swap-failed .detail { font-size: 0.75rem; color: #8b949e; }
    .log-table .msg .vault-amt { color: #3fb950; font-weight: 600; }
    .log-table .msg .sol-amt { color: #3fb950; font-weight: 600; }
    .log-table .msg .tok-amt { color: #d29922; font-weight: 600; }
    .log-table .log-tx { width: 4rem; }
    .log-table .log-tx-link { color: #58a6ff; text-decoration: none; }
    .log-table .log-tx-link:hover { text-decoration: underline; }
    .safety-list {
      margin-top: 0.5rem;
      font-size: 0.8125rem;
      color: #8b949e;
      max-height: 160px;
      overflow-y: auto;
      padding-right: 0.25rem;
    }
    .safety-list div { margin: 0.2rem 0; }
    .btn {
      padding: 0.4rem 0.75rem;
      border-radius: 8px;
      border: 1px solid #30363d;
      background: #21262d;
      color: #e6edf3;
      font-size: 0.8125rem;
      cursor: pointer;
      font-family: inherit;
    }
    .btn:hover { background: #30363d; }
    .chart-box {
      background: #1a1d24;
      border: 1px solid #30363d;
      border-radius: 12px;
      padding: 1rem;
      margin-bottom: 1rem;
    }
    .chart-box h3 { margin: 0 0 0.5rem 0; font-size: 0.75rem; font-weight: 600; color: #8b949e; text-transform: uppercase; letter-spacing: 0.05em; }
    .chart-box svg { max-width: 100%; height: auto; display: block; }
  </style>
</head>
<body>
  <header class="topbar">
    <div class="topbar-left">
      <span class="logo">Agent Colony</span>
      <span style="color:#6e7681;font-size:0.875rem;">Solana Blockchain</span>
    </div>
    <div class="topbar-right" id="header">
      <span>Block: <strong id="block">0</strong></span>
      <span>SOL/USDC: $<strong id="price">0.00</strong></span>
      <span>Up: <strong id="uptime">0m 0s</strong></span>
      <span class="badge" id="devnetBadge">DEVNET</span>
      <span class="badge dry" id="dryRun" style="display:none;">DRY RUN</span>
      <button class="btn" id="auditBtn">Download audit (JSON)</button>
    </div>
  </header>
  <div class="main">
    <div class="chart-box" id="price-chart-wrap">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.5rem;">
        <div id="chart-price-display" style="display:flex;align-items:center;gap:0.5rem;">
          <span id="chart-price" style="font-size:0.9rem;font-weight:700;color:#e6edf3;">--</span>
          <span id="chart-change" style="font-size:0.75rem;font-weight:500;">--</span>
        </div>
        <span style="font-size:0.65rem;color:#6e7681;">Green = buy · Amber = sell</span>
      </div>
      <p class="chart-hint" style="margin:0 0 0.5rem 0;font-size:0.7rem;color:#6e7681;">Click a marker to open the tx on Solscan.</p>
      <div id="price-chart"></div>
    </div>
    <div class="cards" id="cards"></div>
    <div class="log-box">
      <h3>Decision log</h3>
      <div id="logs">Waiting for agent decisions...</div>
    </div>
  </div>
  <script>
    const refreshMs = ${REFRESH_MS};
    function truncateAddr(addr) {
      if (!addr || addr === '...') return addr;
      if (addr.length <= 14) return addr;
      return addr.slice(0, 8) + '...' + addr.slice(-4);
    }
    function addrBlock(addr, link) {
      if (addr === '...' || !addr) return escapeHtml(addr);
      var short = truncateAddr(addr);
      var copySvg = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
      return '<span class="addr-wrap"><a href="' + link + '" target="_blank" rel="noopener" title="' + escapeHtml(addr) + '">' + escapeHtml(short) + '</a><button class="copy-btn" data-addr="' + escapeHtml(addr) + '" title="Copy address" type="button">' + copySvg + '</button></span>';
    }
    function render(state) {
      document.getElementById('block').textContent = state.blockHeight.toLocaleString();
      document.getElementById('price').textContent = state.oraclePrice.toFixed(2);
      const uptime = Math.floor((Date.now() - state.startTime) / 1000);
      document.getElementById('uptime').textContent = Math.floor(uptime/60) + 'm ' + (uptime % 60) + 's';
      document.getElementById('dryRun').style.display = state.dryRun ? 'inline' : 'none';

      var ph = state.priceHistory || [];
      var tr = state.trades || [];
      var w = 800, h = 220, pad = { t: 12, r: 12, b: 28, l: 48 };
      var cw = w - pad.l - pad.r, ch = h - pad.t - pad.b;
      var now = Date.now(), t0 = state.startTime, t1 = now, trange = Math.max(1, t1 - t0);
      var allP = [state.oraclePrice].concat(ph.map(function(d){ return d.p; }), tr.map(function(d){ return d.p; })).filter(function(p){ return p > 0; });
      var minP = allP.length ? Math.min.apply(null, allP) : state.oraclePrice * 0.98;
      var maxP = allP.length ? Math.max.apply(null, allP) : state.oraclePrice * 1.02;
      var pRange = Math.max(0.01, maxP - minP);
      var pMin = minP - pRange * 0.05, pMax = maxP + pRange * 0.05, pSpan = Math.max(0.01, pMax - pMin);
      function x(t) { return pad.l + ((t - t0) / trange) * cw; }
      function y(p) { return pad.t + ch - ((p - pMin) / pSpan) * ch; }
      var curX = x(now), curY = y(state.oraclePrice);
      var yTicks = [pMin, pMin + pSpan*0.25, pMin + pSpan*0.5, pMin + pSpan*0.75, pMax];
      var xTicks = [0, 0.25, 0.5, 0.75, 1].map(function(f){ return { x: pad.l + f * cw, t: t0 + f * trange }; });
      var priceChange = ph.length >= 2 ? ((state.oraclePrice - ph[0].p) / ph[0].p) * 100 : 0;
      var linePath = ph.length > 0 ? ph.map(function(d, i){ return (i === 0 ? 'M' : 'L') + ' ' + x(d.t) + ' ' + y(d.p); }).join(' ') : '';
      var areaPath = ph.length > 0 ? linePath + ' L ' + x(ph[ph.length-1].t) + ' ' + (pad.t + ch) + ' L ' + x(ph[0].t) + ' ' + (pad.t + ch) + ' Z' : '';
      document.getElementById('chart-price').textContent = '$' + state.oraclePrice.toFixed(2);
      var changeEl = document.getElementById('chart-change');
      changeEl.textContent = (priceChange >= 0 ? '+' : '') + priceChange.toFixed(2) + '%';
      changeEl.style.color = priceChange >= 0 ? '#3fb950' : '#f85149';
      var svg = '<svg width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '" style="max-width:100%;height:auto;"><defs><linearGradient id="priceLineGrad" x1="0" y1="1" x2="0" y2="0"><stop offset="0%" stop-color="#22c55e" stop-opacity="0.3"/><stop offset="100%" stop-color="#22c55e" stop-opacity="0"/></linearGradient></defs>';
      yTicks.forEach(function(p, i){ svg += '<line x1="' + pad.l + '" y1="' + y(p) + '" x2="' + (w-pad.r) + '" y2="' + y(p) + '" stroke="rgba(255,255,255,0.06)" stroke-width="1"/>'; });
      xTicks.forEach(function(tick){ svg += '<line x1="' + tick.x + '" y1="' + pad.t + '" x2="' + tick.x + '" y2="' + (pad.t + ch) + '" stroke="rgba(255,255,255,0.06)" stroke-width="1"/>'; });
      yTicks.forEach(function(p, i){ svg += '<text x="' + (pad.l-6) + '" y="' + (y(p)+4) + '" text-anchor="end" fill="#8b949e" font-size="10" font-family="monospace">$' + p.toFixed(2) + '</text>'; });
      xTicks.forEach(function(tick){ var label = new Date(tick.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }); svg += '<text x="' + tick.x + '" y="' + (h-6) + '" text-anchor="middle" fill="#8b949e" font-size="9" font-family="monospace">' + escapeHtml(label) + '</text>'; });
      svg += '<line x1="' + pad.l + '" y1="' + curY + '" x2="' + (w-pad.r) + '" y2="' + curY + '" stroke="rgba(255,255,255,0.12)" stroke-width="1" stroke-dasharray="4 2"/>';
      if (areaPath) svg += '<path d="' + areaPath + '" fill="url(#priceLineGrad)"/>';
      if (linePath) svg += '<path d="' + linePath + '" fill="none" stroke="#22c55e" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>';
      if (ph.length === 0) svg += '<circle cx="' + curX + '" cy="' + curY + '" r="4" fill="#3fb950"/>';
      function getMarker(id) {
        var emojis = { pool: '\u{1F4A7}', trader: '\u{1F438}', trader1: '\u{1F438}', trader2: '\u{1F436}', trader3: '\u{1F431}', trader4: '\u{1F98A}', flipper: '\u{1F438}', flipper2: '\u{1F436}', flipper3: '\u{1F431}' };
        if (emojis[id]) return emojis[id];
        var m = id.match(/^trader(\d+)$/);
        if (m) { var arr = ['\u{1F438}', '\u{1F436}', '\u{1F431}', '\u{1F98A}', '\u{1F435}', '\u{1F981}']; return arr[parseInt(m[1], 10) - 1] || 'T' + m[1]; }
        var f = id.match(/^flipper(\d+)$/);
        if (f) { var arr = ['\u{1F438}', '\u{1F436}', '\u{1F431}']; return arr[parseInt(f[1], 10) - 1] || 'T' + f[1]; }
        return id.slice(0, 2).toUpperCase();
      }
      var totalSupply = (state.totalSupply != null && state.totalSupply > 0) ? state.totalSupply : 1e6;
      tr.forEach(function(t, i) {
        var col = t.side === 'buy' ? '#22c55e' : '#f59e0b';
        var solAmt = t.amountSol != null ? t.amountSol.toFixed(4) : '?';
        var usdVal = t.amountSol != null ? t.amountSol * t.p : null;
        var usdStr = usdVal != null ? ' ($' + usdVal.toFixed(2) + ')' : '';
        var tooltipTitle = t.amountToken != null
          ? (t.side === 'buy'
            ? escapeHtml(t.agentId) + ' bought ' + solAmt + ' SOL @ $' + t.p.toFixed(2) + ' (MCap $' + (t.p * totalSupply).toFixed(0) + ')' + ' - paid $' + (t.amountToken * t.p).toFixed(2)
            : escapeHtml(t.agentId) + ' sold ' + solAmt + ' SOL @ $' + t.p.toFixed(2) + ' (MCap $' + (t.p * totalSupply).toFixed(0) + ')' + ' - received $' + (t.amountToken * t.p).toFixed(2))
          : (t.side === 'buy'
            ? escapeHtml(t.agentId) + ' bought ' + solAmt + ' SOL from Pool @ $' + t.p.toFixed(2) + usdStr
            : escapeHtml(t.agentId) + ' sold ' + solAmt + ' SOL to Pool @ $' + t.p.toFixed(2) + usdStr);
        var title = tooltipTitle + (t.signature ? ' - Click to view tx on Solscan' : '');
        var cx = x(t.t), cy = y(t.p);
        var marker = '<g><circle cx="' + cx + '" cy="' + cy + '" r="12" fill="' + col + '" stroke="rgba(0,0,0,0.4)" stroke-width="1.5" style="cursor:' + (t.signature ? 'pointer' : 'default') + '" title="' + title + '"/><text x="' + cx + '" y="' + cy + '" text-anchor="middle" dominant-baseline="central" font-size="12" style="pointer-events:none">' + getMarker(t.agentId) + '</text></g>';
        if (t.signature) {
          svg += '<a href="https://solscan.io/tx/' + escapeHtml(t.signature) + '?cluster=devnet" target="_blank" rel="noopener">' + marker + '</a>';
        } else {
          svg += marker;
        }
      });
      svg += '</svg>';
      document.getElementById('price-chart').innerHTML = svg;

      const agentIds = Object.keys(state.agents).sort(function(a, b) {
        if (a === 'vault') return 1;
        if (b === 'vault') return -1;
        return a.localeCompare(b);
      });
      function kind(id) {
        if (id === 'vault') return 'vault';
        if (id === 'funder') return 'funder';
        if (id === 'pool') return 'pool';
        return 'trader';
      }
      function displayName(id) {
        if (id === 'vault') return 'Vault';
        if (id === 'funder') return 'Funder (send SOL here)';
        if (id === 'pool') return 'Pool';
        return id.charAt(0).toUpperCase() + id.slice(1);
      }
      const cardsEl = document.getElementById('cards');
      let cardsHtml = agentIds.map(function(id) {
        const a = state.agents[id];
        if (!a) return '';
        const balance = a.wallet?.solBalance != null ? a.wallet.solBalance.toFixed(3) : '...';
        const agentKind = kind(id);
        const pnlUSD = a.stats.pnlUSD;
        const unrealizedPnlUSD = a.stats.unrealizedPnlUSD;
        const totalPnlUSD = (pnlUSD ?? 0) + (unrealizedPnlUSD ?? 0);
        const pnlClass = (pnlUSD ?? 0) >= 0 ? 'pnl-positive' : 'pnl-negative';
        const pnlSign = (pnlUSD ?? 0) >= 0 ? '+' : '';
        const addr = a.wallet?.address || '...';
        const addrLink = addr !== '...' ? ('https://solscan.io/account/' + encodeURIComponent(addr) + '?cluster=devnet') : '';
        const usdcBalance = a.wallet?.usdcBalance ?? 0;
        const pnlTitle = 'Realized = locked-in from sells − cost of buys (incl. gas + DEX fees). Unrealized = (current price − avg entry) × position (paper).';
        const pnlRow = agentKind === 'trader' && (unrealizedPnlUSD != null || pnlUSD != null)
          ? '<div class="row ' + pnlClass + '" title="' + pnlTitle + '">P&L: Realized ' + (pnlUSD != null ? pnlSign + '$' + pnlUSD.toFixed(2) : '-') + ' · Unrealized ' + (unrealizedPnlUSD != null ? ((unrealizedPnlUSD >= 0 ? '+' : '') + '$' + unrealizedPnlUSD.toFixed(2)) : '-') + ' · Total ' + (totalPnlUSD >= 0 ? '+' : '') + '$' + totalPnlUSD.toFixed(2) + '</div>'
          : '<div class="row ' + pnlClass + '" title="' + pnlTitle + '">P&L: ' + (pnlUSD != null ? pnlSign + '$' + pnlUSD.toFixed(2) : '-') + '</div>';
        const volPnlRows = id === 'vault'
          ? ''
          : agentKind === 'pool'
            ? ''
            : (
                '<div class="row">Vol: ' + a.stats.totalVolumeSOL.toFixed(3) + ' SOL</div>' +
                (agentKind === 'trader' ? '<div class="row">USDC: ' + usdcBalance.toFixed(2) + '</div>' : '') +
                (agentKind === 'funder'
                  ? '<div class="row">Outbound: ' + (a.stats.outboundSOL ?? 0).toFixed(4) + ' SOL</div>'
                  : pnlRow)
              );
        let strategyRow = '';
        if (agentKind === 'vault') {
          strategyRow = '<div class="row">Strategy: capital vault & safety floor.</div>';
        } else if (agentKind === 'funder') {
          strategyRow = '<div class="row">Strategy: fund devnet colony and vault.</div>';
        } else if (agentKind === 'pool') {
          strategyRow = '<div class="row">Strategy: liquidity reserve; profits come from here.</div>';
        } else if (agentKind === 'trader') {
          strategyRow = '<div class="row">Strategy: spread / volatility swaps; buy/sell SOL with USDC via pool.</div>';
        }
        return '<div class="card ' + kind(id) + '">' +
          '<h2>' + displayName(id) + '</h2>' +
          '<div class="balance">' + balance + ' SOL</div>' +
          '<div class="row">' + (addrLink ? addrBlock(addr, addrLink) : escapeHtml(addr)) + '</div>' +
          '<div class="row">Trades: ' + a.stats.totalTrades + '</div>' +
          volPnlRows +
          strategyRow +
          '<div class="row">→ Vault: ' + a.stats.vaultContributions.toFixed(4) + '</div>' +
          '</div>';
      }).join('');

      const vaultAgent = state.agents.vault;
      const vaultAddr = vaultAgent?.wallet?.address || '...';
      const vaultAddrLink = vaultAddr !== '...' ? ('https://solscan.io/account/' + encodeURIComponent(vaultAddr) + '?cluster=devnet') : '';
      const vaultReceived = vaultAgent?.stats?.vaultContributions ?? 0;
      const vaultTxns = vaultAgent?.stats?.totalTrades ?? 0;
      cardsHtml +=
        '<div class="card vault">' +
        '<h2>Vault status</h2>' +
        '<div class="balance">' + state.totalVaultBalance.toFixed(3) + ' SOL</div>' +
        '<div class="row">' + (vaultAddrLink ? addrBlock(vaultAddr, vaultAddrLink) : escapeHtml(vaultAddr)) + '</div>' +
        '<div class="row">Floor: ' + '${VAULT_FLOOR}' + ' SOL LOCKED</div>' +
        '<div class="row">Received: ' + vaultReceived.toFixed(4) + ' SOL</div>' +
        '<div class="row">Inbound txns: ' + vaultTxns + '</div>' +
        '</div>';

      const recentBlocked = (state.blockedReasons || []).slice(-5).reverse();
      let safetyListHtml;
      if (recentBlocked.length === 0) {
        safetyListHtml = '<div class="safety-list"><div>No blocked transactions yet.</div></div>';
      } else {
        safetyListHtml =
          '<div class="safety-list">' +
          recentBlocked.map(entry => {
            const time = new Date(entry.timestamp).toLocaleTimeString('en-US', { hour12: false });
            const msg = escapeHtml(entry.reason.substring(0, 80));
            return '<div>[' + time + '] ' + entry.agentId + ': ' + msg + '</div>';
          }).join('') +
          '</div>';
      }

      cardsHtml +=
        '<div class="card safety">' +
        '<h2>Safety guardrails</h2>' +
        '<div class="row">Blocked tx: ' + (state.blockedCount || 0) + '</div>' +
        safetyListHtml +
        '</div>';

      cardsEl.innerHTML = cardsHtml;

      const logs = state.logs.slice(-20).reverse();
      const logsEl = document.getElementById('logs');
      if (logs.length === 0) {
        logsEl.innerHTML = '<div style="padding:1rem;color:#8b949e;font-size:0.875rem;">Waiting for agent decisions...</div>';
      } else {
        logsEl.innerHTML = '<table class="log-table"><thead><tr><th>Time</th><th>Agent</th><th>Message</th><th>Tx</th></tr></thead><tbody>' +
          logs.map(entry => {
            const time = new Date(entry.timestamp).toLocaleTimeString('en-US', { hour12: false });
            const msgHtml = formatLogMsg(entry.message);
            const rawMsg = typeof entry.message === 'string' ? entry.message : '';
            const txCell = entry.signature
              ? '<a href="https://solscan.io/tx/' + escapeHtml(entry.signature) + '?cluster=devnet" target="_blank" rel="noopener" class="log-tx-link" title="View on Solscan">View</a>'
              : '-';
            // Decide message color:
            // - Profit / vault contributions → green
            // - Errors → red
            // - Trader decisions/trades → blue
            // - Accumulator decisions/trades → white
            let color = '#8b949e';
            const isProfit = /Sent\s+[\d.]+\s+SOL\s+to\s+vault\./i.test(rawMsg);
            const agentKind = entry.agentId === 'vault' ? 'vault' : entry.agentId === 'funder' ? 'funder' : entry.agentId === 'pool' ? 'pool' : 'trader';
            if (entry.type === 'error') {
              color = '#f85149';
            } else if (isProfit) {
              color = '#3fb950';
            } else if (agentKind === 'funder') {
              color = '#a371f7';
            } else if (agentKind === 'trader') {
              color = '#58a6ff';
            } else if (agentKind === 'pool') {
              color = '#79c0ff';
            }

            return '<tr><td>' + time + '</td><td class="agent ' + entry.type + '">' + escapeHtml(entry.agentId) + '</td><td class="msg" style="color:' + color + ';">' + msgHtml + '</td><td class="log-tx">' + txCell + '</td></tr>';
          }).join('') +
          '</tbody></table>';
      }
    }
    function formatLogMsg(message) {
      if (typeof message !== 'string') return '';
      var plain = message.length > 300 ? message.substring(0, 300) + '…' : message;
      if (!message.startsWith('{')) {
        plain = escapeHtml(plain)
          .replace(/(\\d+\\.?\\d{0,4})\\s*SOL/g, '<span class="sol-amt">$1 SOL</span>')
          .replace(/(\\d+\\.?\\d{0,2})\\s*tokens/g, '<span class="tok-amt">$1 tokens</span>');
        return plain;
      }
      try {
        const data = JSON.parse(message);
        if (data.type === 'VAULT_CONTRIBUTION') {
          const amount = data.amount != null ? Number(data.amount) : 0;
          const success = data.result && data.result.success !== false;
          return success
            ? 'Sent <span class="vault-amt">' + amount.toFixed(4) + ' SOL</span> to vault.'
            : 'Failed to send ' + amount.toFixed(4) + ' SOL to vault.' + (data.result && data.result.error ? ' ' + escapeHtml(data.result.error) : '');
        }
        if (data.type === 'SWAP_FAILED') {
          const reason = data.reason || (data.result && data.result.error) || 'Unknown';
          const r = data.result;
          let out = '<span class="swap-failed"><strong class="err">SWAP_FAILED</strong><br><span class="reason">' + escapeHtml(reason) + '</span>';
          if (r) {
            const parts = [];
            if (r.success === false) parts.push('success: false');
            if (r.inputAmount != null) parts.push('in: ' + r.inputAmount + ' SOL');
            if (r.outputAmount != null) parts.push('out: ' + r.outputAmount + ' SOL');
            if (r.simulated !== undefined) parts.push('simulated: ' + r.simulated);
            if (r.error && r.error !== reason) parts.push(escapeHtml(r.error));
            if (parts.length) out += '<br><span class="detail">' + escapeHtml(parts.join(' · ')) + '</span>';
          }
          out += '</span>';
          return out;
        }
      } catch (e) { /* ignore */ }
      return escapeHtml(message.length > 300 ? message.substring(0, 300) + '…' : message);
    }
    function escapeHtml(s) {
      const div = document.createElement('div');
      div.textContent = s;
      return div.innerHTML;
    }
    function poll() {
      fetch('/api/state').then(r => r.json()).then(render).catch(() => {});
    }
    document.getElementById('auditBtn').addEventListener('click', async () => {
      try {
        const res = await fetch('/api/audit');
        if (!res.ok) return;
        const data = await res.json();
        const sessionId = data.sessionId || 'session';
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'audit-' + sessionId + '.json';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      } catch (e) {
        // ignore
      }
    });
    document.body.addEventListener('click', function(e) {
      var btn = e.target.closest('.copy-btn');
      if (btn && btn.getAttribute('data-addr')) {
        navigator.clipboard.writeText(btn.getAttribute('data-addr')).catch(function() {});
      }
    });
    poll();
    setInterval(poll, refreshMs);
  </script>
</body>
</html>
`;

export class Dashboard {
  private state: ColonyState;
  private server: http.Server | null = null;
  private isRunning = false;
  private sessionId: string;
  private auditSignatures: AuditSignature[] = [];
  private agentManager: AgentManager | null = null;
  // Baseline SOL balance per agent at first sighting; used for trader P&L.
  private baselineBalances: Record<string, number> = {};
  /** Cumulative SOL deposited to each agent (funder top-ups). Cost basis for P&L = current - (deposits - withdrawals). */
  private totalDepositedByAgent: Record<string, number> = {};

  constructor() {
    this.state = {
      agents: {},
      logs: [],
      blockedCount: 0,
      blockedReasons: [],
      blockHeight: 0,
      oraclePrice: 150,
      totalVaultBalance: 0,
      startTime: Date.now(),
      dryRun: process.env.DRY_RUN === 'true',
      priceHistory: [],
      trades: [],
      totalSupply: parseFloat(process.env.COLONY_TOKEN_TOTAL_SUPPLY ?? '1000000') || 1e6,
      vaultProfitHistory: [],
    };
    this.sessionId = Date.now().toString(36).slice(-8);
  }

  start(portOverride?: number): void {
    if (this.isRunning) return;
    this.isRunning = true;
    const listenPort = portOverride ?? PORT;

    this.server = http.createServer((req: http.IncomingMessage, res: http.ServerResponse) => {
      const url = req.url ?? '/';
      const pathname = url.split('?')[0];

      // JSON state for dashboard polling (agents, logs, block, price, vault, blocked)
      if (pathname === '/api/state') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(this.getStateSnapshot()));
        return;
      }
      // Dynamic agent management: add new trader agents at runtime.
      if (pathname === '/api/agents' && req.method === 'POST') {
        if (!this.agentManager) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Agent manager not available' }));
          return;
        }
        let body = '';
        req.on('data', (chunk: Buffer) => {
          body += chunk.toString('utf8');
          // Basic guard against extremely large bodies
          if (body.length > 10_000) {
            req.destroy();
          }
        });
        req.on('end', async () => {
          try {
            const payload = body ? (JSON.parse(body) as AddAgentsRequest) : ({} as AddAgentsRequest);
            const result = await this.agentManager!.addAgents(payload);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
          } catch (err) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
          }
        });
        return;
      }
      // Delete agent and claim its funds to the funder wallet.
      if (pathname.startsWith('/api/agents/') && req.method === 'DELETE') {
        const agentId = pathname.slice('/api/agents/'.length).replace(/\/$/, '');
        if (!agentId) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing agent id' }));
          return;
        }
        if (!this.agentManager) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Agent manager not available' }));
          return;
        }
        (async () => {
          try {
            const result = await this.agentManager!.removeAgent(agentId);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
          } catch (err) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              claimedSol: 0,
              error: err instanceof Error ? err.message : String(err),
            }));
          }
        })();
        return;
      }
      // Audit export for judges (signatures, blocked reasons, recent logs)
      if (pathname === '/api/audit') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        const payload = {
          sessionId: this.sessionId,
          startTime: this.state.startTime,
          blockedCount: this.state.blockedCount,
          blockedReasons: [...this.state.blockedReasons],
          signatures: [...this.auditSignatures],
          recentLogs: this.state.logs.slice(-30),
        };
        res.end(JSON.stringify(payload));
        return;
      }

      if (fs.existsSync(DASHBOARD_DIST) && fs.statSync(DASHBOARD_DIST).isDirectory()) {
        const safePath = path.normalize(pathname).replace(/^\//, '');
        if (safePath.includes('..')) {
          res.writeHead(404);
          res.end();
          return;
        }
        const filePath = path.join(DASHBOARD_DIST, safePath || 'index.html');
        if (safePath === '' || pathname === '/' || pathname === '/index.html') {
          const indexFile = path.join(DASHBOARD_DIST, 'index.html');
          if (fs.existsSync(indexFile)) {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(fs.readFileSync(indexFile));
            return;
          }
        }
        if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
          const ext = path.extname(filePath);
          const contentType = MIMES[ext] ?? 'application/octet-stream';
          res.writeHead(200, { 'Content-Type': contentType });
          res.end(fs.readFileSync(filePath));
          return;
        }
        const indexFile = path.join(DASHBOARD_DIST, 'index.html');
        if (fs.existsSync(indexFile)) {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(fs.readFileSync(indexFile));
          return;
        }
      }

      if (pathname === '/' || pathname === '/index.html') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(HTML_PAGE);
        return;
      }
      res.writeHead(404);
      res.end();
    });

    this.server.listen(listenPort, () => {
      if (process.env.NODE_ENV !== 'test') {
        console.log(`\nDashboard: http://localhost:${listenPort}\n`);
      }
    });
  }

  stop(): void {
    if (this.server) {
      this.server.close();
      this.server = null;
      this.isRunning = false;
    }
  }

  private getStateSnapshot(): ColonyState {
    return {
      ...this.state,
      agents: { ...this.state.agents },
      logs: [...this.state.logs],
      priceHistory: [...this.state.priceHistory],
      trades: [...this.state.trades],
      vaultProfitHistory: [...this.state.vaultProfitHistory],
    };
  }

  /** Record a trader contribution to the vault for profit history. */
  recordVaultContribution(fromAgentId: string, amount: number, signature?: string, amountUsdc?: number): void {
    const entry: { t: number; fromAgentId: string; amount: number; amountUsdc?: number; signature?: string } = {
      t: Date.now(),
      fromAgentId,
      amount,
      signature,
    };
    if (amountUsdc != null) entry.amountUsdc = amountUsdc;
    this.state.vaultProfitHistory.push(entry);
    if (this.state.vaultProfitHistory.length > 200) {
      this.state.vaultProfitHistory = this.state.vaultProfitHistory.slice(-200);
    }
  }

  /** Set the list of agent ids (e.g. from agent registry). Ensures state.agents has an entry per id. */
  setAgentIds(agentIds: string[]): void {
    for (const id of agentIds) {
      if (!this.state.agents[id]) {
        this.state.agents[id] = { stats: this.emptyStats(id), wallet: null };
      }
    }
  }

  /** Remove an agent from dashboard state (after delete + claim). */
  removeAgent(agentId: string): void {
    delete this.state.agents[agentId];
    delete this.baselineBalances[agentId];
    delete this.totalDepositedByAgent[agentId];
  }

  /**
   * Record an inflow of SOL to an agent (e.g. funder top-up). Used for cost-basis P&L:
   * P&L = current balance - (totalDeposited - totalWithdrawn), so top-ups don't erase historical losses.
   */
  recordInflow(agentId: string, amount: number): void {
    this.totalDepositedByAgent[agentId] = (this.totalDepositedByAgent[agentId] ?? 0) + amount;
  }

  /** Last-known SOL balance for an agent (from dashboard refresh). Use as fallback when RPC returns 0. */
  getAgentBalance(agentId: string): number | undefined {
    const w = this.state.agents[agentId]?.wallet;
    return w && typeof w.solBalance === 'number' ? w.solBalance : undefined;
  }

  updateAgent(agentId: string, stats: AgentStats, wallet: WalletInfo | null): void {
    const existing = this.state.agents[agentId];
    const mergedStats: AgentStats = existing
      ? { ...(existing.stats as AgentStats), ...stats }
      : { ...stats };

    // P&L: cost-basis style so top-ups don't erase history. For trader: pnlSOL = current - (deposits - withdrawals).
    // Do not overwrite pnlUSD for traders; it is the canonical trade-based P&L (revenue from sells − cost of buys).
    if (wallet && typeof wallet.solBalance === 'number') {
      const current = wallet.solBalance;
      const isTrader = agentId.startsWith('trader') || agentId.startsWith('flipper');
      const totalWithdrawn = typeof mergedStats.vaultContributions === 'number' ? mergedStats.vaultContributions : 0;

      if (isTrader) {
        const totalDeposited = this.totalDepositedByAgent[agentId] ?? 0;
        if (totalDeposited > 0) {
          const netInvested = totalDeposited - totalWithdrawn;
          mergedStats.pnlSOL = current - netInvested;
          mergedStats.roiPercent = (mergedStats.pnlSOL / totalDeposited) * 100;
        } else {
          // No inflow recorded yet (restart or pre-recordInflow). Fall back to baseline so P&L isn't wrong.
          if (this.baselineBalances[agentId] === undefined && current > 0) {
            this.baselineBalances[agentId] = current;
          }
          const baseline = this.baselineBalances[agentId];
          mergedStats.pnlSOL = baseline !== undefined ? current - baseline + totalWithdrawn : 0;
        }
      } else {
        // Vault, funder, etc.: mark-to-market vs first-seen baseline
        if (this.baselineBalances[agentId] === undefined) {
          this.baselineBalances[agentId] = current;
        }
        const baseline = this.baselineBalances[agentId];
        mergedStats.pnlSOL = current - baseline;
      }
    }

    this.state.agents[agentId] = { stats: mergedStats, wallet };
  }

  addLog(agentId: string, message: string, type: ColonyState['logs'][0]['type'] = 'decision', signature?: string): void {
    this.state.logs.push({ timestamp: Date.now(), agentId, message, type, signature });
    if (this.state.logs.length > 200) this.state.logs.shift();
  }

  /**
   * Attach an on-chain memo tx signature to the most recent decision log for this agent.
   * Used so decision entries (BUY, SWAP rationale, etc.) show a Solscan link.
   */
  setLastDecisionLogSignature(agentId: string, signature: string): void {
    for (let i = this.state.logs.length - 1; i >= 0; i--) {
      const entry = this.state.logs[i];
      if (entry.agentId === agentId && entry.type === 'decision') {
        entry.signature = signature;
        break;
      }
    }
  }

  updateBlock(height: number): void {
    this.state.blockHeight = height;
  }
  private lastPriceHistoryTime = 0;
  private static readonly PRICE_HISTORY_INTERVAL_MS = 3000;
  private static readonly MAX_PRICE_HISTORY = 500;
  private static readonly MAX_TRADES = 200;

  updatePrice(price: number): void {
    this.state.oraclePrice = price;
    const now = Date.now();
    if (now - this.lastPriceHistoryTime >= Dashboard.PRICE_HISTORY_INTERVAL_MS) {
      this.lastPriceHistoryTime = now;
      this.state.priceHistory.push({ t: now, p: price });
      if (this.state.priceHistory.length > Dashboard.MAX_PRICE_HISTORY) {
        this.state.priceHistory = this.state.priceHistory.slice(-Dashboard.MAX_PRICE_HISTORY);
      }
    }
  }

  /** Record a buy or sell for the SOL price chart (signature optional, for Solscan link on marker). */
  recordTrade(agentId: string, side: 'buy' | 'sell', price: number, amountSol?: number, amountToken?: number, signature?: string): void {
    this.state.trades.push({
      t: Date.now(),
      agentId,
      side,
      p: price,
      amountSol,
      amountToken,
      signature,
    });
    if (this.state.trades.length > Dashboard.MAX_TRADES) {
      this.state.trades = this.state.trades.slice(-Dashboard.MAX_TRADES);
    }
  }
  updateVaultBalance(balance: number): void {
    this.state.totalVaultBalance = balance;
  }

  recordBlocked(agentId: string, reason: string): void {
    const now = Date.now();
    const last = this.state.blockedReasons[this.state.blockedReasons.length - 1];

    // Always count every block, but avoid spamming the Recent Interventions list
    // with identical reasons back-to-back from the same agent.
    if (!last || last.agentId !== agentId || last.reason !== reason) {
      this.state.blockedReasons.push({ agentId, reason, timestamp: now });
      if (this.state.blockedReasons.length > 20) {
        this.state.blockedReasons.shift();
      }
    } else {
      // Update timestamp on the latest entry so the UI shows recency
      last.timestamp = now;
    }

    this.state.blockedCount += 1;
  }

  recordSignature(agentId: string, signature: string, description: string): void {
    const entry: AuditSignature = {
      agentId,
      signature,
      description,
      timestamp: Date.now(),
    };
    this.auditSignatures.push(entry);
    if (this.auditSignatures.length > 50) {
      this.auditSignatures.shift();
    }
  }

  setSessionId(sessionId: string): void {
    this.sessionId = sessionId;
  }

  getSessionId(): string {
    return this.sessionId;
  }

  setAgentManager(manager: AgentManager): void {
    this.agentManager = manager;
  }

  private emptyStats(agentId: string): AgentStats {
    return {
      agentId,
      totalTrades: 0,
      successfulTrades: 0,
      failedTrades: 0,
      totalVolumeSOL: 0,
      pnlSOL: 0,
      vaultContributions: 0,
      lastAction: 'Starting...',
      lastActionTime: Date.now(),
      outboundSOL: 0,
    };
  }
}
