import * as fs from 'fs';
import * as path from 'path';
import type { AgentKind } from './agentRegistry';

export interface DynamicAgentConfigEntry {
  id: string;
  kind: AgentKind;
  // Strategy payload is interpreted by Orchestrator; keep it loosely typed here.
  strategy?: Record<string, unknown>;
}

interface DynamicAgentsFile {
  agents: DynamicAgentConfigEntry[];
}

const CONFIG_DIR = path.join(process.cwd(), 'config');
const CONFIG_PATH = path.join(CONFIG_DIR, 'agents.dynamic.json');

function ensureConfigDir(): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

export function loadDynamicAgents(): DynamicAgentConfigEntry[] {
  try {
    if (!fs.existsSync(CONFIG_PATH)) {
      return [];
    }
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    if (!raw.trim()) return [];
    const parsed = JSON.parse(raw) as DynamicAgentsFile | DynamicAgentConfigEntry[];
    if (Array.isArray(parsed)) {
      return parsed;
    }
    if (parsed && Array.isArray(parsed.agents)) {
      return parsed.agents;
    }
    return [];
  } catch (err) {
    console.warn(
      'Failed to read dynamic agents config, ignoring. Error:',
      err instanceof Error ? err.message : err
    );
    return [];
  }
}

export function saveDynamicAgents(agents: DynamicAgentConfigEntry[]): void {
  try {
    ensureConfigDir();
    const tmpPath = CONFIG_PATH + '.tmp';
    const payload: DynamicAgentsFile = { agents };
    fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), 'utf8');
    fs.renameSync(tmpPath, CONFIG_PATH);
  } catch (err) {
    console.warn(
      'Failed to write dynamic agents config. New agents may not persist across restarts.',
      err instanceof Error ? err.message : err
    );
  }
}

export function appendDynamicAgents(newAgents: DynamicAgentConfigEntry[]): DynamicAgentConfigEntry[] {
  const current = loadDynamicAgents();
  const merged = [...current];
  for (const entry of newAgents) {
    if (!merged.find((a) => a.id === entry.id)) {
      merged.push(entry);
    }
  }
  saveDynamicAgents(merged);
  return merged;
}

/** Remove a dynamically added agent from config so it does not come back on restart. */
export function removeDynamicAgent(agentId: string): void {
  const current = loadDynamicAgents();
  const filtered = current.filter((a) => a.id !== agentId);
  if (filtered.length < current.length) {
    saveDynamicAgents(filtered);
  }
}

export function getNextAgentId(kind: AgentKind, existingIds: string[]): string {
  const prefix = kind === 'trader' ? 'trader' : kind;
  if (prefix !== 'trader') {
    throw new Error(`Dynamic agent ids are only supported for traders (got ${kind})`);
  }
  let maxIndex = 0;
  for (const id of existingIds) {
    if (!id.startsWith('trader') && !id.startsWith('flipper')) continue;
    const base = id.startsWith('trader') ? 'trader' : 'flipper';
    const suffix = id.slice(base.length);
    if (!suffix) {
      maxIndex = Math.max(maxIndex, 1);
      continue;
    }
    const n = parseInt(suffix, 10);
    if (!Number.isNaN(n)) {
      maxIndex = Math.max(maxIndex, n);
    }
  }
  const nextIndex = maxIndex === 0 ? 1 : maxIndex + 1;
  return nextIndex === 1 ? prefix : `${prefix}${nextIndex}`;
}

