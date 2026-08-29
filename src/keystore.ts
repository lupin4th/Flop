import {
  generateKeyPairSync,
  scryptSync,
  randomBytes,
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  type KeyObject,
} from 'node:crypto';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { encodeDidKey } from './didkey.js';
import { keyPath, ensureHome } from './paths.js';

// This module must never import ./client.js — see the import guard test.

const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEYLEN = 32;

export type StoredKey = {
  v: 1;
  did: string;
  kdf: { name: 'scrypt'; salt: string; N: number; r: number; p: number };
  cipher: { name: 'aes-256-gcm'; iv: string; tag: string; ct: string };
};

export function generateIdentity(): { did: string; privateKey: KeyObject } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  return { did: encodeDidKey(spki.subarray(12)), privateKey };
}

function didFromPrivateKey(privateKey: KeyObject): string {
  const spki = createPublicKey(privateKey).export({ type: 'spki', format: 'der' }) as Buffer;
  return encodeDidKey(spki.subarray(12));
}

function deriveKey(passphrase: string, salt: Buffer, params: typeof SCRYPT): Buffer {
  return scryptSync(passphrase, salt, KEYLEN, params);
}

function kdfParams(kdf: StoredKey['kdf']) {
  const { N, r, p } = kdf;
  const ok = (n: number, max: number) => Number.isSafeInteger(n) && n > 0 && n <= max;
  if (kdf.name !== 'scrypt' || !ok(N, 1 << 20) || !ok(r, 32) || !ok(p, 16)) {
    throw new Error('key file has unsupported or out-of-range KDF parameters');
  }
  return { N, r, p, maxmem: 256 * 1024 * 1024 };
}

export function saveIdentity(
  privateKey: KeyObject,
  did: string,
  passphrase: string,
): void {
  if (didFromPrivateKey(privateKey) !== did) {
    throw new Error('refusing to save: did does not match the private key');
  }
  ensureHome();
  const pkcs8 = privateKey.export({ type: 'pkcs8', format: 'der' }) as Buffer;
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(passphrase, salt, SCRYPT), iv);
  const ct = Buffer.concat([cipher.update(pkcs8), cipher.final()]);
  const stored: StoredKey = {
    v: 1,
    did,
    kdf: { name: 'scrypt', salt: salt.toString('base64'), N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p },
    cipher: {
      name: 'aes-256-gcm',
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      ct: ct.toString('base64'),
    },
  };
  writeFileSync(keyPath(), JSON.stringify(stored, null, 2), { mode: 0o600 });
}

export function loadIdentity(passphrase: string): { did: string; privateKey: KeyObject } {
  const stored = JSON.parse(readFileSync(keyPath(), 'utf8')) as StoredKey;
  if (stored.v !== 1) throw new Error(`unsupported key file version: ${stored.v}`);
  const salt = Buffer.from(stored.kdf.salt, 'base64');
  const decipher = createDecipheriv(
    'aes-256-gcm',
    deriveKey(passphrase, salt, kdfParams(stored.kdf)),
    Buffer.from(stored.cipher.iv, 'base64'),
  );
  decipher.setAuthTag(Buffer.from(stored.cipher.tag, 'base64'));
  let pkcs8: Buffer;
  try {
    pkcs8 = Buffer.concat([
      decipher.update(Buffer.from(stored.cipher.ct, 'base64')),
      decipher.final(),
    ]);
  } catch {
    throw new Error('could not decrypt the key file: wrong passphrase or corrupt file');
  }
  const privateKey = createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' });
  const derived = didFromPrivateKey(privateKey);
  if (derived !== stored.did) {
    throw new Error(
      `key file is inconsistent: stored did ${stored.did} does not match the key it contains`,
    );
  }
  return { did: derived, privateKey };
}

export function identityExists(): boolean {
  return existsSync(keyPath());
}
