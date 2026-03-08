# Agent Colony — Agentic Wallets for AI Agents on Solana

**A fully autonomous multi-agent economy on Solana devnet.** Six AI agents each hold their own on-chain wallet, make independent financial decisions, and execute real transactions — swapping SOL ↔ USDC via Orca Whirlpools, logging every decision on-chain via Solana Memo, and managing a shared treasury — all without human intervention.

**Bounty:** [DeFi Developer Challenge — Agentic Wallets for AI Agents](https://superteam.fun/earn/listing/defi-developer-challenge-agentic-wallets-for-ai-agents) (Superteam Nigeria)

**Built by:** [Goddy01](https://github.com/Goddy01)

---

> **Judges:** Full reproducible demo with on-chain verification → **[SETUP.md](./SETUP.md)** (~5–8 min).
> Deep dive on wallet design, security model, and agent architecture → **[DEEP_DIVE.md](./DEEP_DIVE.md)**.

---

## Bounty Requirements

| Criterion | How it's met |
|---|---|
| **Functional demonstration** | Live dashboard at `http://localhost:3555` with real devnet txs, USDC balances, P&L, and trading history. [SETUP.md](./SETUP.md) |
| **Security and key management** | Encrypted vault (AES-256-GCM + Argon2id), simulate-before-send, per-agent rate limiting, optional dry-run mode. [DEEP_DIVE.md](./DEEP_DIVE.md) · `npm run test:security` |
| **Documentation** | [DEEP_DIVE.md](./DEEP_DIVE.md) (wallet design + security) · [SETUP.md](./SETUP.md) (run + verify) · [SKILLS.md](./SKILLS.md) (agent API) |
| **Scalability** | Default 6 agents; add traders live via dashboard; 4-agent or 9+ stress mode. [SETUP.md §Scaling](./SETUP.md) |

---

## Submission Checklist

| Requirement | Delivered |
|---|---|
| **Create a wallet programmatically** | `WalletManager.createWallet(agentId)` + HD key derivation via `KeyVault.registerAgent()` — idempotent, created on first use |
| **Sign transactions automatically** | `KeyVault.sign(SigningRequest)` — agents sign by agent ID only; private keys never leave the vault |
| **Hold SOL and USDC (SPL)** | Every agent holds SOL and USDC. USDC is the platform stablecoin. Run `npm run create-usdc-token` after setup for the full demo. |
| **Interact with a real protocol** | **Orca Whirlpools** (devnet swaps), **Solana Memo Program** (on-chain decision audit trail), **System Program** (SOL transfers between agents) |
| **Deep dive** | [DEEP_DIVE.md](./DEEP_DIVE.md) — wallet design, security model, AI agent interaction |
| **Open-source with setup docs** | This repo; [SETUP.md](./SETUP.md) |
| **SKILLS.md** | [SKILLS.md](./SKILLS.md) — wallet API, safety constraints, and how to extend with new agents |
| **Working prototype on devnet** | Yes — `npm run setup && npm run start`; dashboard at `http://localhost:3555` |

---

## What Makes This Submission Stand Out

**Key isolation by design.** Private keys exist in exactly one place — the encrypted `KeyVault`. Every agent, every protocol adapter, every script requests signing by agent ID. Nothing else ever touches a key. This isn't a best-practice aspiration; it's enforced architecturally.

**Real protocol interaction, no mocks.** Traders execute live Orca Whirlpools swaps on devnet. Every agent decision is written to chain via Solana Memo, creating a tamper-evident audit trail you can inspect on Solscan.

**Colony-scale from day one.** The default setup runs 6 independent agents with their own wallets, balances, and decision logic. Add traders at runtime via the dashboard — the funder automatically provisions each one with SOL and USDC on-chain.

**Observable and verifiable.** Every agent wallet address is shown on the dashboard and links directly to Solscan. P&L, volume, trade history, and funder outbound are all live. Nothing requires trusting the UI — every claim is on-chain.

---

## Architecture

```
Agent logic (decision)
    → KeyVault.sign(SigningRequest)       # only place keys exist
        → TransactionEngine               # simulate → circuit breakers → send
            → Solana devnet               # real txs: Orca swaps, Memo logs, SOL transfers
```

The vault is the security perimeter. Agents, adapters, and scripts sit entirely outside it — they request signatures, never keys. See [DEEP_DIVE.md](./DEEP_DIVE.md) for the full security model and key derivation design.

---

## Quick Start

```bash
git clone https://github.com/Goddy01/Agent-Economy.git
cd agent-colony
npm install
cp .env.example .env
```

Set one required variable in `.env` (run `npm run generate-passphrase` to get a secure value):

```env
MASTER_PASSPHRASE="your-secret-at-least-32-characters"
```

**Minimal start (SOL only):**
```bash
npm run setup
npm run build:dashboard && npm run start
```

**Full demo with USDC trading (recommended):**
```bash
npm run setup
# Top up the funder wallet with devnet SOL (address shown by setup, or on dashboard)
# Faucets: https://faucet.solana.com or https://solfaucet.com
npm run create-usdc-token
npm run build:dashboard && npm run start
```

Open **[http://localhost:3555](http://localhost:3555)**. Within 1–2 minutes you'll see agent decisions, balance changes, and on-chain transaction links.

**Dry run (no transactions sent):**
```bash
npm run colony:dry
```

> For step-by-step instructions, environment variables, troubleshooting, and on-chain verification, see **[SETUP.md](./SETUP.md)**.

---

## Scaling

| Mode | How |
|---|---|
| **4-agent** | `AGENT_IDS=vault,funder,pool,trader` in `.env` → `npm run setup && npm run start` |
| **6-agent (default)** | Leave `AGENT_IDS` unset |
| **Add traders live** | Dashboard → **Scale the colony** → choose preset → **Add agents to colony** |
| **9+ stress test** | `npm run colony:stress` (dry run, no transactions) |

---

## Dashboard Screenshots

The Colony Control dashboard runs at `http://localhost:3555`.

**Treasury, Funding & Pool**
Vault (profit sink), Funder (SOL/USDC reserves and outbound activity), Pool (liquidity counterparty). Funder outbound confirms on-chain agent provisioning.

![Treasury, Funding & Pool](docs/screenshots/treasury-funding-pool.png)

**Autonomous trader cards**
Each trader has its own wallet address, SOL and USDC balance, volume (USD), realized P&L, and trade history. Balance changes confirm real on-chain activity.

![Traders](docs/screenshots/traders-cards.png)

**Live SOL/USDC price chart**
Buy (green) and sell (red) markers with trader labels (T1, T2, T3) confirm independent agent decisions against a shared price feed.

![Colony Control chart](docs/screenshots/colony-control-chart.png)

**Per-trader history**
Total SOL bought/sold, realized and total P&L, and a full trade log with pre/post balances. Every row corresponds to a verifiable on-chain transaction.

![Trader trading history](docs/screenshots/trader-trading-history.png)

**Vault profit history**
SOL contributions from traders with timestamps and Solscan transaction links — on-chain proof of agent-to-vault profit flow.

![Vault profit history](docs/screenshots/vault-profit-history.png)

---

## Project Layout

| Directory | What lives here |
|---|---|
| `src/vault/` | `KeyVault` — encrypted HD seed (AES-256-GCM + Argon2id). **The only place private keys exist.** All signing flows through here. |
| `src/wallet/` | `WalletManager` — create wallets, query balances, build transfers. Never holds keys directly. |
| `src/agents/` | Agent logic: `TraderAgent`, `FunderAgent`, `PoolAgent`, `VaultAgent`. Extend `BaseAgent` to add new agent types. |
| `src/transactions/` | `TransactionEngine` — circuit breakers, simulate-before-send, rate limiting, broadcast. |
| `src/coordination/` | `MemoLogger` (on-chain decision log), `Oracle` (price feed) |
| `src/dex/` | `OrcaAdapter` (Whirlpools swaps), `PoolAdapter`, `TraderAdapter` |
| `src/dashboard/` | `WebDashboard` — HTTP server + live React UI |
| `scripts/` | Setup, vault restore, USDC token creation, teardown, balance checks |

---

## Documentation

| Doc | What's in it |
|---|---|
| **[DEEP_DIVE.md](./DEEP_DIVE.md)** | Wallet design, key derivation, security model, how AI agents interact with the vault |
| **[SETUP.md](./SETUP.md)** | Prerequisites, step-by-step demo, environment variables, on-chain verification, troubleshooting |
| **[SKILLS.md](./SKILLS.md)** | Wallet API reference, safety constraints, guide to adding new agent types |

---

## Devnet

All activity runs on Solana devnet. RPC: `SOLANA_RPC_URL` (default: `https://api.devnet.solana.com`).

Agent wallet addresses are printed by `npm run setup`, shown on each dashboard card, and link directly to [Solscan (devnet)](https://solscan.io/?cluster=devnet). Memo instructions in each transaction show the agent's decision rationale on-chain.

---

## License

ISC