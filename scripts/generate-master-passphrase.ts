#!/usr/bin/env ts-node
/**
 * Generate a secure MASTER_PASSPHRASE and print the exact line for .env.
 * Use this to avoid typos, trailing newlines, or quoting mistakes.
 * KeyVault requires at least 32 characters (this generates 32 bytes, base64-encoded).
 *
 * Run: npx tsx scripts/generate-master-passphrase.ts
 */
import * as crypto from 'crypto';

const LENGTH = 32;  // Minimum required by KeyVault; 32 bytes → 43 base64 chars

function main(): void {
  const raw = crypto.randomBytes(LENGTH);
  const passphrase = raw.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const line = `MASTER_PASSPHRASE=${passphrase}`;

  console.log('');
  console.log('Generated a new MASTER_PASSPHRASE (safe to copy, no spaces or = at end).');
  console.log('');
  console.log('Add this EXACT line to your .env (replace any existing MASTER_PASSPHRASE line):');
  console.log('');
  console.log('  ' + line);
  console.log('');
  console.log('Steps:');
  console.log('  1. Open .env in your editor.');
  console.log('  2. Delete or replace the current MASTER_PASSPHRASE=... line.');
  console.log('  3. Paste the line above. Do not add a space or newline after it.');
  console.log('  4. Save the file.');
  console.log('  5. If you had an existing vault, delete it and re-run setup:');
  console.log('       rm .agent-colony-vault.json');
  console.log('       npm run setup');
  console.log('');
}

main();
