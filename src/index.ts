/**
 * Agent Colony - Main entry point.
 *
 * Starts the Orchestrator, which initializes the encrypted KeyVault, creates
 * agent wallets (vault, funder, pool, traders), and runs the trading colony with
 * circuit breakers, dashboard, and on-chain memo logging.
 *
 * Judges: See SETUP.md and run `npm run test:security` for attack-simulation tests.
 */
import { Orchestrator } from './colony/Orchestrator';

process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  if (msg.includes('Too many requests') || msg.includes('429')) {
    console.warn(
      'Devnet RPC rate limit hit (429). Backing off; agents and dashboard will retry automatically.'
    );
    return;
  }
  console.error('Unhandled promise rejection:', reason);
});

// Suppress @solana/web3.js 429 retry spam (devnet rate limits)
const _stderr = console.error;
console.error = (...args: unknown[]) => {
  const msg = args.length > 0 ? String(args[0]) : '';
  if (msg.includes('Server responded with 429') && msg.includes('Retrying after')) return;
  _stderr.apply(console, args);
};

// Keep process alive on transient RPC/WS errors (ECONNRESET, fetch failed, etc.)
process.on('unhandledRejection', (reason) => {
  const r = reason as { message?: string; cause?: { message?: string } };
  const msg = (r?.message ?? String(reason)) + (r?.cause != null ? String(r.cause?.message ?? r.cause) : '');
  if (/ECONNRESET|fetch failed|ETIMEDOUT|ECONNREFUSED|socket hang up|ws error/i.test(msg)) {
    console.warn('RPC/network error (non-fatal):', r?.message ?? reason);
    return;
  }
  console.error('Unhandled rejection:', reason);
});

// ─── Main: create orchestrator and run colony (vault init, agents, dashboard) ───
async function main() {
  const colony = new Orchestrator();
  await colony.run();
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});