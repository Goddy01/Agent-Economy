# Deep Dive: AI Agent Wallet Design, Security, and Agent Interaction

This document is the **written deep dive** for the bounty: it explains wallet design, security considerations, and how the agentic wallet interacts with AI agents in a secure, sandboxed environment.

---

## 1. Wallet design

### 1.1 What we built

- **One encrypted master seed** — Stored in a single file (e.g. `.agent-colony-vault.json`), encrypted with AES-256-GCM. The key for decryption is derived from a passphrase using Argon2id (no raw seed or private keys on disk).
- **HD derivation for agent keys** — Each agent gets a deterministic key from the same seed via BIP-44–style paths: `m/44'/501'/{index}'/0'`. Index 0 = vault, 1 = accumulator, 2 = flipper. Adding agents only requires new indices; no new secrets.
- **Programmatic wallet creation** — Wallets are created on demand: `WalletManager.createWallet(agentId)` (idempotent). The vault either derives a new key for that agent or returns the existing address. No manual key generation or import.
- **Wallet capabilities** — Each agent wallet can hold SOL and SPL tokens, request airdrops (devnet), build and sign transfers, and sign arbitrary transactions (e.g. Orca swaps, memo instructions) via a single signing API.

### 1.2 Why this design

- **Single secret to manage** — One passphrase (and one recovery phrase) backs all agent keys; operations and recovery are simpler than per-agent key storage.
- **Agent isolation without key sprawl** — Agents are isolated by derivation path and by the fact they never see private key bytes; only the vault holds the seed and performs signing.
- **Auditability** — All agent decisions can be written on-chain (memos); the dashboard and RPC allow observing balances and history per agent.

---

## 2. Security considerations

### 2.1 Key management and storage

| Concern | Approach |
|--------|----------|
| **At-rest protection** | Master seed encrypted with AES-256-GCM; encryption key derived from passphrase via Argon2id (memory-hard, GPU-resistant). |
| **No key export** | There is no API to export private keys or the seed. Agents only get public addresses and request signing by agent ID. |
| **Key lifetime in memory** | Seed and derived keys are used only for the duration of a sign operation; buffers are zeroed immediately after use. |
| **Recovery** | One-time recovery phrase (BIP-39) shown at vault creation; restore flow allows re-creating the vault from that phrase so the same addresses (and funds) are recoverable. |

### 2.2 Transaction safety (sandboxing)

- **Simulate before send** — Every transaction is simulated before being sent. Failures are caught before any SOL is spent.
- **Circuit breakers** — Enforced in a single place (`TransactionEngine`), not in agent code:
  - **Rate limit** — Sliding window cap (e.g. 10 tx/min) to prevent runaway loops.
  - **Max SOL per transaction** — Caps the size of any single transfer or swap.
  - **Vault floor** — The vault agent cannot send transactions that would drop its balance below a configured floor (e.g. 5 SOL); the circuit breaker blocks such txs.
- **Dry run mode** — When `DRY_RUN=true`, agents run and “decide” but no transaction is broadcast; only simulation runs. Useful for demos and testing without spending SOL.

### 2.3 Threat model (summary)

- **Prompt injection / malicious oracle data** — Mitigated by using a deterministic rule engine for decisions; the LLM is used only for optional rationale, not for authorizing spends.
- **Key exfiltration** — Mitigated by encrypted storage, no export API, and zeroing of key material after use.
- **Runaway agent / buggy logic** — Mitigated by rate limits, value caps, and vault floor enforced in the transaction layer, so agents cannot bypass them.

---

## 3. How the wallet interacts with AI agents

### 3.1 Separation of responsibilities

- **Agents** (e.g. in `src/agents/`) contain the “brain”: they read oracles, decide (e.g. buy, sell, transfer to vault), and call wallet/transaction APIs. They do **not** hold keys, build raw transactions (except via helpers), or sign.
- **Wallet / signing layer** (`KeyVault`, `WalletManager`, `TransactionEngine`) holds keys, creates or accepts transactions, enforces limits, simulates, and signs. Agents only invoke methods like `createWallet`, `getSolBalance`, `buildTransferTransaction`, and `executeTransaction`.

This keeps “AI” logic (decisions, rationale) separate from “wallet” logic (keys, signing, safety checks), so the agentic wallet can be reasoned about and hardened independently.

### 3.2 Automated transaction signing (no manual input)

- Agents run on a timer (e.g. every 10–60 seconds). When an agent decides to act, it:
  1. Builds or obtains a transaction (e.g. via `WalletManager.buildTransferTransaction` or Orca adapter).
  2. Calls `TransactionEngine.executeTransaction(agentId, transaction, description)`.
  3. The engine checks rate limit, value cap, and (for vault) floor; simulates; then calls `KeyVault.sign({ agentId, transaction, description })`.
  4. The vault decrypts the seed (with the passphrase already in env), derives the key for that `agentId`, signs the transaction, and returns. No human prompt or approval step.

So “automated transaction signing without manual input” is satisfied: signing is triggered only by agent logic and env-configured passphrase.

### 3.3 Simulated decision-making and execution

- **Decision-making** — Implemented as agent-specific logic (e.g. Accumulator buys on dips, Flipper trades spread). Optional LLM step adds human-readable rationale; the decision to act is driven by deterministic rules so the system is predictable and safe.
- **Execution** — Decisions are turned into transactions (transfer, swap, memo) and pushed through the same pipeline: circuit breakers → simulation → sign → send. Memos record the decision on-chain for audit.

Together this demonstrates “ability to simulate decision-making or execution by an AI agent” in a controlled way.

### 3.4 Scalability: multiple agents independently

- Each agent has a distinct `agentId` and a distinct HD index, so each has its own wallet and balance.
- All agents share one KeyVault (one seed, one passphrase) but cannot access each other’s keys; they only request signing for their own `agentId`.
- Adding a new agent is a matter of implementing an agent class, registering that `agentId` (which allocates the next derivation index), and wiring it into the orchestrator. So the design scales to many agents without changing the wallet or key model.

---

## 4. Additional design notes

### 4.1 Why HD derivation instead of separate keys

- One backup (recovery phrase) restores all agent wallets.
- Key generation and storage stay simple: one encrypted seed, many public addresses.
- Same industry pattern as multi-account wallets (e.g. Phantom), applied to agent identities.

### 4.2 Why Argon2id

- Memory-hard KDF slows down brute-force and GPU/ASIC attacks on the passphrase.
- Preferable to PBKDF2 or plain bcrypt for deriving encryption keys from a passphrase.

### 4.3 On-chain memo as audit trail

- Agent decisions are written to the Solana Memo program so that “who decided what and when” is verifiable on-chain and not only in logs.
- Complements the web dashboard and RPC for observability and judging.

### 4.4 What production would add

- TEE (e.g. Intel SGX, AWS Nitro) for signing in a hardened environment.
- MPC or threshold schemes for institutional or high-value agents.
- On-chain or policy layers that further restrict which transactions an agent is allowed to submit.

---

## 5. Bounty criteria mapping

| Criterion | How this submission addresses it |
|-----------|----------------------------------|
| **Functional demonstration of an autonomous agent wallet** | Three agents run on devnet; each has a wallet, signs txs, holds SOL, and interacts with Orca and Memo. Dashboard and memos provide a clear demo. |
| **Security and proper key management** | Encrypted vault, Argon2id, no key export, zeroing after use, circuit breakers, simulate-before-send, optional dry run. |
| **Clear documentation and deep dive** | This document (design, security, agent interaction); README (setup, bounty alignment); SKILLS.md (API and safety for agents/judges). |
| **Scalability: multiple agents independently** | Multiple agents today (vault, accumulator, flipper); adding more is a new agent class + one new derivation index; shared vault, independent wallets. |
