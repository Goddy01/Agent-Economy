/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from 'react';
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
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

interface AgentStats {
  agentId: string;
  totalTrades: number;
  successfulTrades: number;
  failedTrades: number;
  totalVolumeSOL: number;
  pnlSOL: number;
  vaultContributions: number;
  lastAction: string;
  lastActionTime: number;
}

interface WalletInfo {
  address: string;
  solBalance: number;
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
  vaultFloorSol: number;
  startTime: number;
  dryRun: boolean;
}

const REFRESH_INTERVAL = 3000;
const BOOT_SECONDS = 15;

const SOLSCAN_TX = (sig: string) => `https://solscan.io/tx/${sig}?cluster=devnet`;

function formatLogMessage(message: string): React.ReactNode {
  let parsed: {
    type?: string;
    reason?: string;
    amount?: number;
    result?: { success?: boolean; error?: string; signature?: string; inputAmount?: number; outputAmount?: number; simulated?: boolean };
  };
  try {
    if (message.startsWith('{')) parsed = JSON.parse(message);
    else return message;
  } catch {
    return message;
  }
  if (parsed?.type === 'VAULT_CONTRIBUTION') {
    const amount = parsed.amount ?? 0;
    const success = parsed.result?.success !== false;
    return (
      <span className="block">
        {success ? (
          <>Sent <span className="text-emerald-400 font-medium">{amount.toFixed(4)} SOL</span> to vault.</>
        ) : (
          <>Failed to send {amount.toFixed(4)} SOL to vault. {parsed.result?.error ?? ''}</>
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

/** Log message text color: accumulator = white, flipper = blue, profit/vault = green, error = red. */
function logMessageColorClass(log: { agentId: string; message: string; type: string }): string {
  if (log.type === 'error') return 'text-rose-400';
  if (log.type === 'memo') return 'text-blue-300';
  if (log.type === 'trade' || log.type === 'decision') {
    const msg = typeof log.message === 'string' ? log.message : '';
    // 3 rules from user:
    // 1) Flipper log text = yellow
    // 2) Accumulator log text = blue
    // 3) Profit taking / sending to vault = green
    if (/Sent\s+[\d.]+\s+SOL\s+to\s+vault\./i.test(msg)) return 'text-emerald-400'; // profit → green
    if (log.agentId === 'vault') return 'text-emerald-400';
    if (log.agentId === 'funder') return 'text-violet-400';
    if (log.agentId.startsWith('accumulator')) return 'text-blue-400';  // accumulator(s) → blue
    if (log.agentId.startsWith('flipper')) return 'text-amber-400';     // flipper(s) → yellow
  }
  return 'text-white/60';
}

export default function App() {
  const [state, setState] = useState<ColonyState | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const logEndRef = useRef<HTMLDivElement>(null);

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

  if (!state) {
    return (
      <div className="min-h-screen bg-[#0A0A0B] flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <div className="w-12 h-12 border-4 border-emerald-500/20 border-t-emerald-500 rounded-full animate-spin" />
          <p className="text-emerald-500/60 font-mono text-sm tracking-widest uppercase">Initializing Colony...</p>
        </div>
      </div>
    );
  }

  const uptime = Math.floor((Date.now() - state.startTime) / 1000);
  const formatUptime = (s: number) => {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return `${h}h ${m}m ${sec}s`;
  };

  // Only show boot progress during the first BOOT_SECONDS; after that always show Last Action
  const bootProgress: number | null = uptime >= 0 && uptime < BOOT_SECONDS
    ? Math.max(0, Math.min(100, Math.floor((uptime / BOOT_SECONDS) * 100)))
    : null;

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
                <h1 className="text-lg font-bold tracking-tight text-white leading-none">COLONY CONTROL</h1>
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
                <span className="font-mono text-sm text-white">${state.oraclePrice.toFixed(2)}</span>
              </div>
              <div className="flex flex-col">
                <span className="text-[10px] text-white/40 uppercase tracking-wider font-semibold">System Uptime</span>
                <span className="font-mono text-sm text-white">{formatUptime(uptime)}</span>
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
              onClick={downloadAudit}
              className="flex items-center gap-2 px-4 py-2 bg-white/5 hover:bg-white/10 border border-white/10 rounded-lg text-xs font-medium transition-all active:scale-95"
            >
              <Download className="w-3.5 h-3.5" />
              Audit Log
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-[1600px] mx-auto p-6 space-y-6">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {(Object.entries(state.agents) as [string, { stats: AgentStats; wallet: WalletInfo | null }][]).map(([id, agent]) => (
            <AgentCard
              key={id}
              id={id}
              agent={agent}
              onCopy={copyToClipboard}
              copied={copied}
              bootProgress={bootProgress}
              vaultFloorSol={id === 'vault' ? state.vaultFloorSol : undefined}
              vaultInbound={id === 'vault' ? agent.stats.vaultContributions : undefined}
            />
          ))}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 bg-[#0D0D0E] border border-white/5 rounded-2xl flex flex-col h-[500px]">
            <div className="p-4 border-b border-white/5 flex items-center justify-between bg-white/[0.02]">
              <div className="flex items-center gap-2">
                <Terminal className="w-4 h-4 text-emerald-500" />
                <h3 className="text-xs font-bold uppercase tracking-widest text-white/80">Live Decision Stream</h3>
              </div>
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 bg-emerald-500 rounded-full animate-pulse" />
                <span className="text-[10px] font-mono text-emerald-500/60 uppercase">Live Connection</span>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto overflow-x-hidden p-4 font-mono text-xs space-y-2 custom-scrollbar">
              <AnimatePresence initial={false}>
                {state.logs.slice().reverse().map((log, i) => (
                  <motion.div
                    key={`${log.timestamp}-${i}`}
                    initial={{ opacity: 0, x: -10 }}
                    animate={{ opacity: 1, x: 0 }}
                    className="flex gap-4 group items-start min-w-0"
                  >
                    <span className="text-white/20 shrink-0">{new Date(log.timestamp).toLocaleTimeString([], { hour12: false })}</span>
                    <span className={`shrink-0 uppercase font-bold w-24 ${
                      log.agentId === 'funder' ? 'text-violet-400' :
                      log.agentId.startsWith('accumulator') ? 'text-blue-400' :
                      log.agentId.startsWith('flipper') ? 'text-amber-400' :
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

          <div className="bg-[#0D0D0E] border border-white/5 rounded-2xl flex flex-col h-[500px]">
            <div className="p-4 border-b border-white/5 flex items-center gap-2 bg-white/[0.02]">
              <Shield className="w-4 h-4 text-amber-500" />
              <h3 className="text-xs font-bold uppercase tracking-widest text-white/80">Safety Guardrails</h3>
            </div>

            <div className="p-6 space-y-6">
              <div className="flex items-center justify-between p-4 bg-amber-500/5 border border-amber-500/10 rounded-xl">
                <div>
                  <p className="text-[10px] text-amber-500/60 uppercase font-bold tracking-wider">Blocked Transactions</p>
                  <p className="text-2xl font-bold text-amber-500">{state.blockedCount}</p>
                </div>
                <AlertTriangle className="w-8 h-8 text-amber-500/20" />
              </div>

              <div className="space-y-4 max-h-[320px] overflow-y-auto pr-1 custom-scrollbar">
                <h4 className="text-[10px] text-white/40 uppercase font-bold tracking-widest">Recent Interventions</h4>
                {state.blockedReasons.length === 0 ? (
                  <p className="text-xs text-white/20 italic">No safety triggers detected...</p>
                ) : (
                  <div className="space-y-3">
                    {state.blockedReasons.slice().reverse().map((reason, i) => (
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
      </main>

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
  vaultFloorSol,
  vaultInbound,
}: {
  id: string;
  agent: AgentEntry;
  onCopy: (t: string) => void;
  copied: string | null;
  bootProgress: number | null;
  vaultFloorSol?: number;
  vaultInbound?: number;
}) {
  const isPositive = agent.stats.pnlSOL >= 0;
  const winRate = agent.stats.totalTrades > 0
    ? ((agent.stats.successfulTrades / agent.stats.totalTrades) * 100).toFixed(0)
    : '0';

  const accentClass = id === 'accumulator' ? 'bg-blue-500/50' : id === 'flipper' ? 'bg-amber-500/50' : 'bg-emerald-500/50';
  const iconBgClass = id === 'accumulator' ? 'bg-blue-500/10 border-blue-500/20' : id === 'flipper' ? 'bg-amber-500/10 border-amber-500/20' : 'bg-emerald-500/10 border-emerald-500/20';
  const iconColorClass = id === 'accumulator' ? 'text-blue-500' : id === 'flipper' ? 'text-amber-500' : 'text-emerald-500';
  const labelClass = id === 'accumulator' ? 'text-blue-500/60' : id === 'flipper' ? 'text-amber-500/60' : 'text-emerald-500/60';

  const Icon = id === 'accumulator' ? Activity : id === 'flipper' ? Zap : Shield;
  const addr = agent.wallet?.address ?? '';
  const shouldShowBoot =
    id !== 'vault' &&
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
            <h2 className="text-sm font-bold text-white uppercase tracking-tight">{id}</h2>
            <p className={`text-[10px] font-mono ${labelClass}`}>Autonomous Unit</p>
          </div>
        </div>
        <div className="flex flex-col items-end">
          <span className="text-[10px] text-white/20 uppercase font-bold">Win Rate</span>
          <span className="text-sm font-mono text-white">{winRate}%</span>
        </div>
      </div>

      <div className="space-y-4">
        <div>
          <p className="text-3xl font-bold text-white tracking-tighter">{agent.wallet?.solBalance.toFixed(3) ?? '0.000'} <span className="text-lg text-white/40">SOL</span></p>
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

        {id !== 'vault' && (
          <div className="grid grid-cols-2 gap-4 pt-4 border-t border-white/5">
            <div>
              <p className="text-[10px] text-white/40 uppercase font-bold tracking-wider">Volume</p>
              <p className="text-sm font-mono text-white">{agent.stats.totalVolumeSOL.toFixed(2)} SOL</p>
            </div>
            <div>
              <p className="text-[10px] text-white/40 uppercase font-bold tracking-wider">P&L</p>
              <p className={`text-sm font-mono ${isPositive ? 'text-emerald-400' : 'text-rose-400'}`}>
                {isPositive ? '+' : ''}{agent.stats.pnlSOL.toFixed(4)}
              </p>
            </div>
          </div>
        )}

        {id === 'vault' && vaultFloorSol != null && vaultInbound != null && (
          <div className="grid grid-cols-2 gap-4 pt-4 border-t border-white/5">
            <div>
              <p className="text-[10px] text-white/40 uppercase font-bold tracking-wider">Floor Lock</p>
              <p className="text-sm font-mono text-white">{vaultFloorSol.toFixed(3)} SOL</p>
            </div>
            <div>
              <p className="text-[10px] text-white/40 uppercase font-bold tracking-wider">Inbound</p>
              <p className="text-sm font-mono text-emerald-400">+{vaultInbound.toFixed(3)}</p>
            </div>
          </div>
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
            <p className="text-xs text-white/80 bg-white/5 p-2 rounded-lg border border-white/5 italic">
              &quot;{agent.stats.lastAction}&quot;
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
