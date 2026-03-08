/**
 * Agent registry for scalability: defines which agents run and their types.
 * Supports 8 agents by default (judging criteria: multiple agents independently),
 * plus any dynamically configured agents loaded from config/agents.dynamic.json.
 * Override with env AGENT_IDS (comma-separated) to change base ids or names.
 */

import { loadDynamicAgents } from './dynamicAgentsConfig';

export type AgentKind = 'vault' | 'funder' | 'pool' | 'trader';

/** Default startup: vault + funder + pool + 3 traders. */
const DEFAULT_AGENT_IDS = [
  'vault',
  'funder',
  'pool',
  'trader',
  'trader2',
  'trader3',
] as const;

/**
 * Return the list of agent ids to run (default 8 for scalability demo, plus any
 * dynamically configured agents).
 *
 * Set AGENT_IDS=vault,funder,pool,trader in .env for a minimal setup;
 * dynamic agents are always appended on top of that base list so judges can add
 * more agents via the dashboard without editing env.
 */
export function getAgentIds(): string[] {
  const env = process.env.AGENT_IDS;
  const baseIds =
    !env || env.trim() === ''
      ? [...DEFAULT_AGENT_IDS]
      : env.split(',').map((s) => s.trim()).filter(Boolean);

  const dynamic = loadDynamicAgents();
  const seen = new Set<string>(baseIds);
  for (const entry of dynamic) {
    if (!seen.has(entry.id)) {
      baseIds.push(entry.id);
      seen.add(entry.id);
    }
  }
  return baseIds;
}

/**
 * Return the kind of agent for a given id (vault / funder / pool / trader).
 * One vault; one funder; one pool (reserve for profits); traders trade.
 * Supports both trader* and flipper* prefixes for backward compatibility.
 */
export function getAgentKind(id: string): AgentKind {
  if (id === 'vault') return 'vault';
  if (id === 'funder') return 'funder';
  if (id === 'pool') return 'pool';
  return 'trader';
}

export const SCALABILITY_DEFAULT_AGENT_COUNT = DEFAULT_AGENT_IDS.length;
