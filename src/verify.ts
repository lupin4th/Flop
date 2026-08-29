import {
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from 'node:crypto';
import { decodeDidKey } from './didkey.js';

/** DER header for an Ed25519 SubjectPublicKeyInfo; the 32-byte key follows. */
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export function signingPayload(
  room: string,
  nonce: number,
  sanitizedText: string,
): Buffer {
  return Buffer.from(`${room}|${nonce}|${sanitizedText}`, 'utf8');
}

export function publicKeyFromDid(did: string): KeyObject {
  const raw = decodeDidKey(did);
  return createPublicKey({
    key: Buffer.concat([SPKI_PREFIX, raw]),
    format: 'der',
    type: 'spki',
  });
}

export function signPayload(
  privateKey: KeyObject,
  room: string,
  nonce: number,
  sanitizedText: string,
): string {
  const sig = cryptoSign(null, signingPayload(room, nonce, sanitizedText), privateKey);
  return sig.toString('base64url');
}

export function verifyPayload(
  did: string,
  room: string,
  nonce: number,
  sanitizedText: string,
  sigB64url: string,
): boolean {
  try {
    const sig = Buffer.from(sigB64url, 'base64url');
    if (sig.length !== 64) return false;
    return cryptoVerify(
      null,
      signingPayload(room, nonce, sanitizedText),
      publicKeyFromDid(did),
      sig,
    );
  } catch {
    return false;
  }
}
