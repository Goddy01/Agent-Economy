# Security Overview (Plain-Language Guide)

This document explains **what we protect**, **how the system is built**, and **what we record**—so you and future auditors can understand the security posture without being technical.

---

## 1. Threat Model (What Could Go Wrong?)

Think of this as: *“What are we afraid of, and what do we do about it?”*

### What we care about (assets)

| Asset | What it is | Why it matters |
|-------|------------|----------------|
| **Master passphrase** | The one secret you put in `.env` | Anyone with this can derive all agent keys and move SOL. |
| **Vault file** | `.agent-colony-vault.json` (encrypted key material) | With your passphrase, this file lets the system sign. Without passphrase it’s useless. |
| **SOL in agent and vault wallets** | Real SOL on devnet (or mainnet later) | Theft or accidental drain is the main financial risk. |
| **Agent decisions and trades** | Who did what and when | We need a clear record for audits and debugging. |

### Main threats we guard against

1. **Someone steals the master passphrase**  
   - **Mitigation:** Passphrase lives only in `.env` on your machine; we never log it or send it anywhere. Never commit `.env` to git.

2. **An agent or bug sends too much SOL in one go**  
   - **Mitigation:** Circuit breaker: no single transaction can exceed `MAX_TX_SOL` (e.g. 0.5 SOL). Configurable in `.env`.

3. **Too many transactions in a short time (abuse or bug)**  
   - **Mitigation:** Rate limit: at most `RATE_LIMIT_TX_PER_MINUTE` transactions per agent per minute.

4. **Vault balance drops below a safe floor**  
   - **Mitigation:** Vault floor: the “vault” agent cannot send SOL if that would leave the vault below `VAULT_FLOOR_SOL`. Other agents can still send SOL *to* the vault.

5. **Broken or malicious transaction (e.g. bad instruction)**  
   - **Mitigation:** Every transaction is **simulated** on the RPC before we sign and send. If simulation fails, we never send.

6. **We don’t know what happened**  
   - **Mitigation:** Decisions and trades are logged in the dashboard and (when not in dry run) as on-chain memos, so there’s an audit trail.

### What we don’t protect against (honest trade-offs)

- **Someone with access to your server and `.env`** can run the colony and sign. We don’t use a hardware security module (HSM). Fine for devnet; production would need stronger key custody.
- **RPC or network issues** can cause failed or delayed transactions. We retry where it makes sense but don’t guarantee delivery.
- **Oracle / price feed** is a mock. Wrong or manipulated prices could lead to bad trading decisions. Real deployment would use a real oracle (e.g. Pyth).

---

## 2. Architecture (How the Pieces Fit Together)

A simple “who talks to whom” picture:

```
You (human)
  └── .env (MASTER_PASSPHRASE, RPC URL, limits)  ← only on your machine, never in code

KeyVault (reads .env and vault file)
  └── Decrypts vault file with passphrase
  └── Derives one key per agent (accumulator, flipper, vault)
  └── Signs transactions when agents ask — keys never leave the vault process

Agents (Accumulator, Flipper, Vault)
  └── Decide “should I trade / send to vault?”
  └── Build transaction (e.g. transfer SOL, or swap)
  └── Ask TransactionEngine to run it (they never see private keys)

TransactionEngine
  └── 1) Rate limit check
  └── 2) “Is this tx over MAX_TX_SOL?” → block if yes
  └── 3) If agent is vault: “Would vault balance go below floor?” → block if yes
  └── 4) Simulate on Solana RPC → if fail, stop
  └── 5) Ask KeyVault to sign, then send to network

Dashboard
  └── Shows balances, logs, P&L
  └── Reads from in-memory state (no secrets in API)
  └── /api/state and /api/audit — no authentication in this prototype (local use)
```

**Important:** Only the **KeyVault** ever sees the master passphrase and derived keys. Agents and the dashboard never see private keys; they only request “sign this transaction” by agent ID.

---

## 3. Audit Trail (What We Log and Where)

So you (or an auditor) can answer “what did the system do?”:

| Where | What’s recorded |
|-------|------------------|
| **Dashboard (Live Decision Stream)** | Every decision and trade: time, agent, message (e.g. “Sent 0.005 SOL to vault”), and a link to the transaction on Solscan when we have a signature. |
| **Dashboard (in memory)** | Recent logs; full state and logs are also exposed via `/api/state` for the UI. |
| **Audit API** | `GET /api/audit` returns a JSON snapshot: session id, start time, blocked count, blocked reasons, list of transaction signatures, and recent logs. Useful for export and evidence. |
| **On-chain (Solana memos)** | When not in dry run, we attach a memo instruction to important transactions (e.g. vault contribution, swap). The memo contains agent id, decision type, reason, timestamp, session id—so it’s verifiable on-chain. |

We do **not** log the master passphrase, private keys, or raw key material anywhere.

---

## 4. Key Handling (How We Treat the Master Secret)

- **Where the passphrase lives:** Only in the `.env` file (or environment variables) on the machine where the colony runs. It is never written into source code or committed to git.
- **How it’s used:** The KeyVault reads it at startup, uses it to decrypt the vault file and to derive agent keys. After a signing operation, we don’t keep key material in memory longer than needed.
- **Vault file:** `.agent-colony-vault.json` holds encrypted state (including the derived seed). Without the passphrase, this file is not usable. Keep it and `.env` out of version control and backups that you don’t trust.

---

## 5. Safe vs Unsafe (Quick Reference)

- **Safe:** Running on devnet with your own `.env` and vault file; using `DRY_RUN=true` to test without sending real transactions; keeping `.env` and vault file only on your machine.
- **Unsafe:** Putting `MASTER_PASSPHRASE` (or any secret) in source code; committing `.env` or `.agent-colony-vault.json` to git; using mainnet or real SOL until you’ve had a security review.

For day-to-day runbook (how to run, which env vars to set), see [RUNBOOK.md](./RUNBOOK.md).

---

## 6. What We Test (Security-Relevant)

We have automated tests that guard important safety behavior so that changes to the code don’t accidentally weaken protection.

| What we test | Why it matters |
|--------------|----------------|
| **Max SOL per transaction** | Transactions over `MAX_TX_SOL` are blocked before signing or sending. |
| **Rate limit** | After the allowed number of transactions per minute, further transactions are blocked. |
| **Vault floor** | When the “vault” agent tries to send SOL, we block if the vault balance would go below the floor. Other agents are not limited by the vault floor for their own sends. |
| **Dry run** | When `DRY_RUN` is true, we never call sign or send: the engine returns success after simulation only. So “dry run” mode cannot move real SOL. |

You can run all tests with: **`npm test`**. Running tests regularly (e.g. before pushing code) helps catch regressions in these safeguards.
