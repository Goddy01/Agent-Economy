# Setup and run - How to run the colony

This is the single guide for **setting up**, **running**, and **verifying** the agent colony. Use it for first-time setup, judges evaluating the demo, or day-to-day operations.

---

## 1. One-time setup

```bash
git clone <repo-url>
cd agent-colony
npm install

cp .env.example .env
```

Edit `.env` and set **one required variable**:

```env
MASTER_PASSPHRASE="your-secret-at-least-32-characters"
```

Use at least 32 characters. To generate one: run `npm run generate-passphrase` and paste the printed line into `.env`. Never commit `.env` or `.agent-colony-vault.json` to git.

**Optional:** Recovery phrase - only needed if you lose the vault file. Set `RECOVERY_PHRASE="word1 word2 ... word24"` in `.env` when running restore (see Commands). Don’t commit it.

After first run or `npm run setup`, the file `.agent-colony-vault.json` is created (encrypted key material). Keep it and `.env` only on machines you trust.

---

## 2. Full demo with USDC (recommended for judges)

To see the full system (SOL/USDC trading, USDC balances on pool, funder, and traders):

```bash
npm run setup
npm run create-usdc-token
npm run build:dashboard && npm run start
```

- **npm run setup** creates the encrypted vault and agent wallets and airdrops SOL where needed.
- **npm run create-usdc-token** creates a new USDC SPL mint on devnet (platform stablecoin), updates `USDC_MINT` in `.env`, mints USDC to the funder, and transfers the pool's share to the pool. **Top up the funder wallet with SOL first** (the funder pays for mint creation and token accounts). Run after setup for the full demo. Each run creates a new USDC mint; re-run when you want a fresh mint (e.g. after a devnet reset).
- **npm run build:dashboard && npm run start** builds the React dashboard and starts the colony.

**Funder (source of SOL):** Send SOL (devnet) to the funder’s wallet address (shown by `npm run setup` and on the dashboard as “Funder (send SOL here)”). You must top up the funder with SOL before running **npm run create-usdc-token** (the funder pays for mint and token account creation). At startup, each trader is funded with **0.2 SOL** and **10k USDC** (one-time from the funder); new traders added from the dashboard get the same. The funder holds SOL and USDC reserves and tops up the pool and traders. Send SOL to the funder wallet (see dashboard or `npm run setup`). Non-traders use **TARGET_AGENT_SOL** (default 1.0); traders use 0.2 SOL (**FUNDER_TRADER_TARGET_SOL**).

---

## 3. What you’ll see

When the colony has started:

- Terminal: a line like `Dashboard: http://localhost:3555` and periodic agent tick logs.
- Browser: open **[http://localhost:3555](http://localhost:3555)**. Header shows block height, SOL/USDC price, and that USDC is the platform stablecoin. **Scale the colony** panel adds traders. **Treasury, Funding & Pool**: vault (USDC balance), funder (SOL and USDC reserves, outbound SOL), pool (SOL and USDC). **Traders**: each card shows SOL and **USDC Balance**; volume (in USD when price available), P&L, and trading history. Vault card shows **USDC Balance**. Default: vault + funder + pool + 3 traders (6 agents).

Agents tick on the interval set by **COLONY_TICK_MS** (default 10–60s per agent type). Within 1–2 minutes you should see decisions and balance updates.

---

## 4. Environment variables


| Variable                     | What it does                                                                                                                                              | Example / default                                    |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| **MASTER_PASSPHRASE**        | Decrypts the vault and derives agent keys. **Required.**                                                                                                  | At least 32 chars; use `npm run generate-passphrase` |
| **RECOVERY_PHRASE**          | 24-word recovery phrase shown once during `npm run setup`. Use this to restore your vault if `.agent-colony-vault.json` is lost. Only set when restoring. | `"word1 word2 ... word24"`                           |
| **SOLANA_RPC_URL**           | Which Solana RPC to use.                                                                                                                                  | `https://api.devnet.solana.com`                      |
| **USDC_MINT**                | SPL mint for USDC (full demo). Set by `npm run create-usdc-token`.                                                                                        | (added by script)                                    |
| **RATE_LIMIT_TX_PER_MINUTE** | Max transactions per agent per minute.                                                                                                                    | `15`                                                 |
| **DRY_RUN**                  | If `true`, simulate and log but **never send** transactions.                                                                                              | `false`                                              |
| **TARGET_AGENT_SOL**         | Target SOL for non-trader agents (funder tops up pool, etc.). Traders use **FUNDER_TRADER_TARGET_SOL** (0.2).                                             | `1.0`                                                |
| **INITIAL_TRADER_SOL**       | One-time SOL per trader at startup and when adding from dashboard.                                                                                        | `0.2`                                                |
| **FUNDER_TRADER_TARGET_SOL** | Funder tops up traders to this SOL level.                                                                                                                 | `0.2`                                                |
| **COLONY_TICK_MS**           | Base tick interval (ms) for agent decision loops.                                                                                                         | e.g. `3000`                                          |
| **DASHBOARD_REFRESH_MS**     | How often the dashboard polls for updates (ms).                                                                                                           | `3000`                                               |
| **OPENAI_API_KEY**           | Optional; enables LLM rationale text.                                                                                                                     | (optional)                                           |


---

## 5. Commands


| Command                                  | What it does                                                                                               |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| **npm install**                          | Install dependencies. Run once (or after pulling).                                                         |
| **npm run setup**                        | Create vault and agent wallets on devnet; airdrop SOL if needed. Run once before first start.              |
| **npm run create-usdc-token**            | Create a new USDC SPL token and set `USDC_MINT` in `.env`. Top up funder with SOL first (funder pays for mint). Each run creates a new mint. Required for full demo. Run after setup. |
| **npm run start**                        | Start colony and dashboard. Dashboard: [http://localhost:3555](http://localhost:3555) (or DASHBOARD_PORT). |
| **npm run colony:dry**                   | Same as `DRY_RUN=true npm run start` - no transactions sent.                                               |
| **npm run demo**                         | One-shot: setup → build dashboard → start (create USDC separately if needed).                              |
| **npm run build**                        | Compile TypeScript (backend).                                                                              |
| **npm run build:dashboard**              | Build React dashboard. Run if dashboard doesn’t load.                                                      |
| **npm run generate-passphrase**          | Print a secure passphrase line to add to `.env`.                                                           |
| **npm run restore-vault**                | Restore vault from 24-word recovery phrase (`RECOVERY_PHRASE` in `.env`).                                  |
| **npm run recover-agent-sol**            | Sweep SOL from legacy agent wallets into vault or `SWEEP_TO_ADDRESS`.                                      |
| **npm run sweep-to-funder**              | Move SOL to the funder wallet.                                                                             |
| **npm run show-agent-addresses**         | Print all agent wallet addresses.                                                                          |
| **npm run check-balances**               | Show SOL and USDC (if configured) for all agents.                                                          |
| **npm run teardown --** <WALLET-ADDRESS> | Sweep agent SOL to address and remove local vault. Use `--dry-run` to preview.                             |
| **npm run colony:stress**                | Run with many traders in DRY_RUN (scale test, no tx sent).                                                 |
| **npm test**                             | Run test suite (including circuit breakers).                                                               |
| **npm run test:security**                | Run security and transaction tests.                                                                        |
| **npm run security:check**               | Check for secrets in code and run dependency audit.                                                        |


---

## 6. Scale the colony (scalability)

- **4-agent:** `AGENT_IDS=vault,funder,pool,trader` then `npm run setup` and `npm run start`.
- **6-agent (default):** Leave `AGENT_IDS` unset.
- **Add traders at runtime:** Use the **Scale the colony** panel on the dashboard: choose a Preset (or Custom), then **Add agents to colony**. Each click adds a new trader; funder Outbound shows on-chain scaling.
- **9+ stress (dry run):** `npm run colony:stress` - many agents, no transactions sent.

---

## 7. Verify on-chain

- **Addresses:** Each dashboard card shows the wallet address; same as printed by `npm run setup` or `npm run show-agent-addresses`.
- **Solscan:** Click an address or paste into [Solscan devnet](https://solscan.io/?cluster=devnet). Check SOL and recent transactions.
- **Memos:** Many transactions include a Memo program instruction with agent decision/rationale (on-chain audit trail).
- **Orca:** Trader swaps show Orca Whirlpools program transactions (depends on devnet liquidity).

---

## 8. Safe vs unsafe

**Safe:** Devnet with your own `.env` and vault file; `DRY_RUN=true` or `npm run colony:dry` to test without sending tx; keeping `.env` and `.agent-colony-vault.json` off git and only on your machine; running `npm run security:check` and `npm test` before pushing.

**Unsafe:** Putting `MASTER_PASSPHRASE` (or any secret) in source code; committing `.env` or `.agent-colony-vault.json`; using mainnet or real funds before a security review; sharing passphrase or vault file.

---

## 9. If something goes wrong

- **“MASTER_PASSPHRASE must be set”** - Add a long passphrase to `.env`. Use quotes if it contains `=` or spaces.
- **“Vault not initialized” / missing vault file** - Run `npm run setup` once. If you lost the vault, use `npm run restore-vault` with `RECOVERY_PHRASE` set in `.env`.
- **Transactions blocked (rate limit)** - Circuit breakers are working. Adjust limits in `.env` only if you understand the risk.
- **Dashboard not loading** - Run `npm run build:dashboard`, then `npm run start`.
- **SOL in legacy agent wallets from an older config** - Run `npm run recover-agent-sol` (optional: `SWEEP_FROM_AGENTS`, `SWEEP_TO_ADDRESS`, `MIN_SOL` in `.env`).

For wallet design, security model, and how the wallet interacts with AI agents, see [DEEP_DIVE.md](./DEEP_DIVE.md).