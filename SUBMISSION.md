# Bounty submission — AI agent wallet

**Project:** Agent Colony — multi-agent agentic wallet system on Solana devnet.

**Start here if you're judging:** [JUDGE_DEMO.md](./JUDGE_DEMO.md) — 5-minute script (commands + what you'll see + how to verify on-chain). [DESIGN_CHOICES.md](./DESIGN_CHOICES.md) — constraints, tradeoffs, and "what was hard" (so you see it's not a generic AI slop doc).

---

## Requirements checklist

- **Agentic wallet that can:** create wallet programmatically [x] | sign transactions automatically [x] | hold SOL/SPL [x] | interact with test dApp or protocol [x] (Orca Whirlpools + Memo + System transfers)
- **Deep dive:** [DEEP_DIVE.md](./DEEP_DIVE.md) (written) — wallet design, security, AI agent interaction
- **Open-source + README + setup:** [README.md](./README.md) and instructions in repo
- **SKILLS.md for agents:** [SKILLS.md](./SKILLS.md)
- **Working prototype on devnet:** Yes

---

## Run the prototype (devnet)

```bash
npm install
cp .env.example .env   # set MASTER_PASSPHRASE (32+ chars, in quotes if it contains =)
npm run setup          # init vault, create 3 agent wallets, airdrop SOL
npm run start          # run colony; open http://localhost:3555 for dashboard
```

---

## Judging criteria

- **Functional demonstration:** Three agents (vault, accumulator, flipper) each with own wallet; sign and send txs; interact with Orca and Memo on devnet.
- **Security / key management:** Encrypted vault (AES-256-GCM + Argon2id), HD derivation, no key export, circuit breakers, simulate-before-send.
- **Documentation / deep dive:** README, DEEP_DIVE.md, SKILLS.md.
- **Scalability:** Multiple agents today; add more by new agent class + one new HD index.

---

## Repo layout

- `src/vault/` — KeyVault, crypto (key storage, derivation, signing)
- `src/wallet/` — WalletManager (create wallet, balance, transfer, airdrop)
- `src/agents/` — Agent logic (Accumulator, Flipper, Vault)
- `src/transactions/` — TransactionEngine (circuit breakers, simulate, sign, send)
- `src/dex/` — Orca Whirlpools integration
- `src/dashboard/` — Web dashboard
- `scripts/` — setup-devnet, restore-vault
