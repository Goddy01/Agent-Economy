# Agent Colony — Deep Dive

## 1. Why Agentic Wallets Are Different
   - Human wallets optimize for UX (hardware wallets, MFA)
   - Agent wallets optimize for: programmatic access, isolation, auditability, safety rails
   - The adversarial model is different: key exfiltration via prompt injection, not phishing

## 2. Threat Model
   a. Prompt Injection Attack
      — An adversary embeds instructions in oracle data to cause the agent to drain its wallet
      — Mitigation: deterministic rule engine (not LLM) for decisions; LLM only explains
   
   b. Key Exfiltration
      — Malicious code reads env vars or memory dumps
      — Mitigation: AES-256-GCM + Argon2id at rest; keys zeroed after signing
   
   c. Replay Attack
      — Signed transaction replayed after blockhash expiry
      — Mitigation: Solana's recent blockhash requirement makes this impossible natively
   
   d. Runaway Agent (Unintended Spending)
      — Bug in agent logic causes infinite loop of transactions
      — Mitigation: Rate limiter (10 tx/min), max tx value, circuit breaker at engine level

## 3. Key Management Architecture
   - Why HD derivation (BIP-44) instead of separate random keys
   - Why Argon2id over bcrypt/PBKDF2 (memory-hard = GPU-resistant)
   - The signing interface pattern — why agents never see bytes

## 4. Agent Coordination Without a Central Coordinator
   - On-chain memo bus for audit trail
   - Why we avoid off-chain shared state (introduces coordination failure points)
   - The vault as emergent coordination: agents self-police because they contribute to shared treasury

## 5. Circuit Breaker Design
   - Why simulate-before-send matters (catches logic errors before SOL loss)
   - Vault floor enforcement: implemented at KeyVault level, not agent level — agents cannot override
   - Rate limiting: sliding window vs fixed window tradeoffs

## 6. What Production Would Look Like
   - TEE (Trusted Execution Environment): Intel SGX or AWS Nitro for key operations
   - MPC (Multi-Party Computation): threshold signatures for institutional agents
   - On-chain policy enforcement: programs that verify agent permissions before execution
   - Monitoring: anomaly detection on transaction patterns

## 7. Scalability: From 3 Agents to 300
   - Each agent = one HD derivation index = trivial to add
   - Shared KeyVault = single point of management, not single point of failure
   - Connection pooling for RPC calls
   - Queue-based transaction submission for high-frequency agents