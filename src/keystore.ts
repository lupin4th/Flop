import {
  generateKeyPairSync,
  scryptSync,
  randomBytes,
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
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

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, KEYLEN, SCRYPT);
}

export function saveIdentity(
  privateKey: KeyObject,
  did: string,
  passphrase: string,
): void {
  ensureHome();
  const pkcs8 = privateKey.export({ type: 'pkcs8', format: 'der' }) as Buffer;
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(passphrase, salt), iv);
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
    deriveKey(passphrase, salt),
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
  return {
    did: stored.did,
    privateKey: createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' }),
  };
}

export function identityExists(): boolean {
  return existsSync(keyPath());
}
