import {
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from 'node:crypto';
import { decodeDidKey } from './didkey.js';

/** DER header for an Ed25519 SubjectPublicKeyInfo; the 32-byte key follows. */
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/**
 * Renders a nonce to the exact decimal text that goes into the signing
 * payload. A `number` must be a safe integer, since anything past
 * `Number.MAX_SAFE_INTEGER` may already have been rounded by the time it
 * reached us as a JS number. A `string` is accepted as-is (after validating
 * it is plain non-negative decimal digits) specifically so that a nonce
 * recovered as raw text — before `JSON.parse` had a chance to round it — can
 * be carried through untouched.
 */
function nonceText(nonce: number | string): string {
  if (typeof nonce === 'number') {
    if (!Number.isSafeInteger(nonce) || nonce < 0) {
      throw new Error(`nonce must be a non-negative safe integer, got ${nonce}`);
    }
    return String(nonce);
  }
  if (!/^\d+$/.test(nonce)) {
    throw new Error(`nonce must be a non-negative integer string, got ${JSON.stringify(nonce)}`);
  }
  return nonce;
}

export function signingPayload(
  room: string,
  nonce: number | string,
  sanitizedText: string,
): Buffer {
  return Buffer.from(`${room}|${nonceText(nonce)}|${sanitizedText}`, 'utf8');
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
  nonce: number | string,
  sanitizedText: string,
): string {
  const sig = cryptoSign(null, signingPayload(room, nonce, sanitizedText), privateKey);
  return sig.toString('base64url');
}

export function verifyPayload(
  did: string,
  room: string,
  nonce: number | string,
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
