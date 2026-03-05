# 5-minute judge demo

If you're evaluating this submission, here's a direct path to see the agentic wallet running on devnet. No guesswork.

---

## 1. One-time setup (~2 min)

```bash
git clone <repo-url>
cd agent-colony
npm install
cp .env.example .env
```

Edit `.env`: set **one** variable (required):

```env
MASTER_PASSPHRASE="judge-demo-passphrase-must-be-at-least-32-chars"
```

(Use any 32+ character string; this is for local vault encryption only.)

Then:

```bash
npm run setup
```

You should see: vault initialized (recovery phrase printed once), three wallet addresses created, and airdrop attempts. If devnet rate-limits airdrops, the script still finishes and prints balances (you can use [faucet.solana.com](https://faucet.solana.com) for the printed addresses if needed).

---

## 2. Run the colony (~1 min)

```bash
npm run start
```

- Terminal: vault init (or "already initialized"), wallet creation, then "Dashboard: http://localhost:3555".
- Open **http://localhost:3555** in a browser.

You should see:

- **Header:** block height, SOL/USDC price, uptime.
- **Three agent cards:** vault, accumulator, flipper — each with SOL balance, trades, P&L, vault contributions.
- **Live decision log:** new lines as agents decide (e.g. HOLD, BUY, TRANSFER_TO_VAULT, or swap/trade messages).

Agents tick every 10–60 seconds. Within 1–2 minutes you should see at least a few log lines and balance updates.

---

## 3. Verify it's real (on-chain)

- **Addresses:** In the dashboard, each card effectively shows the wallet for that agent. The same addresses were printed by `npm run setup` (vault, accumulator, flipper).
- **Solscan:** Open [Solscan (devnet)](https://solscan.io/?cluster=devnet) and paste one of those addresses (or click an address on a dashboard card). You’ll see SOL balance and transaction history.
- **Memos:** When an agent logs a decision, we send a **Memo program** transaction. In Solscan, open a recent transaction for an agent address; the memo content is the decision/rationale (on-chain audit trail).
- **Orca (flipper):** If the flipper agent executes a swap, you’ll see a swap tx on its address (Orca Whirlpools program). Depends on devnet liquidity and agent timing.

---

## 4. Optional: dry run

To see agents “decide” without sending any transactions:

```bash
DRY_RUN=true npm run start
```

Dashboard and logs still update; no SOL is spent and no txs are broadcast. Useful if airdrops failed and you don’t want to use the faucet.

---

## 5. Run security (attack-simulation) tests

To verify that the system **blocks** common attacks (rate limit, max SOL, vault floor, simulation failure, dry run, unregistered agent, no secret leakage):

```bash
npm run test:security
```

All tests should **pass** (each test simulates an attack and asserts the attack is blocked). See [docs/SECURITY_SCORE.md](./docs/SECURITY_SCORE.md) for what each test does and how the project scores against EEA EthTrust, OWASP SCSVS, and Solana best practices.

---

## 6. What to score

- **Wallet creation:** Three distinct wallets (three addresses from `npm run setup` and in the dashboard).
- **Automatic signing:** No prompts or manual steps; agents sign via the vault when they decide to act (see log + Solscan txs).
- **Hold SOL / interact with protocol:** Balances on dashboard and Solscan; memos and (when applicable) Orca swaps on-chain.
- **Security / key management:** Keys are encrypted (vault file), never exported; circuit breakers and simulation are described in [DEEP_DIVE.md](./DEEP_DIVE.md). Run **`npm run test:security`** to see attack-simulation tests pass.

If anything in this script doesn’t work on your machine, open an issue or contact the submitter — the goal is a reproducible 5-minute path.
