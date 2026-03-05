/**
 * WebDashboard — HTTP server and in-memory state for the colony UI.
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
  /** Dynamic agent list (e.g. 8 agents: vault, accumulator1..3, flipper1..4). */
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
  vaultFloorSol: number;
  startTime: number;
  dryRun: boolean;
}

interface AuditSignature {
  agentId: string;
  signature: string;
  description: string;
  timestamp: number;
}

const PORT = parseInt(process.env.DASHBOARD_PORT ?? '3555', 10);
const REFRESH_MS = parseInt(process.env.DASHBOARD_REFRESH_MS ?? '5000', 10);
const VAULT_FLOOR = process.env.VAULT_FLOOR_SOL ?? '5.0';

const HTML_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Agent Colony — Solana Devnet</title>
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
    .card.accumulator { border-left: 4px solid #79c0ff; }
    .card.flipper { border-left: 4px solid #d29922; }
    .card.vault { border-left: 4px solid #3fb950; }
    .card.funder { border-left: 4px solid #a371f7; }
    .card.safety { border-left: 4px solid #d29922; }
    .card h2 { font-size: 0.75rem; margin: 0 0 0.75rem 0; text-transform: uppercase; letter-spacing: 0.05em; color: #8b949e; font-weight: 600; }
    .card.accumulator h2 { color: #79c0ff; }
    .card.flipper h2 { color: #d29922; }
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
    <div class="cards" id="cards"></div>
    <div class="log-box">
      <h3>Live decision log</h3>
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

      const agentIds = Object.keys(state.agents).sort(function(a, b) {
        if (a === 'vault') return 1;
        if (b === 'vault') return -1;
        return a.localeCompare(b);
      });
      function kind(id) {
        if (id === 'vault') return 'vault';
        if (id === 'funder') return 'funder';
        if (id.indexOf('accumulator') === 0) return 'accumulator';
        return 'flipper';
      }
      function displayName(id) {
        if (id === 'vault') return 'Vault';
        if (id === 'funder') return 'Funder (send SOL here)';
        return id.charAt(0).toUpperCase() + id.slice(1);
      }
      const cardsEl = document.getElementById('cards');
      let cardsHtml = agentIds.map(function(id) {
        const a = state.agents[id];
        if (!a) return '';
        const balance = a.wallet?.solBalance != null ? a.wallet.solBalance.toFixed(3) : '...';
        const winRate = a.stats.totalTrades > 0
          ? ((a.stats.successfulTrades / a.stats.totalTrades) * 100).toFixed(0) + '%'
          : '--';
        const pnlClass = a.stats.pnlSOL >= 0 ? 'pnl-positive' : 'pnl-negative';
        const pnlSign = a.stats.pnlSOL >= 0 ? '+' : '';
        const addr = a.wallet?.address || '...';
        const addrLink = addr !== '...' ? ('https://solscan.io/account/' + encodeURIComponent(addr) + '?cluster=devnet') : '';
        const volPnlRows = id === 'vault' ? '' : (
          '<div class="row">Vol: ' + a.stats.totalVolumeSOL.toFixed(3) + ' SOL</div>' +
          '<div class="row ' + pnlClass + '">P&L: ' + pnlSign + a.stats.pnlSOL.toFixed(4) + ' SOL</div>'
        );
        return '<div class="card ' + kind(id) + '">' +
          '<h2>' + displayName(id) + '</h2>' +
          '<div class="balance">' + balance + ' SOL</div>' +
          '<div class="row">' + (addrLink ? addrBlock(addr, addrLink) : escapeHtml(addr)) + '</div>' +
          '<div class="row">Trades: ' + a.stats.totalTrades + ' (' + winRate + ' win)</div>' +
          volPnlRows +
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
              : '—';
            // Decide message color:
            // - Profit / vault contributions → green
            // - Errors → red
            // - Flipper decisions/trades → blue
            // - Accumulator decisions/trades → white
            let color = '#8b949e';
            const isProfit = /Sent\s+[\d.]+\s+SOL\s+to\s+vault\./i.test(rawMsg);
            const agentKind = entry.agentId === 'vault' ? 'vault' : entry.agentId === 'funder' ? 'funder' : entry.agentId.indexOf('accumulator') === 0 ? 'accumulator' : 'flipper';
            if (entry.type === 'error') {
              color = '#f85149';
            } else if (isProfit) {
              color = '#3fb950';
            } else if (agentKind === 'funder') {
              color = '#a371f7';
            } else if (agentKind === 'flipper') {
              color = '#58a6ff';
            } else if (agentKind === 'accumulator') {
              color = '#e6edf3';
            }

            return '<tr><td>' + time + '</td><td class="agent ' + entry.type + '">' + escapeHtml(entry.agentId) + '</td><td class="msg" style="color:' + color + ';">' + msgHtml + '</td><td class="log-tx">' + txCell + '</td></tr>';
          }).join('') +
          '</tbody></table>';
      }
    }
    function formatLogMsg(message) {
      if (typeof message !== 'string' || !message.startsWith('{')) return escapeHtml(message.length > 300 ? message.substring(0, 300) + '…' : message);
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

  constructor() {
    this.state = {
      agents: {},
      logs: [],
      blockedCount: 0,
      blockedReasons: [],
      blockHeight: 0,
      oraclePrice: 150,
      totalVaultBalance: 0,
      vaultFloorSol: parseFloat(process.env.VAULT_FLOOR_SOL ?? '5.0'),
      startTime: Date.now(),
      dryRun: process.env.DRY_RUN === 'true',
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
    };
  }

  /** Set the list of agent ids (e.g. from agent registry). Ensures state.agents has an entry per id. */
  setAgentIds(agentIds: string[]): void {
    for (const id of agentIds) {
      if (!this.state.agents[id]) {
        this.state.agents[id] = { stats: this.emptyStats(id), wallet: null };
      }
    }
  }

  updateAgent(agentId: string, stats: AgentStats, wallet: WalletInfo | null): void {
    this.state.agents[agentId] = { stats, wallet };
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
  updatePrice(price: number): void {
    this.state.oraclePrice = price;
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
    };
  }
}
