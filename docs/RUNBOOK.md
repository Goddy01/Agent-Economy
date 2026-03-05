# Runbook — How to Run the Colony Safely

This is a short, non-technical guide to **running the system** and **what each setting does**. Use it when you’re setting up a new machine or onboarding someone.

---

## Before You Run (Checklist)

1. **Copy the example env file**  
   - From the project root: copy `.env.example` to `.env`.  
   - Never commit `.env` to git (it’s already in `.gitignore`).

2. **Set the master passphrase**  
   - Open `.env` and set `MASTER_PASSPHRASE` to a long, random string (at least 32 characters).  
   - To generate one: run `npm run generate-passphrase` and paste the line it prints into `.env`.

3. **Optional: recovery phrase**  
   - Only needed if you lose the vault file and want to restore from a 24-word phrase.  
   - If you have one, you can set `RECOVERY_PHRASE="word1 word2 ... word24"` in `.env` when running restore (see below). Don’t commit this.

4. **Vault file**  
   - After first run (or after `npm run setup`), the file `.agent-colony-vault.json` is created. It stores encrypted key material.  
   - Do **not** commit this file to git. Keep it and `.env` only on machines you trust.

5. **Funder agent (source of SOL)**  
   - The colony includes a **funder** agent by default. Send SOL to the funder’s wallet address (shown by `npm run setup` and on the dashboard as “Funder (send SOL here)”). The funder distributes SOL to the other agents so they can operate. No private key in `.env` is required. Optionally set **TARGET_AGENT_SOL** (default 1.0) for how much SOL each agent is topped up to.

---

## Environment Variables (What They Do)

| Variable | What it does | Example / default |
|----------|----------------|-------------------|
| **MASTER_PASSPHRASE** | The one secret that decrypts the vault and derives agent keys. **Required.** | At least 32 characters; use `npm run generate-passphrase` |
| **SOLANA_RPC_URL** | Which Solana RPC to use. | `https://api.devnet.solana.com` (devnet) |
| **MAX_TX_SOL** | Maximum SOL value per single transaction. Circuit breaker. | `0.5` |
| **RATE_LIMIT_TX_PER_MINUTE** | Max transactions per agent per minute. Circuit breaker. | `10` |
| **VAULT_FLOOR_SOL** | Vault wallet is not allowed to go below this balance. Circuit breaker. | `5.0` |
| **DRY_RUN** | If `true`, we simulate and log but **never send** transactions. Safe for testing. | `false` (set to `true` for safe demos) |
| **DASHBOARD_PORT** | Port for the web dashboard. | `3555` |
| **TARGET_AGENT_SOL** | Target SOL per agent. The funder agent tops up others to this amount. Send SOL to the funder wallet (no key in .env). | `1.0` |
| **OPENAI_API_KEY** | Optional. If set, agents can use LLM for “rationale” text; system runs without it. | (optional) |

---

## Commands (What to Run)

| Command | What it does |
|---------|----------------|
| **npm install** | Install dependencies. Run once (or after pulling changes). |
| **npm run setup** | Create vault and agent wallets on devnet, airdrop SOL if needed. Run once before first `npm run start`. |
| **npm run start** | Start the colony and dashboard. Dashboard: http://localhost:3555 (or your DASHBOARD_PORT). |
| **DRY_RUN=true npm run start** | Same as start, but **no transactions are sent**. Good for testing or demos without moving SOL. |
| **npm run generate-passphrase** | Generate a secure passphrase and print the line to add to `.env`. |
| **npm run restore-vault** | Restore vault from your 24-word recovery phrase (set `RECOVERY_PHRASE` in `.env`). Only if you lost the vault file. |
| **npm run recover-agent-sol** | Sweep SOL from legacy agent wallets (`accumulator`, `flipper`) into the vault. Use after switching to 8-agent setup. Optional: `SWEEP_FROM_AGENTS`, `SWEEP_TO_ADDRESS`, `MIN_SOL` in `.env`. |
| **npm test** | Run the test suite (including circuit breaker tests). |
| **npm run security:check** | Check for accidental secrets in code and run dependency audit. Run before committing. |

---

## Safe vs Unsafe (Quick Reference)

**Safe:**

- Running on **devnet** with your own `.env` and vault file.
- Using **DRY_RUN=true** when you want to see behavior without sending transactions.
- Keeping `.env` and `.agent-colony-vault.json` only on your machine and out of git.
- Running **npm run security:check** and **npm test** before pushing code.

**Unsafe:**

- Putting **MASTER_PASSPHRASE** (or any secret) **in source code**.
- **Committing** `.env` or `.agent-colony-vault.json` to git.
- Using **mainnet** or real funds before a security review.
- Sharing your passphrase or vault file with anyone.

---

## If Something Goes Wrong

- **“MASTER_PASSPHRASE must be set”**  
  Add a long passphrase to `.env` (see above). Use quotes if it contains `=` or spaces.

- **“Vault not initialized” / missing vault file**  
  Run `npm run setup` once. If you had a vault before and lost the file, use `npm run restore-vault` with `RECOVERY_PHRASE` set in `.env`.

- **Transactions blocked (rate limit / max SOL / vault floor)**  
  That’s the circuit breakers doing their job. Adjust limits in `.env` only if you understand the risk; for devnet, defaults are fine.

- **Dashboard not loading**  
  Build it once: `npm run build:dashboard`. Then run `npm run start`; the server serves the dashboard from `dashboard-app/dist`.

- **I had SOL in the old accumulator/flipper wallets; now I use 8 agents**  
  Run **`npm run recover-agent-sol`**. It sends SOL from any registered `accumulator` and `flipper` wallets into the vault (or into `SWEEP_TO_ADDRESS` if set). Only agents that already exist in your vault are used; it does not create new wallets.

For a deeper picture of threats and design, see [SECURITY.md](./SECURITY.md).
