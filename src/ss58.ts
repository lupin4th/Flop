import { createHash } from 'node:crypto';
import { base58Decode, base58Encode, decodeDidKey } from './didkey.js';

// SS58 is how Substrate chains write an account as text: one prefix byte,
// the 32-byte account id, then two checksum bytes. For an Ed25519 key the
// account id is the public key itself, so a did:key and its FLOP address are
// two spellings of the same 32 bytes — nothing new is generated here.

/** The generic Substrate prefix, which the FLOP testnet uses. */
export const SS58_PREFIX = 42;

const CHECKSUM_CONTEXT = Buffer.from('SS58PRE');

function checksum(payload: Buffer): Buffer {
  return createHash('blake2b512')
    .update(Buffer.concat([CHECKSUM_CONTEXT, payload]))
    .digest()
    .subarray(0, 2);
}

function assertSimplePrefix(prefix: number): void {
  // Prefixes of 64 and above use a two-byte encoding this tool has no use for.
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 63) {
    throw new Error(`unsupported SS58 prefix: ${prefix}`);
  }
}

export function ss58Encode(accountId: Buffer, prefix: number = SS58_PREFIX): string {
  if (accountId.length !== 32) {
    throw new Error(`expected a 32-byte account id, got ${accountId.length}`);
  }
  assertSimplePrefix(prefix);
  const payload = Buffer.concat([Buffer.from([prefix]), accountId]);
  return base58Encode(Buffer.concat([payload, checksum(payload)]));
}

export function ss58Decode(address: string): { prefix: number; accountId: Buffer } {
  const raw = base58Decode(address);
  if (raw.length !== 35) {
    throw new Error(`expected a 35-byte SS58 address, got ${raw.length}`);
  }
  assertSimplePrefix(raw[0]);
  const payload = raw.subarray(0, 33);
  if (!checksum(payload).equals(raw.subarray(33))) {
    throw new Error('SS58 checksum mismatch: the address is mistyped or corrupt');
  }
  return { prefix: raw[0], accountId: Buffer.from(raw.subarray(1, 33)) };
}

/** The address controlled by the same Ed25519 key a did:key names. */
export function ss58FromDid(did: string, prefix: number = SS58_PREFIX): string {
  return ss58Encode(decodeDidKey(did), prefix);
}
