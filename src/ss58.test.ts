import test from 'node:test';
import assert from 'node:assert/strict';
import { ss58Encode, ss58Decode, ss58FromDid } from './ss58.js';
import { generateIdentity } from './keystore.js';
import { decodeDidKey } from './didkey.js';

// The well-known Substrate development account "Alice".
const ALICE_ID = Buffer.from(
  'd43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d',
  'hex',
);
const ALICE_SS58 = '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY';

test('encodes the well-known Alice account', () => {
  assert.equal(ss58Encode(ALICE_ID), ALICE_SS58);
});

test('decodes back to the same account id and prefix', () => {
  const { prefix, accountId } = ss58Decode(ALICE_SS58);
  assert.equal(prefix, 42);
  assert.equal(accountId.toString('hex'), ALICE_ID.toString('hex'));
});

test('a did:key and its address carry the same 32 bytes', () => {
  const { did } = generateIdentity();
  const address = ss58FromDid(did);
  assert.match(address, /^5/);
  assert.equal(
    ss58Decode(address).accountId.toString('hex'),
    decodeDidKey(did).toString('hex'),
  );
});

test('a single mistyped character fails the checksum', () => {
  const typo = ALICE_SS58.slice(0, 10) + (ALICE_SS58[10] === 'a' ? 'b' : 'a') + ALICE_SS58.slice(11);
  assert.throws(() => ss58Decode(typo), /checksum|35-byte/);
});

test('rejects wrong lengths and two-byte prefixes', () => {
  assert.throws(() => ss58Encode(Buffer.alloc(31)), /32-byte/);
  assert.throws(() => ss58Encode(ALICE_ID, 64), /prefix/);
  assert.throws(() => ss58Decode('5Grw'), /35-byte/);
});
