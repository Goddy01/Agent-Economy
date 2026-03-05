/**
 * Agent registry for scalability: defines which agents run and their types.
 * Supports 8 agents by default (judging criteria: multiple agents independently).
 * Override with env AGENT_IDS (comma-separated) to change count or names.
 */

export type AgentKind = 'vault' | 'funder' | 'accumulator' | 'flipper';

const DEFAULT_AGENT_IDS = [
  'vault',
  'funder',
  // Include legacy agent ids so their existing wallets are reused
  'accumulator',
  'accumulator2',
  'accumulator3',
  'flipper',
  'flipper2',
  'flipper3',
  'flipper4',
] as const;

/**
 * Return the list of agent ids to run (default 8 for scalability demo).
 * Set AGENT_IDS=vault,accumulator,flipper in .env for the minimal 3-agent setup.
 */
export function getAgentIds(): string[] {
  const env = process.env.AGENT_IDS;
  if (!env || env.trim() === '') {
    return [...DEFAULT_AGENT_IDS];
  }
  return env.split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * Return the kind of agent for a given id (vault / funder / accumulator / flipper).
 * One vault; one funder (distributes SOL to other agents); accumulators and flippers as before.
 */
export function getAgentKind(id: string): AgentKind {
  if (id === 'vault') return 'vault';
  if (id === 'funder') return 'funder';
  if (id.startsWith('accumulator')) return 'accumulator';
  return 'flipper';
}

export const SCALABILITY_DEFAULT_AGENT_COUNT = DEFAULT_AGENT_IDS.length;
