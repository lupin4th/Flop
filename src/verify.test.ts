import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { encodeDidKey } from './didkey.js';
import { signingPayload, signPayload, verifyPayload } from './verify.js';

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
