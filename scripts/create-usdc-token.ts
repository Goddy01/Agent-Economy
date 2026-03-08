#!/usr/bin/env ts-node
/**
 * Create the colony USDC SPL token on devnet.
 * Each run creates a new USDC mint and updates USDC_MINT in .env.
 * Mints all initial supply to the funder (reserve holder); funder then sends POOL_INITIAL_USDC to the pool.
 * Run after vault is initialized and pool/funder wallets exist.
 *
 * Usage: npx tsx scripts/create-usdc-token.ts
 *
 * Prerequisites: MASTER_PASSPHRASE in .env, vault initialized, pool and funder registered. The funder wallet must be topped up with SOL (it pays for mint creation and ATAs); send SOL to the funder address after setup, then run this script.
 * Output: USDC_MINT=<mint_pubkey> in .env; funder holds USDC reserve and pool receives initial USDC from funder.
 */
import * as dotenv from 'dotenv';
import { Connection, Keypair, PublicKey, Transaction, SystemProgram } from '@solana/web3.js';
import { Token, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from '@solana/spl-token';
import * as fs from 'fs';
import * as path from 'path';
import { KeyVault } from '../src/vault/KeyVault';

dotenv.config();

const MINT_ACCOUNT_SIZE = 82;
const LAMPORTS_PER_SOL = 1e9;
const USDC_DECIMALS = 6;
const POOL_INITIAL_USDC = 100_000; // 100k USDC (6 decimals = 100_000 * 1e6 raw)
const FUNDER_INITIAL_USDC = 50_000; // 50k USDC for topping up traders
/** Minimum SOL the funder must have to pay for mint + 2 ATAs + fees (roughly 0.05 SOL) */
const MIN_FUNDER_SOL = 0.05;

async function main(): Promise<void> {
  const passphrase = (process.env.MASTER_PASSPHRASE ?? '').trim();
  if (!passphrase || passphrase.length < 32) {
    throw new Error('MASTER_PASSPHRASE must be set in .env and at least 32 characters');
  }

  const rpcUrl = process.env.SOLANA_RPC_URL ?? 'https://api.devnet.solana.com';
  const connection = new Connection(rpcUrl, 'confirmed');
  const vault = new KeyVault(passphrase);

  const poolAddress = vault.getAgentPublicKey('pool');
  const funderAddress = vault.getAgentPublicKey('funder');
  if (!poolAddress || !funderAddress) {
    throw new Error('Pool and funder must be registered (run setup first)');
  }
  const poolPubkey = new PublicKey(poolAddress);
  const funderPubkey = new PublicKey(funderAddress);

  const funderBalance = await connection.getBalance(funderPubkey);
  const funderSol = funderBalance / LAMPORTS_PER_SOL;
  if (funderSol < MIN_FUNDER_SOL) {
    console.error('The funder wallet has insufficient SOL to create the USDC mint.');
    console.error('  Funder balance:', funderSol.toFixed(4), 'SOL');
    console.error('  Required: at least', MIN_FUNDER_SOL, 'SOL (for mint + ATAs + fees).');
    console.error('  Send SOL to the funder address, then run this script again:');
    console.error('  ', funderAddress);
    process.exit(1);
  }

  const mintKeypairPath = path.join(process.cwd(), '.usdc-mint-keypair.json');
  const mintKeypair = Keypair.generate();
  const mintPubkey = mintKeypair.publicKey;

  console.log('Creating USDC SPL token (devnet)...\n');
  console.log('  Mint:', mintPubkey.toBase58());
  console.log('  Pool (mint authority). Funder holds reserve; will send initial USDC to pool.', poolAddress);
  console.log('  Funder (reserve holder, receives all minted USDC):', funderAddress, `(${funderSol.toFixed(4)} SOL)`);
  console.log('  Payer for creation: funder\n');

  const rent = await Token.getMinBalanceRentForExemptMint(connection);
  const createAccountIx = SystemProgram.createAccount({
    fromPubkey: funderPubkey,
    newAccountPubkey: mintPubkey,
    lamports: rent,
    space: MINT_ACCOUNT_SIZE,
    programId: TOKEN_PROGRAM_ID,
  });
  const createMintIx = Token.createInitMintInstruction(
    TOKEN_PROGRAM_ID,
    mintPubkey,
    USDC_DECIMALS,
    poolPubkey,
    null
  );

  const { blockhash } = await connection.getLatestBlockhash();
  const tx = new Transaction().add(createAccountIx, createMintIx);
  tx.recentBlockhash = blockhash;
  tx.feePayer = funderPubkey;

  await vault.sign({ agentId: 'funder', transaction: tx, description: 'create-usdc-mint' });
  tx.partialSign(mintKeypair);

  let sig: string;
  try {
    sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
    await connection.confirmTransaction(sig, 'confirmed');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (
      msg.includes('Attempt to debit an account but found no record of a prior credit') ||
      msg.includes('Simulation failed') ||
      msg.includes('insufficient')
    ) {
      console.error('Transaction failed: the funder wallet may have insufficient SOL or the simulation failed.');
      console.error('  Send SOL (devnet) to the funder address and run this script again:');
      console.error('  ', funderAddress);
      process.exit(1);
    }
    throw err;
  }
  console.log('  USDC mint created. Tx:', `https://solscan.io/tx/${sig}?cluster=devnet\n`);

  const poolAta = await Token.getAssociatedTokenAddress(
    ASSOCIATED_TOKEN_PROGRAM_ID,
    TOKEN_PROGRAM_ID,
    mintPubkey,
    poolPubkey
  );
  const funderAta = await Token.getAssociatedTokenAddress(
    ASSOCIATED_TOKEN_PROGRAM_ID,
    TOKEN_PROGRAM_ID,
    mintPubkey,
    funderPubkey
  );

  const createPoolAtaIx = Token.createAssociatedTokenAccountInstruction(
    ASSOCIATED_TOKEN_PROGRAM_ID,
    TOKEN_PROGRAM_ID,
    mintPubkey,
    poolAta,
    poolPubkey,
    funderPubkey
  );
  const createFunderAtaIx = Token.createAssociatedTokenAccountInstruction(
    ASSOCIATED_TOKEN_PROGRAM_ID,
    TOKEN_PROGRAM_ID,
    mintPubkey,
    funderAta,
    funderPubkey,
    funderPubkey
  );

  const poolSupplyRaw = Math.floor(POOL_INITIAL_USDC * Math.pow(10, USDC_DECIMALS));
  const funderSupplyRaw = Math.floor(FUNDER_INITIAL_USDC * Math.pow(10, USDC_DECIMALS));
  const totalMintToFunderRaw = poolSupplyRaw + funderSupplyRaw;
  const mintToFunderIx = Token.createMintToInstruction(
    TOKEN_PROGRAM_ID,
    mintPubkey,
    funderAta,
    poolPubkey,
    [],
    totalMintToFunderRaw
  );
  const transferFunderToPoolIx = Token.createTransferInstruction(
    TOKEN_PROGRAM_ID,
    funderAta,
    poolAta,
    funderPubkey,
    [],
    poolSupplyRaw
  );

  const tx2 = new Transaction().add(createPoolAtaIx, createFunderAtaIx, mintToFunderIx, transferFunderToPoolIx);
  tx2.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  tx2.feePayer = funderPubkey;

  await vault.signMultiAgent(['funder', 'pool'], tx2);

  let sig2: string;
  try {
    sig2 = await connection.sendRawTransaction(tx2.serialize(), { skipPreflight: false });
    await connection.confirmTransaction(sig2, 'confirmed');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (
      msg.includes('Attempt to debit an account but found no record of a prior credit') ||
      msg.includes('Simulation failed') ||
      msg.includes('insufficient')
    ) {
      console.error('Second transaction failed (ATAs + mint): the funder may need more SOL.');
      console.error('  Send SOL (devnet) to the funder address and run this script again:');
      console.error('  ', funderAddress);
      process.exit(1);
    }
    throw err;
  }
  console.log('  Funder ATAs created, minted to funder, and funder sent', POOL_INITIAL_USDC, 'USDC to pool. Tx:', `https://solscan.io/tx/${sig2}?cluster=devnet\n`);

  fs.writeFileSync(mintKeypairPath, JSON.stringify(Array.from(mintKeypair.secretKey)));
  console.log('  USDC mint keypair saved to .usdc-mint-keypair.json (do not commit).\n');

  const envPath = path.join(process.cwd(), '.env');
  let envContent = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
  const newMintLine = `USDC_MINT=${mintPubkey.toBase58()}`;
  if (envContent.includes('USDC_MINT')) {
    envContent = envContent.replace(/USDC_MINT=[^\s#\n]+/m, newMintLine);
    fs.writeFileSync(envPath, envContent.trimEnd() + '\n');
    console.log('  Updated USDC_MINT in .env\n');
  } else {
    envContent += `\n# USDC SPL token for trading alongside SOL (run npm run create-usdc-token to create)\n${newMintLine}\n`;
    fs.writeFileSync(envPath, envContent.trimEnd() + '\n');
    console.log('  Added USDC_MINT to .env\n');
  }

  console.log('Done. USDC_MINT=' + mintPubkey.toBase58());
  console.log('Restart the colony so swaps use USDC alongside SOL.');
}

main().catch((err: unknown) => {
  const msg =
    (err instanceof Error ? err.message : '') +
    (typeof (err as { transactionMessage?: string }).transactionMessage === 'string'
      ? (err as { transactionMessage: string }).transactionMessage
      : '');
  if (
    msg.includes('Attempt to debit an account but found no record of a prior credit') ||
    msg.includes('Simulation failed') ||
    msg.includes('insufficient')
  ) {
    console.error('\nTransaction failed. Top up the funder wallet with SOL (devnet), then run: npm run create-usdc-token');
  } else {
    console.error(err);
  }
  process.exit(1);
});
