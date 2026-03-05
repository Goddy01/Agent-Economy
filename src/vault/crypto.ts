/**
 * Vault encryption: AES-256-GCM with Argon2id key derivation.
 *
 * The master seed is never stored in plaintext. deriveKey() turns the user
 * passphrase into a 256-bit key; encrypt/decrypt use that for AES-GCM.
 * Decryption errors are turned into safe messages (no passphrase/key leakage).
 */
import * as argon2 from 'argon2';
import * as crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const SALT_LENGTH = 32;
const IV_LENGTH = 16;
const TAG_LENGTH = 16;

export interface EncryptedPayload {
  salt: string;      // hex
  iv: string;        // hex
  tag: string;       // hex
  ciphertext: string; // hex
}

/**
 * Derives a 256-bit key from a passphrase using Argon2id.
 * Argon2id is memory-hard, making brute force expensive.
 */
export async function deriveKey(passphrase: string, salt: Buffer): Promise<Buffer> {
  const hash = await argon2.hash(passphrase, {
    type: argon2.argon2id,
    memoryCost: 65536,    // 64 MB
    timeCost: 3,           // 3 iterations
    parallelism: 4,
    salt,
    hashLength: KEY_LENGTH,
    raw: true,
  });
  return hash as Buffer;
}

/**
 * Encrypts data using AES-256-GCM with a derived key.
 * Returns all material needed to decrypt later.
 */
export async function encrypt(
  plaintext: Buffer,
  passphrase: string
): Promise<EncryptedPayload> {
  const salt = crypto.randomBytes(SALT_LENGTH);
  const iv = crypto.randomBytes(IV_LENGTH);
  const key = await deriveKey(passphrase, salt);

  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  // Zero out key material from memory
  key.fill(0);

  return {
    salt: salt.toString('hex'),
    iv: iv.toString('hex'),
    tag: tag.toString('hex'),
    ciphertext: ciphertext.toString('hex'),
  };
}

/**
 * Decrypts an EncryptedPayload. Zeros key material after use.
 */
export async function decrypt(
  payload: EncryptedPayload,
  passphrase: string
): Promise<Buffer> {
  const salt = Buffer.from(payload.salt, 'hex');
  const iv = Buffer.from(payload.iv, 'hex');
  const tag = Buffer.from(payload.tag, 'hex');
  const ciphertext = Buffer.from(payload.ciphertext, 'hex');

  const key = await deriveKey(passphrase, salt);

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  key.fill(0);

  try {
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return plaintext;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('Unsupported state') || msg.includes('unable to authenticate')) {
      throw new Error(
        'Vault decryption failed: MASTER_PASSPHRASE does not match the passphrase used when this vault was initialized. ' +
          'Use the same passphrase from when you first ran the app, or delete the vault file to re-initialize (you will lose access to existing keys). ' +
          'If you have the recovery phrase from setup, run: delete .agent-colony-vault.json, set RECOVERY_PHRASE in .env, then npm run restore-vault to regain the same addresses.'
      );
    }
    throw err;
  }
}