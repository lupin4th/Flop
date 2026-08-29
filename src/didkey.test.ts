import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeDidKey, encodeDidKey, base58Encode } from './didkey.js';

// W3C did:key specification example (Ed25519)
const DID = 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK';
const PUBKEY_HEX =
  '2e6fcce36701dc791488e0d0b1745cc1e33a4c1c9fcc41c63bd343dbbe0970e6';

test('decodes the known W3C Ed25519 vector', () => {
  const pk = decodeDidKey(DID);
  assert.equal(pk.length, 32);
  assert.equal(pk.toString('hex'), PUBKEY_HEX);
});

test('round-trips encode(decode(did)) back to the same did', () => {
  assert.equal(encodeDidKey(decodeDidKey(DID)), DID);
});

test('rejects a non did:key input', () => {
  assert.throws(() => decodeDidKey('did:web:example.com'), /did:key/);
});

test('rejects a wrong multibase prefix', () => {
  assert.throws(() => decodeDidKey('did:key:Q6Mkhaaa'), /multibase/);
});

test('rejects a non-Ed25519 multicodec', () => {
  // 0xec 0x01 is x25519-pub, not ed25519-pub
  // Build a 34-byte payload with non-Ed25519 multicodec followed by 32 arbitrary bytes
  const nonEd25519Multicodec = Buffer.from([0xec, 0x01]);
  const arbitraryKey = Buffer.alloc(32, 7); // 32 bytes of arbitrary data
  const payload = Buffer.concat([nonEd25519Multicodec, arbitraryKey]);
  const encoded = 'did:key:z' + base58Encode(payload);

  assert.throws(
    () => decodeDidKey(encoded),
    /ed25519-pub multicodec/,
  );
});

test('rejects a 34-byte-prefixed but wrong-length payload', () => {
  // Create a payload that's not 34 bytes
  const ed25519Multicodec = Buffer.from([0xed, 0x01]);
  const shortKey = Buffer.alloc(31); // Too short, should be 32 bytes
  const payload = Buffer.concat([ed25519Multicodec, shortKey]);
  const encoded = 'did:key:z' + base58Encode(payload);

  assert.throws(
    () => decodeDidKey(encoded),
    /34 bytes/,
  );
});

test('rejects an invalid base58 character', () => {
  assert.throws(() => decodeDidKey('did:key:z0OIl'), /base58/);
});
