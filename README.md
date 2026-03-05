# Agent Colony — AI Agent Wallet for Solana (Bounty Submission)

**Prototype agentic wallet system: multiple AI agents each with an autonomous wallet, signing transactions and interacting with real Solana devnet protocols (Orca Whirlpools, Memo) without human intervention.**

**Bounty:** [DeFi Developer Challenge – Agentic Wallets for AI Agents](https://superteam.fun/earn/listing/defi-developer-challenge-agentic-wallets-for-ai-agents) (Superteam Nigeria).

**→ Judges:** For a reproducible 5-minute path and what to look for on-chain, see **[JUDGE_DEMO.md](./JUDGE_DEMO.md)**. If something doesn’t run on your machine, open an issue — I’ll fix it.

---

## Superteam Bounty — Requirement Mapping

### Technical expectations

| Requirement | How Agent Colony meets it |
|-------------|---------------------------|
| **Safe key management and storage for autonomous agents** | Single encrypted vault (AES-256-GCM + Argon2id); HD derivation (BIP-44) per agent; keys never exported; zeroed after signing. See [DEEP_DIVE.md](./DEEP_DIVE.md) §2 and [docs/SECURITY.md](./docs/SECURITY.md). |
| **Automated transaction signing without manual input** | All signing via `KeyVault.sign({ agentId, transaction })` triggered by agent logic; no prompts or CLI. Passphrase in `.env`; agents never see private keys. |
| **Ability to simulate decision-making or execution by an AI agent** | **Decision:** Agents run deterministic rules + optional LLM rationale. **Execution:** Every tx is simulated on RPC before sign/send; `DRY_RUN=true` runs full flow with zero transactions sent. See [DEEP_DIVE.md](./DEEP_DIVE.md) §3.3. |
| **Clear separation of responsibilities between agent logic and wallet operations** | **Agents** (`src/agents/`): decide and call APIs only. **Wallet/signing** (`KeyVault`, `WalletManager`, `TransactionEngine`): hold keys, build/sign/send, enforce circuit breakers. Agents never handle keys or raw signing. See [DEEP_DIVE.md](./DEEP_DIVE.md) §3.1. |

### Judging criteria

| Criterion | Where to see it |
|-----------|------------------|
| **Functional demonstration of an autonomous agent wallet** | `npm run setup` then `npm run start`; dashboard at http://localhost:3555. Live balances, P&L, decision stream; real devnet txs (Orca, Memo, SOL transfers). [JUDGE_DEMO.md](./JUDGE_DEMO.md) has step-by-step verification. |
| **Security and proper key management** | Encrypted vault, simulate-before-send, circuit breakers (rate limit, max SOL, vault floor), dry-run mode. [docs/SECURITY.md](./docs/SECURITY.md) (threat model, key handling). Tests: `npm test` (circuit breakers + dry run never sends). |
| **Clear documentation and deep dive explanation** | [DEEP_DIVE.md](./DEEP_DIVE.md) — wallet design, security, agent–wallet interaction. [docs/SECURITY.md](./docs/SECURITY.md) — plain-language threat model and architecture. [docs/RUNBOOK.md](./docs/RUNBOOK.md) — how to run safely. |
| **Scalability: support multiple agents independently** | **Default: 8 agents** (1 vault + 3 accumulators + 4 flippers), each with an independent HD-derived wallet, per-agent rate limits, and separate dashboard cards. Run `npm run setup` then `npm run start` to see all 8; set `AGENT_IDS=vault,accumulator,flipper` in `.env` for the minimal 3-agent setup. See [DEEP_DIVE.md](./DEEP_DIVE.md) §3.4 and [docs/SECURITY_SCORE.md](./docs/SECURITY_SCORE.md#scalability). |

---

## Bounty alignment (detailed)

This submission delivers a **working agentic wallet** that meets the stated requirements:

| Requirement | Delivered |
|-------------|-----------|
| **Create a wallet programmatically** | `WalletManager.createWallet(agentId)` + HD derivation via `KeyVault.registerAgent()` — wallets created on first use, idempotent |
| **Sign transactions automatically** | `KeyVault.sign(SigningRequest)` — agents request signing by agent ID; no manual input; keys never leave the vault |
| **Hold SOL or SPL tokens** | Each agent holds SOL; balances and SPL token accounts exposed via `getWalletInfo()` / `getSolBalance()` |
| **Interact with a test dApp or protocol** | **Orca Whirlpools** (swap execution on devnet), **Solana Memo Program** (on-chain decision log), and **System Program** (SOL transfers between agents and vault) |
| **Deep dive** | [DEEP_DIVE.md](./DEEP_DIVE.md) — wallet design, security model, and how the wallet interacts with AI agents |
| **Open-source, README, setup** | This repo; instructions below |
| **SKILLS.md for agents** | [SKILLS.md](./SKILLS.md) — written for AI agents (and judges) to understand wallet API and safety constraints |
| **Working prototype on devnet** | Yes — run `npm run setup` then `npm run start`; dashboard at `http://localhost:3555` |

**Technical expectations:**

- **Safe key management:** Master seed encrypted at rest (AES-256-GCM + Argon2id); HD derivation (BIP-44); keys zeroed after signing; agents never receive private key bytes.
- **Automated signing without manual input:** All signing is via `KeyVault.sign()` triggered by agent logic; no prompts or CLI steps.
- **AI agent simulation:** Three agents (Accumulator, Flipper, Vault) with scripted + optional LLM rationale; decisions drive trades, vault contributions, and memo logging.
- **Separation of responsibilities:** Agent logic (e.g. `Flipper`, `Accumulator`) lives in `src/agents/`; wallet and signing live in `KeyVault` / `WalletManager` / `TransactionEngine` — agents only call APIs, they do not handle keys or raw transactions.

---

## What makes this submission stand out

1. **Multiple agents, one vault** — **Eight agents by default** (1 vault, 3 accumulators, 4 flippers), each with its own HD-derived wallet and per-agent rate limits. Dashboard and setup scale to the configured list; use `AGENT_IDS` in `.env` to switch to 3 agents or customize. Demonstrates “multiple agents independently” (judging criteria).
2. **Real protocol interaction** — Not a mock. Integrates with **Orca Whirlpools** on devnet for swaps and uses the **Memo program** for an on-chain audit trail of agent decisions.
3. **Security-first design** — Encrypted vault, circuit breakers (rate limit, max SOL per tx, vault floor), and **simulate-before-send** for every transaction. Optional `DRY_RUN` mode for safe demos.
4. **Observability** — Web dashboard (live balances, P&L, decision log) and on-chain memos so agent behavior is auditable.
5. **Recovery and ops** — Balance checks before airdrops to avoid rate limits; vault restore from mnemonic; clear error messages for passphrase/vault issues.

---

## Architecture (one sentence)

Agent logic decides → requests signing from KeyVault (only place keys exist) → TransactionEngine enforces circuit breakers and simulates → transaction sent to devnet → memos written on-chain.

---

## Quick start (devnet)

```bash
git clone <this-repo>
cd agent-colony
npm install

cp .env.example .env
# Set MASTER_PASSPHRASE (32+ chars). Use quotes if it contains '=':
#   MASTER_PASSPHRASE="your-secret-at-least-32-characters"

npm run setup      # Create vault, agent wallets, airdrop SOL on devnet (skips if balances sufficient)
npm run start      # Run colony; dashboard at http://localhost:3555
```

**Dashboard:** For the React dashboard UI (COLONY CONTROL), run `npm run build:dashboard` once; the server then serves it from `dashboard-app/dist`. If that folder is missing, the server falls back to the built-in HTML dashboard.

**Optional:** `DRY_RUN=true npm run start` — agents run and “decide” but no transactions are sent (simulation only).

---

## Project layout

| Area | Role |
|------|------|
| `src/vault/` | KeyVault (encrypted HD seed), crypto (AES-256-GCM, Argon2id) |
| `src/wallet/` | WalletManager (create wallet, balance, airdrop, build transfer) |
| `src/agents/` | Agent logic (Accumulator, Flipper, Vault); extend BaseAgent for new agents |
| `src/transactions/` | TransactionEngine (circuit breakers, simulate, sign, send), RateLimiter |
| `src/coordination/` | MemoLogger (on-chain memos), Oracle (mock price) |
| `src/dex/` | OrcaAdapter (Whirlpools swap integration) |
| `src/dashboard/` | WebDashboard (HTTP server + live UI at DASHBOARD_PORT) |
| `scripts/` | setup-devnet, restore-vault (from mnemonic) |

---

## Documentation

- **[docs/BOUNTY_VERIFICATION.md](./docs/BOUNTY_VERIFICATION.md)** — Code-level verification: every bounty requirement mapped to specific files and lines.
- **[docs/SECURITY_SCORE.md](./docs/SECURITY_SCORE.md)** — Score vs EEA EthTrust, OWASP SCSVS, and Solana best practices; **judges:** run **`npm run test:security`** to run attack-simulation tests.
- **[docs/SECURITY.md](./docs/SECURITY.md)** — Threat model, architecture, audit trail, and key handling in plain language. Start here for security.
- **[docs/RUNBOOK.md](./docs/RUNBOOK.md)** — How to run safely: env vars, commands, safe vs unsafe, and what to do if something goes wrong.
- **[JUDGE_DEMO.md](./JUDGE_DEMO.md)** — Step-by-step 5-minute demo for judges; exact commands and how to verify on Solscan.
- **[DEEP_DIVE.md](./DEEP_DIVE.md)** — Wallet design, security considerations, threat model, and how the wallet interacts with AI agents (written deep dive for the bounty).
- **[DESIGN_CHOICES.md](./DESIGN_CHOICES.md)** — Constraints we imposed, what we skipped (and why), and what was surprisingly hard. Written so judges see real tradeoffs, not a generic feature list.
- **[SKILLS.md](./SKILLS.md)** — For AI agents and reviewers: wallet API, safety constraints, and how to add agents.
- **[CHECKLIST.md](./CHECKLIST.md)** — Pre-submission checklist: env, build, setup, dashboard, on-chain, safety, scripts, and docs.

---

## Devnet

- RPC: `SOLANA_RPC_URL` (default: `https://api.devnet.solana.com`).
- After running, inspect addresses on [Solscan (devnet)](https://solscan.io/?cluster=devnet) using the agent addresses printed by `npm run setup` or shown in the dashboard (addresses on each card link to Solscan).

---

## Limitations (honest tradeoffs)

- **No TEE/HSM** — Keys are encrypted at rest and never exported; we don’t run signing in a hardware enclave. Fine for devnet; production would add TEE or MPC.
- **Mock oracle** — Price feed is local; real deployment would use Pyth/Switchboard or similar. Wallet and signing design are unchanged.
- **Orca integration** — Real devnet Whirlpools swaps; pool/token choice is simplified for the demo.
- **Single machine** — One process, one vault file. Scaling to many machines would need a different key distribution story.

More in [DESIGN_CHOICES.md](./DESIGN_CHOICES.md).

---

## License

ISC.
