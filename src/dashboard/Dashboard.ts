import * as React from 'react';
import { render, Box, Text, useInput, useApp } from 'ink';
import { WalletInfo } from '../wallet/WalletManager';
import { AgentStats } from '../agents/types';
import { MemoEntry } from '../coordination/MemoLogger';

export interface ColonyState {
  agents: {
    accumulator: { stats: AgentStats; wallet: WalletInfo | null };
    flipper: { stats: AgentStats; wallet: WalletInfo | null };
    vault: { stats: AgentStats; wallet: WalletInfo | null };
  };
  logs: Array<{
    timestamp: number;
    agentId: string;
    message: string;
    type: 'decision' | 'trade' | 'error' | 'memo';
  }>;
  blockHeight: number;
  oraclePrice: number;
  totalVaultBalance: number;
  startTime: number;
  dryRun: boolean;
}

const AGENT_COLORS: Record<string, string> = {
  accumulator: 'cyan',
  flipper: 'yellow',
  vault: 'green',
};

const AgentCard: React.FC<{
  name: string;
  agentId: string;
  stats: AgentStats;
  wallet: WalletInfo | null;
}> = ({ name, agentId, stats, wallet }) => {
  const color = AGENT_COLORS[agentId] ?? 'white';
  const balance = wallet?.solBalance.toFixed(3) ?? '...';
  const winRate = stats.totalTrades > 0
    ? ((stats.successfulTrades / stats.totalTrades) * 100).toFixed(0)
    : '--';

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={color} padding={1} width={28}>
      <Text color={color} bold>{name.toUpperCase()}</Text>
      <Text> </Text>
      <Text color="white">◎ <Text bold>{balance}</Text> SOL</Text>
      <Text color="gray">Trades: {stats.totalTrades} ({winRate}% win)</Text>
      <Text color="gray">Vol: {stats.totalVolumeSOL.toFixed(3)} SOL</Text>
      <Text color={stats.pnlSOL >= 0 ? 'green' : 'red'}>
        P&L: {stats.pnlSOL >= 0 ? '+' : ''}{stats.pnlSOL.toFixed(4)} SOL
      </Text>
      <Text color="magenta">→ Vault: {stats.vaultContributions.toFixed(4)}</Text>
    </Box>
  );
};

const LogLine: React.FC<{ entry: ColonyState['logs'][0] }> = ({ entry }) => {
  const time = new Date(entry.timestamp).toLocaleTimeString('en-US', { hour12: false });
  const color = {
    decision: 'white',
    trade: 'green',
    error: 'red',
    memo: 'blue',
  }[entry.type] ?? 'white';

  const agentColor = AGENT_COLORS[entry.agentId] ?? 'white';

  return (
    <Box>
      <Text color="gray">[{time}] </Text>
      <Text color={agentColor as any}>{entry.agentId.padEnd(11)}</Text>
      <Text color={color as any}>{entry.message.substring(0, 60)}</Text>
    </Box>
  );
};

const ColonyDashboard: React.FC<{ getState: () => ColonyState }> = ({ getState }) => {
  const [state, setState] = React.useState<ColonyState>(getState());
  const { exit } = useApp();

  // Refresh every 2 seconds
  React.useEffect(() => {
    const interval = setInterval(() => {
      setState(getState());
    }, parseInt(process.env.DASHBOARD_REFRESH_MS ?? '2000'));
    return () => clearInterval(interval);
  }, []);

  useInput((input) => {
    if (input === 'q') exit();
  });

  const uptime = Math.floor((Date.now() - state.startTime) / 1000);
  const uptimeStr = `${Math.floor(uptime / 60)}m ${uptime % 60}s`;
  const recentLogs = state.logs.slice(-12);

  return (
    <Box flexDirection="column" padding={1}>
      {/* Header */}
      <Box justifyContent="space-between" marginBottom={1}>
        <Text color="white" bold>🤖 AGENT COLONY — SOLANA DEVNET</Text>
        <Text color="gray">
          Block: {state.blockHeight.toLocaleString()}  |  
          SOL/USDC: ${state.oraclePrice.toFixed(2)}  |  
          Up: {uptimeStr}
          {state.dryRun ? '  |  ' : ''}
          {state.dryRun ? <Text color="yellow">DRY RUN</Text> : null}
        </Text>
      </Box>

      {/* Agent Cards */}
      <Box flexDirection="row" gap={2} marginBottom={1}>
        <AgentCard
          name="Accumulator"
          agentId="accumulator"
          stats={state.agents.accumulator.stats}
          wallet={state.agents.accumulator.wallet}
        />
        <AgentCard
          name="Flipper"
          agentId="flipper"
          stats={state.agents.flipper.stats}
          wallet={state.agents.flipper.wallet}
        />
        <AgentCard
          name="Vault 🔒"
          agentId="vault"
          stats={state.agents.vault.stats}
          wallet={state.agents.vault.wallet}
        />
        {/* Vault Summary */}
        <Box flexDirection="column" borderStyle="round" borderColor="green" padding={1} width={28}>
          <Text color="green" bold>VAULT STATUS</Text>
          <Text> </Text>
          <Text>Balance: <Text bold>{state.totalVaultBalance.toFixed(3)}</Text> SOL</Text>
          <Text color="red">Floor: {process.env.VAULT_FLOOR_SOL ?? '5.0'} SOL LOCKED</Text>
          <Text color="gray">Received: {state.agents.vault.stats.vaultContributions.toFixed(4)} SOL</Text>
          <Text color="gray">Inbound txns: {state.agents.vault.stats.totalTrades}</Text>
        </Box>
      </Box>

      {/* Log Feed */}
      <Box flexDirection="column" borderStyle="single" borderColor="gray" padding={1}>
        <Text color="gray" bold>LIVE DECISION LOG</Text>
        {recentLogs.map((entry, i) => (
          <LogLine key={i} entry={entry} />
        ))}
        {recentLogs.length === 0 && (
          <Text color="gray">Waiting for agent decisions...</Text>
        )}
      </Box>

      <Text color="gray" dimColor>Press Q to stop colony</Text>
    </Box>
  );
};

export class Dashboard {
  private state: ColonyState;
  private isRunning = false;

  constructor() {
    this.state = {
      agents: {
        accumulator: { stats: this.emptyStats('accumulator'), wallet: null },
        flipper: { stats: this.emptyStats('flipper'), wallet: null },
        vault: { stats: this.emptyStats('vault'), wallet: null },
      },
      logs: [],
      blockHeight: 0,
      oraclePrice: 150,
      totalVaultBalance: 0,
      startTime: Date.now(),
      dryRun: process.env.DRY_RUN === 'true',
    };
  }

  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    render(React.createElement(ColonyDashboard, { getState: () => this.state }));
  }

  updateAgent(agentId: keyof ColonyState['agents'], stats: AgentStats, wallet: WalletInfo | null): void {
    this.state.agents[agentId] = { stats, wallet };
  }

  addLog(agentId: string, message: string, type: ColonyState['logs'][0]['type'] = 'decision'): void {
    this.state.logs.push({ timestamp: Date.now(), agentId, message, type });
    if (this.state.logs.length > 200) this.state.logs.shift();
  }

  updateBlock(height: number): void { this.state.blockHeight = height; }
  updatePrice(price: number): void { this.state.oraclePrice = price; }
  updateVaultBalance(balance: number): void { this.state.totalVaultBalance = balance; }

  private emptyStats(agentId: string): AgentStats {
    return {
      agentId, totalTrades: 0, successfulTrades: 0, failedTrades: 0,
      totalVolumeSOL: 0, pnlSOL: 0, vaultContributions: 0,
      lastAction: 'Starting...', lastActionTime: Date.now(),
    };
  }
}