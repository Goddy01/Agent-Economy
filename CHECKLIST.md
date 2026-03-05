# Pre-submission checklist

Use this list to confirm everything works and nothing is broken before you run the demo or submit.

---

## 1. Environment and build

- [ ] `.env` exists with `MASTER_PASSPHRASE` (at least 32 characters). Optional: `SOLANA_RPC_URL`, `DASHBOARD_PORT`, `DRY_RUN`, etc.
- [ ] `npm install` completes without errors; `postinstall` (rpc-websockets patch) runs.
- [ ] `npx tsc --noEmit` passes (no TypeScript errors).
- [ ] `npm test` passes (or at least `tests/vault.test.ts`).

---

## 2. Setup script (`npm run setup`)

- [ ] Script runs; vault initializes or reports "already initialized."
- [ ] If new vault: recovery phrase is printed once; no crash.
- [ ] All three agent wallets are created (vault, accumulator, flipper) and addresses are printed.
- [ ] Balances are printed (0.0000 SOL if no faucet yet).
- [ ] If any balance is 0: single line appears with "Wallets with no SOL: ... Get devnet SOL at https://faucet.solana.com/ ... addresses above." (no duplicate address list).
- [ ] No automatic airdrop is requested.

---

## 3. Running the colony (`npm run start`)

- [ ] Startup completes: "Initializing Agent Colony", vault check, wallet creation, balance check.
- [ ] If wallets have no SOL: faucet message is shown; app still continues and starts agents + dashboard.
- [ ] Dashboard URL is printed (e.g. `http://localhost:3555`).
- [ ] No uncaught exception; process keeps running until SIGINT.

---

## 4. Web dashboard

- [ ] Opening the dashboard URL in a browser loads the page (title: "Agent Colony — SOLANA DEVNET" or similar).
- [ ] Header shows: Block (number), SOL/USDC (price), Up (uptime). Optional: DRY RUN badge if `DRY_RUN=true`.
- [ ] Three agent cards + Vault Status + Safety Guardrails card are visible.
- [ ] Each agent card shows balance (SOL), trades, P&L, vault contributions (values may be 0).
- [ ] Safety card shows "Blocked tx: N" and recent blocked reasons (or "No blocked transactions yet").
- [ ] "Download session audit (JSON)" button is present and, when clicked, downloads a JSON file (e.g. `audit-<sessionId>.json`).
- [ ] Live decision log area shows lines (or "Waiting for agent decisions...") and updates over time when agents tick.
- [ ] No console errors in the browser that break the page.

---

## 5. Agents and RPC

- [ ] With SOL in wallets: decision log shows activity (decisions/trades) for accumulator and flipper.
- [ ] No repeated "[time] flipper ERROR: ... failed to get balance" (or similar) filling the log; balance failures are handled (retry then 0).
- [ ] 429 / rate-limit noise from Solana RPC is suppressed in the terminal (no "Server responded with 429 ... Retrying" spam).

---

## 6. On-chain (devnet)

- [ ] Memos: after some agent decisions, at least one memo transaction appears on an agent address on Solscan (devnet). Memo payload includes `sessionId` (and agent, type, reason, ts).
- [ ] Transfers: if vault contributions or transfers occur, corresponding SOL transfer transactions appear on Solscan.
- [ ] Session audit JSON contains `sessionId`, `signatures` (when there are successful txs), `blockedReasons`; pasting a signature from the JSON into Solscan shows the transaction.

---

## 7. Safety and dry run

- [ ] `DRY_RUN=true npm run start` (or `npm run colony:dry`): colony runs, dashboard updates, but no transactions are broadcast (no new memos/transfers on Solscan from this run).
- [ ] When a transaction would violate a circuit breaker (e.g. vault floor, rate limit, max SOL), it is blocked and the Safety panel shows the blocked count and reason (or log shows BLOCKED).

---

## 8. Scripts

- [ ] `npm run restore-vault`: with `MASTER_PASSPHRASE` and `RECOVERY_PHRASE` (or `MNEMONIC`) set, restores vault and prints the same three agent addresses and their balances. No crash.
- [ ] `npm run teardown`: runs without breaking the repo (e.g. only clears local state if applicable; or is documented as optional).

---

## 9. Documentation

- [ ] README Quick start matches current flow: e.g. `npm run setup`, then get SOL from faucet if needed, then `npm run start`; dashboard port and URL are correct.
- [ ] JUDGE_DEMO.md steps are accurate: commands, what to look for on the dashboard, how to verify on Solscan, optional dry run.
- [ ] README or JUDGE_DEMO states that the dashboard SOL/USDC price is from a mock oracle (not live market).
- [ ] No broken links in README, SUBMISSION.md, JUDGE_DEMO.md, DEEP_DIVE.md, DESIGN_CHOICES.md, SKILLS.md.
- [ ] SUBMISSION.md requirement checklist uses [x] (or equivalent), not emojis.

---

## 10. Submission hygiene

- [ ] No emojis in code or scripts (Orchestrator, WebDashboard, setup-devnet, restore-vault, etc.).
- [ ] No automatic airdrop: balance check + faucet message only.
- [ ] `.env` is in `.gitignore`; no secrets committed.
- [ ] `.agent-colony-vault.json` is in `.gitignore` (if present).

---

## Quick smoke test (minimal path)

1. `npm install && npx tsc --noEmit`
2. `npm run setup` — note the three addresses; if 0 SOL, get SOL from https://faucet.solana.com/ for each.
3. `npm run start` — open dashboard URL; confirm cards and Safety panel and audit button; let it run 1–2 minutes; check for errors in terminal and browser.
4. Optionally: open Solscan (devnet), paste an agent address (or use the dashboard links), confirm recent memo or transfer.
5. Optionally: `npm run colony:dry` — confirm no new on-chain txs.

If all of the above pass, the project is in good shape for demo or submission.
