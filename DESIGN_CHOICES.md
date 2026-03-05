# Design choices (and what we skipped)

Short, honest notes on constraints and tradeoffs. This is the kind of doc that only exists when someone actually built the thing and had to choose.

---

## Constraints we imposed

**1. LLM never touches signing.**  
The optional “rationale” is LLM-generated for readability. The decision to act (buy, sell, transfer, swap) comes from deterministic rules. We didn’t want “explain why you’re sending 0.5 SOL” to be the same code path that authorizes the send. So: rules decide, LLM explains. Prompt injection can’t flip a rule into “drain wallet.”

**2. Vault floor is enforced in one place.**  
The vault agent’s “don’t spend below X SOL” is not a suggestion in agent code — it’s a circuit breaker in `TransactionEngine`. The vault agent literally cannot submit a transaction that would break the floor; the engine rejects it before signing. So no bug in agent logic can bypass it.

**3. Simulate before every send.**  
We don’t have a “trust the builder” mode. Every transaction is simulated first. If simulation fails, we never sign or send. Catches bad txs (wrong program, insufficient balance, etc.) before any SOL moves.

**4. One vault file, one passphrase.**  
All agent keys are derived from a single encrypted seed. That’s a single secret to back up (recovery phrase) and a single point of encryption. We didn’t want N key files or N env vars for N agents; it doesn’t scale and is easy to misconfigure.

---

## What we deliberately didn’t do

**TEE / hardware.**  
We’re not running the vault in a TEE (e.g. SGX or Nitro). For a devnet prototype and a single-machine demo, we prioritized “correct and auditable” over “hardware-isolated.” Production would add TEE or MPC; we call that out in the deep dive.

**Separate key per agent (no HD).**  
We could have given each agent its own randomly generated keypair and stored each in its own file. We chose HD so that one recovery phrase restores all agents and so adding agent #4 doesn’t mean a new key file and backup. Tradeoff: if the master seed is compromised, all agents are; we accept that for this scope and rely on encryption and no-export.

**Real oracle.**  
The “oracle” is a mock (local tick). Real price would come from Pyth, Switchboard, or an API. We didn’t want the demo to depend on external APIs or mainnet; the wallet and signing design don’t change either way.

**Full Orca integration (all pools / tokens).**  
We integrate with Orca Whirlpools for swaps on devnet, but the exact pool and token choice are simplified. The point was “agent wallet signs a real protocol tx,” not “production-ready DEX router.”

---

## What was surprisingly hard

**Devnet airdrops.**  
Rate limits and 429s are common. We added balance checks before airdrop (skip if wallet already has enough), retries with backoff in the setup script, and a way to restore the vault from mnemonic so you don’t lose access if the vault file is gone. Small ops details that you only hit when you run it yourself.

**Ink → web dashboard.**  
We started with a terminal UI (Ink). ESM/Node/ts-node and dependency hell made it brittle. We switched to a simple web dashboard (HTTP server + HTML/JS) so the demo runs reliably and judges can open it in a browser. The wallet and agents didn’t change; only the view layer did.

---

## What we’d do with more time

- **TEE or HSM** for the signing path in a production deployment.
- **On-chain policy** (e.g. a program that checks “is this agent allowed to call this program?”) before submitting.
- **Structured decision log** (e.g. JSON in memo or a small program) so analytics and audits are easier than parsing free-text memos.
- **More agents and a simple “add agent” flow** (e.g. CLI or dashboard button) to show scalability without editing code.

---

This doc is here so judges see that the project has real constraints, real tradeoffs, and a real author who made choices and hit real issues — not a generic feature list.
