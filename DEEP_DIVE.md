# Deep Dive: AI Agent Wallet Design, Security, and Agent Interaction

This document covers three things: how the agentic wallet is designed and why, how security is enforced at every layer, and how AI agents interact with the wallet without ever touching a private key. It is written for the bounty deep dive requirement but also serves as the authoritative technical reference for the codebase.

For setup and on-chain verification, see [SETUP.md](./SETUP.md). For the wallet API and agent extension guide, see [SKILLS.md](./SKILLS.md).

---

## 1. Wallet Design

### 1.1 Core Design: One Seed, Many Agents

The entire colony runs from a single encrypted master seed. Every agent wallet is derived deterministically from that seed — no separate key files, no manual key generation, no per-agent secrets to manage.

```
Master seed (encrypted at rest)
    └── HD derivation: m/44'/501'/{index}'/0'
            ├── index 0  →  vault agent wallet
            ├── index 1  →  funder agent wallet
            ├── index 2  →  pool agent wallet
            ├── index 3  →  trader wallet
            ├── index 4  →  trader2 wallet
            └── index N  →  any future agent (new index, no new secret)
```

This is the same pattern used by multi-account wallets like Phantom — applied to agent identities rather than human accounts. Adding a new agent requires only a new derivation index. Recovery of all agent wallets from a single 24-word phrase is a natural consequence of the design, not an afterthought.

### 1.2 Programmatic Wallet Creation

Wallets are created on demand via `WalletManager.createWallet(agentId)`. The call is idempotent — if a wallet already exists for that agent ID, it returns the existing address. No manual steps, no import flow.

```typescript
// Agents never call this directly — the colony orchestrator handles provisioning
const address = await walletManager.createWallet('trader4');
// Returns the public address. Private key stays in KeyVault.
```

### 1.3 What Each Agent Wallet Holds

Every agent wallet holds:
- **SOL** — for transaction fees and trading capital
- **USDC (SPL)** — the platform stablecoin; used for swaps, pool liquidity, and vault profit

At startup, each trader receives **0.2 SOL + 10,000 USDC** from the funder. The same provisioning runs automatically when a trader is added from the dashboard at runtime. Run `npm run create-usdc-token` after setup to create the USDC mint and fund all agents (see [SETUP.md](./SETUP.md)).

### 1.4 Why This Design

| Design choice | Rationale |
|---|---|
| Single encrypted seed | One secret to back up, one passphrase to manage, one recovery flow |
| HD derivation per agent | Agent isolation without key sprawl; deterministic and auditable |
| No key export API | Agents cannot exfiltrate keys — they request signing, never bytes |
| Idempotent wallet creation | Safe to call repeatedly; no duplicate wallets or orphaned keys |

---

## 2. Security

### 2.1 Encryption at Rest

The master seed is never stored in plaintext. The vault file (`.agent-colony-vault.json`) contains only ciphertext.

**Encryption:** AES-256-GCM — authenticated encryption; tampering with the ciphertext is detectable.

**Key derivation:** Argon2id — a memory-hard KDF that makes brute-force attacks on the passphrase expensive even with GPU hardware. Chosen over PBKDF2 and bcrypt specifically because it resists GPU and ASIC acceleration.

```
MASTER_PASSPHRASE
    → Argon2id (memory-hard, GPU-resistant)
        → 256-bit encryption key
            → AES-256-GCM decrypt
                → master seed (in memory, duration of sign operation only)
```

**Key lifetime in memory:** The seed and all derived keys are held in memory only for the duration of a single signing operation. Buffers are zeroed immediately after use. There is no persistent in-memory key cache.

### 2.2 No Key Export

There is no API to retrieve a private key or the raw seed. The `KeyVault` exposes exactly one signing interface:

```typescript
// The only way to use a key — by agent ID, never by key material
await keyVault.sign({
  agentId: 'trader',
  transaction: tx,
  description: 'SOL → USDC swap, spread trade'
});
```

Agents, adapters, and scripts sit entirely outside the vault. They pass a transaction and an agent ID. The vault derives the key, signs, zeros the buffer, and returns the signed transaction. Nothing else is exposed.

### 2.3 Transaction Safety: Simulate Before Send

Every transaction is simulated against devnet before being broadcast. If simulation fails — insufficient balance, bad instruction, slippage too high — the transaction is dropped and the error is logged. No SOL is spent on failed transactions.

```typescript
// Inside TransactionEngine — enforced for every agent, every transaction
const simulation = await connection.simulateTransaction(tx);
if (simulation.value.err) {
  throw new TransactionSimulationError(simulation.value.err, description);
}
// Only reaches here if simulation passed
await connection.sendRawTransaction(signedTx.serialize());
```

### 2.4 Circuit Breakers

Rate limiting is enforced in `TransactionEngine` — not in agent code. Agents cannot bypass it.

- **Sliding window rate limit:** Maximum transactions per agent per minute (default: 15, configurable via `RATE_LIMIT_TX_PER_MINUTE`). Prevents runaway loops from a buggy or compromised agent.
- **Dry run mode:** When `DRY_RUN=true`, the full decision and simulation pipeline runs, but `sendRawTransaction` is never called. Useful for demos, testing, and stress runs without spending SOL.

The circuit breakers apply uniformly regardless of which agent triggers the transaction. An agent cannot escalate its own limits.

### 2.5 Threat Model

| Threat | Mitigation |
|---|---|
| **Passphrase brute-force** | Argon2id KDF; memory-hard and GPU-resistant |
| **Vault file theft** | AES-256-GCM encryption; ciphertext is useless without the passphrase |
| **Key exfiltration via agent code** | No key export API; agents never receive key material |
| **Prompt injection / malicious oracle data** | Decisions are driven by deterministic rule engine; LLM is used only for optional human-readable rationale, never for authorizing transactions |
| **Runaway agent / buggy logic** | Rate limiting enforced at the transaction layer; agents cannot bypass it |
| **Transaction failure wasting SOL** | Simulate-before-send catches failures before broadcast |
| **Secrets in source code** | `npm run security:check` scans for committed secrets; `.env` and vault file are in `.gitignore` |

---

## 3. How the Wallet Interacts with AI Agents

### 3.1 Separation of Responsibilities

The design enforces a hard boundary between decision logic and wallet logic:

```
┌─────────────────────────────────────┐
│           AGENT LAYER               │
│  Reads oracle, decides action,      │
│  calls wallet API                   │
│  (no keys, no raw tx building)      │
└────────────────┬────────────────────┘
                 │  executeTransaction(agentId, tx, description)
                 ▼
┌─────────────────────────────────────┐
│         TRANSACTION ENGINE          │
│  Rate limit check                   │
│  Simulate against devnet            │
│  Call KeyVault.sign()               │
│  Broadcast                          │
└────────────────┬────────────────────┘
                 │  sign(agentId, tx)
                 ▼
┌─────────────────────────────────────┐
│            KEY VAULT                │
│  Decrypt seed (Argon2id + AES-GCM)  │
│  Derive key for agentId             │
│  Sign transaction                   │
│  Zero key buffer                    │
│  Return signed tx                   │
└─────────────────────────────────────┘
```

This separation means the wallet and security layer can be hardened and audited independently of whatever decision logic agents run.

### 3.2 Automated Signing Flow (No Manual Input)

When an agent decides to act, the full flow runs without human intervention:

1. **Agent logic triggers** on a timer (every 10–60 seconds depending on agent type)
2. **Decision is made** — deterministic rules evaluate oracle data (e.g. spread between pool price and market price)
3. **Transaction is built** — via `WalletManager.buildTransferTransaction()` or Orca adapter
4. **`TransactionEngine.executeTransaction(agentId, tx, description)`** is called
5. **Rate limit checked** — rejected if window is exceeded
6. **Simulated** — rejected if devnet simulation fails
7. **`KeyVault.sign({ agentId, tx })`** called — seed decrypted, key derived, tx signed, buffer zeroed
8. **Broadcast** to devnet
9. **Memo written** — decision rationale logged to Solana Memo program on-chain

The `MASTER_PASSPHRASE` in `.env` is the only credential involved. No human prompt, no approval step, no manual key handling.

### 3.3 Decision-Making: Deterministic Rules, Optional LLM

Agent decisions are driven by deterministic logic — not by an LLM. For example, a trader evaluates whether the spread between pool price and oracle price exceeds a threshold, then decides to buy or sell. This keeps behavior predictable and safe.

The optional `OPENAI_API_KEY` enables an LLM step that generates a human-readable rationale for the decision (e.g. *"Buying SOL: pool price 2.3% below oracle, within risk limits"*). This rationale is written to the Solana Memo program on-chain. The LLM has no ability to authorize or modify transactions — it is purely observational.

This design avoids the prompt injection risk that would exist if an LLM could directly trigger or modify spending decisions.

### 3.4 Scalability: Multiple Independent Agents

Each agent has a distinct `agentId` and a distinct HD derivation index, giving it an isolated wallet and balance. All agents share one `KeyVault` but cannot access each other's keys — signing requests are scoped to `agentId`.

**Default colony (6 agents):**

| Agent ID | Kind | Role |
|---|---|---|
| `vault` | VaultAgent | Profit sink; receives USDC from traders |
| `funder` | FunderAgent | Holds SOL/USDC reserves; tops up other agents |
| `pool` | PoolAgent | Liquidity counterparty for SOL/USDC swaps |
| `trader` | TraderAgent | Autonomous SOL/USDC trader |
| `trader2` | TraderAgent | Autonomous SOL/USDC trader |
| `trader3` | TraderAgent | Autonomous SOL/USDC trader |

**Adding agents:**
- Override `AGENT_IDS` in `.env` (e.g. `AGENT_IDS=vault,funder,pool,trader,trader2,trader3,trader4,trader5`)
- Or use the **Scale the colony** panel on the dashboard at runtime — the funder provisions each new trader automatically (0.2 SOL + 10k USDC)

Because `getAgentKind()` in `agentRegistry.ts` resolves agent type from ID prefix, any `traderN` ID is automatically treated as a trader with no code changes.

**Stress test:** `npm run colony:stress` runs 9+ agents with `DRY_RUN=true` — full decision pipeline, circuit breakers, and simulation run, but no transactions are broadcast.

---

## 4. Design Decisions

### 4.1 HD Derivation vs. Separate Key Files

Per-agent key files would require backing up N secrets, coordinating N passphrases, and managing N recovery flows. HD derivation from a single seed means one backup restores everything. It's the same model used in production multi-account wallets, and it scales to arbitrarily many agents without touching the security model.

### 4.2 Argon2id vs. PBKDF2 / bcrypt

PBKDF2 and bcrypt are parallelizable on GPUs. Argon2id is memory-hard — it requires a minimum amount of RAM per attempt, which makes GPU and ASIC brute-force attacks expensive rather than just slow. For a passphrase-encrypted key vault, this is the right tradeoff.

### 4.3 On-Chain Memos as Audit Trail

Every agent decision is written to the Solana Memo program alongside the transaction it authorizes. This means "who decided what, when, and why" is verifiable on-chain — not just in local logs or the dashboard. A judge can take any wallet address, inspect it on Solscan (devnet), and read the agent's reasoning directly from the transaction.

### 4.4 What a Production System Would Add

This is a devnet prototype. A production deployment would add:

- **Trusted Execution Environment (TEE)** — e.g. Intel SGX or AWS Nitro Enclaves. The vault and signing operation would run inside a hardware-attested enclave, making key exfiltration from a compromised host significantly harder.
- **Multi-party computation (MPC) or threshold signatures** — for high-value agents, require M-of-N participants to authorize a transaction rather than a single vault. No single compromise can produce a valid signature.
- **Hardware Security Module (HSM)** — for institutional deployments, move key material off the host entirely into a dedicated tamper-resistant device.
- **Policy engine** — declarative per-agent spending rules (max transaction size, allowed programs, allowed counterparties) enforced before signing.

---

## 5. Verifying the Claims

Each major claim in this document maps to something inspectable:

| Claim | How to verify |
|---|---|
| Agents have independent on-chain wallets | `npm run show-agent-addresses` or dashboard — each card shows a unique address |
| Real transactions on devnet | Click any address on the dashboard → Solscan devnet → recent transactions |
| Memo-logged decisions | Solscan → any tx → "Memo" instruction → agent rationale in plaintext |
| Orca Whirlpools swaps | Solscan → trader wallet → filter by Orca Whirlpools program ID |
| Rate limiting enforced | `npm test` — circuit breaker tests pass; `npm run test:security` |
| Simulate-before-send | `src/transactions/TransactionEngine.ts` — simulation precedes every broadcast |
| No key export API | `src/vault/KeyVault.ts` — no method returns key material; only `sign()` is exposed |
| Argon2id + AES-256-GCM | `src/vault/crypto.ts` |