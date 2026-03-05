import OpenAI from 'openai';
import { AgentDecision } from '../agents/types';

const AGENT_PERSONALITIES: Record<string, string> = {
  accumulator: 'a patient, methodical value investor who watches for price dips',
  flipper: 'an aggressive, fast-moving high-frequency trader focused on spreads',
  vault: 'a cautious treasury manager obsessed with capital preservation',
};

/**
 * RationaleEngine — Optional LLM explanation for agent decisions.
 *
 * When OPENAI_API_KEY is set, adds a one-sentence rationale per decision
 * (per-agent personality). If unset or on HOLD, returns the deterministic
 * reason. Cached by (agentId, type, 30s bucket) to limit API calls.
 * System works fully without this (dashboard still shows reason).
 */
export class RationaleEngine {
  private client: OpenAI | null;
  private cache: Map<string, string> = new Map();

  constructor() {
    const apiKey = process.env.OPENAI_API_KEY;
    this.client = apiKey ? new OpenAI({ apiKey }) : null;
  }

  async explain(decision: AgentDecision): Promise<string> {
    if (!this.client || decision.type === 'HOLD') {
      return decision.reason;
    }

    // Cache to avoid duplicate API calls for same decision bucket
    const cacheKey = `${decision.agentId}:${decision.type}:${Math.round(Date.now() / 30000)}`;
    if (this.cache.has(cacheKey)) return this.cache.get(cacheKey)!;

    try {
      const personality = AGENT_PERSONALITIES[decision.agentId] ?? 'an autonomous trading agent';

      const response = await this.client.chat.completions.create({
        model: 'gpt-4o-mini',
        max_tokens: 60,
        messages: [
          {
            role: 'system',
            content: `You are ${personality}. In exactly one concise sentence (max 20 words), explain this trading decision from your character's perspective. Be specific about the market signal.`,
          },
          {
            role: 'user',
            content: `Decision: ${decision.type}. Context: ${decision.reason}. Confidence: ${(decision.confidence * 100).toFixed(0)}%.`,
          },
        ],
      });

      const rationale = response.choices[0]?.message?.content?.trim() ?? decision.reason;
      this.cache.set(cacheKey, rationale);

      // Trim cache to prevent memory leak
      if (this.cache.size > 100) {
        const firstKey = this.cache.keys().next().value;
        if (firstKey) this.cache.delete(firstKey);
      }

      return rationale;
    } catch {
      return decision.reason;
    }
  }
}