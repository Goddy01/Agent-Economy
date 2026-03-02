# Agent Colony — Autonomous Multi-Agent Solana Wallet System

> A working prototype of AI-native wallet infrastructure on Solana devnet.
> Three autonomous agents, each controlling an independent HD-derived wallet,
> operating as a coordinated economic unit with circuit-breaker safety enforcement.

## Demo

![Agent Colony Terminal Dashboard]

Three agents running simultaneously on Solana devnet:
- **The Accumulator** — patient buyer, watches a mock price oracle for dips
- **The Flipper** — rapid spread trader on Orca Whirlpool devnet
- **The Vault** — enforced treasury with an unbreakable SOL floor

Every decision is written to the Solana chain as a memo transaction.

## Architecture
Agent Brain (decision logic)
→ SigningRequest
→ KeyVault (only place keys exist)
→ Circuit Breaker (rate limit + value cap + vault floor)
→ simulateTransaction (always)
→ sendRawTransaction (devnet)
→ Solana Memo (on-chain audit trail)

## Quick Start
```bash
git clone https://github.com/[yourname]/agent-colony
cd agent-colony
npm install

cp .env.example .env
# Edit .env: set MASTER_PASSPHRASE (32+ chars)

npm run setup    # Creates vault, airdrops devnet SOL
npm run start    # Launches colony with live dashboard

# Dry run (simulate only, no real transactions)
npm run colony:dry
```

## Security Design

| Feature | Implementation |
|---------|---------------|
| Key storage | AES-256-GCM encrypted, Argon2id KDF |
| Key derivation | BIP-44 HD paths (`m/44'/501'/{i}'/0'`) |
| Agent isolation | Agents call `sign()` — never see raw keys |
| Transaction safety | Always simulated before broadcast |
| Rate limiting | Sliding window, 10 tx/min per agent |
| Vault protection | Enforced floor balance, circuit breaker |

## Project Structure

See [DEEP_DIVE.md](./DEEP_DIVE.md) for full architectural explanation.
See [SKILLS.md](./SKILLS.md) for agent API reference.

## Devnet Explorer Links

After running, visit:
`https://explorer.solana.com/address/[AGENT_ADDRESS]?cluster=devnet`