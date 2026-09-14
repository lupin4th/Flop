import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { encodeDidKey } from './didkey.js';
import { signingPayload, publicKeyFromDid, signPayload, verifyPayload } from './verify.js';

function freshIdentity() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  return { did: encodeDidKey(spki.subarray(12)), privateKey };
}

test('payload is exactly room|nonce|text as utf-8', () => {
  assert.equal(signingPayload('lobby', 7, 'hi').toString('utf8'), 'lobby|7|hi');
});

test('signature is 86 unpadded base64url characters', () => {
  const { privateKey } = freshIdentity();
  const sig = signPayload(privateKey, 'lobby', 1, 'hi');
  assert.equal(sig.length, 86);
  assert.match(sig, /^[A-Za-z0-9_-]{86}$/);
});

test('a signature verifies against its own did', () => {
  const { did, privateKey } = freshIdentity();
  const sig = signPayload(privateKey, 'lobby', 1, 'hi');
  assert.equal(verifyPayload(did, 'lobby', 1, 'hi', sig), true);
});

test('tampering with room, nonce or text fails verification', () => {
  const { did, privateKey } = freshIdentity();
  const sig = signPayload(privateKey, 'lobby', 1, 'hi');
  assert.equal(verifyPayload(did, 'other', 1, 'hi', sig), false);
  assert.equal(verifyPayload(did, 'lobby', 2, 'hi', sig), false);
  assert.equal(verifyPayload(did, 'lobby', 1, 'ho', sig), false);
});

test('a signature does not verify against a different did', () => {
  const a = freshIdentity();
  const b = freshIdentity();
  const sig = signPayload(a.privateKey, 'lobby', 1, 'hi');
  assert.equal(verifyPayload(b.did, 'lobby', 1, 'hi', sig), false);
});

test('a malformed signature returns false rather than throwing', () => {
  const { did } = freshIdentity();
  assert.equal(verifyPayload(did, 'lobby', 1, 'hi', 'not-a-signature'), false);
});

test('signingPayload rejects NaN as nonce', () => {
  assert.throws(
    () => signingPayload('lobby', NaN, 'hi'),
    /nonce must be a non-negative safe integer/,
  );
});

test('signingPayload rejects non-integer nonce', () => {
  assert.throws(
    () => signingPayload('lobby', 1.5, 'hi'),
    /nonce must be a non-negative safe integer/,
  );
});

test('signingPayload rejects Infinity as nonce', () => {
  assert.throws(
    () => signingPayload('lobby', Infinity, 'hi'),
    /nonce must be a non-negative safe integer/,
  );
});

test('signingPayload rejects negative nonce', () => {
  assert.throws(
    () => signingPayload('lobby', -1, 'hi'),
    /nonce must be a non-negative safe integer/,
  );
});

test('signingPayload accepts zero as nonce', () => {
  assert.equal(signingPayload('lobby', 0, 'hi').toString('utf8'), 'lobby|0|hi');
});

test('verifyPayload returns false when given NaN as nonce', () => {
  const { did } = freshIdentity();
  assert.equal(verifyPayload(did, 'lobby', NaN, 'hi', 'not-a-signature'), false);
});

test('signingPayload accepts a big nonce given as an exact digit string', () => {
  assert.equal(
    signingPayload('lobby', '1789348196321255900', 'text').toString('utf8'),
    'lobby|1789348196321255900|text',
  );
});

test('a big string nonce round-trips through sign/verify, but the rounded number does not', () => {
  const { did, privateKey } = freshIdentity();
  const bigNonce = '1789348196321255900';
  const sig = signPayload(privateKey, 'lobby', bigNonce, 'text');
  assert.equal(verifyPayload(did, 'lobby', bigNonce, 'text', sig), true);
  // This is the regression this fix exists for: JSON.parse silently rounds
  // this nonce to 1789348196321256000, which must NOT verify.
  const rounded = Number(bigNonce);
  assert.equal(verifyPayload(did, 'lobby', rounded, 'text', sig), false);
});

test('signingPayload rejects a non-digit nonce string', () => {
  assert.throws(
    () => signingPayload('lobby', 'abc', 'hi'),
    /nonce must be a non-negative integer string/,
  );
});

test('signingPayload rejects a decimal nonce string', () => {
  assert.throws(
    () => signingPayload('lobby', '1.5', 'hi'),
    /nonce must be a non-negative integer string/,
  );
});

test('signingPayload rejects a negative nonce string', () => {
  assert.throws(
    () => signingPayload('lobby', '-1', 'hi'),
    /nonce must be a non-negative integer string/,
  );
});

test('signingPayload rejects an empty nonce string', () => {
  assert.throws(
    () => signingPayload('lobby', '', 'hi'),
    /nonce must be a non-negative integer string/,
  );
});

test('publicKeyFromDid reconstructs SPKI DER correctly', () => {
  const { publicKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  const did = encodeDidKey(spki.subarray(12));
  const reconstructed = publicKeyFromDid(did);
  const reconstructedSpki = reconstructed.export({ type: 'spki', format: 'der' }) as Buffer;
  assert.deepEqual(reconstructedSpki, spki);
});
