import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateIdentity } from './keystore.js';
import {
  nextNonce, buildPostUrl, createReceipt, appendReceipt, loadReceipts, verifyReceipt,
  type Receipt,
} from './receipts.js';

const BASE = 'https://technocore.chat';

function isolate() {
  process.env.TECHNOCORE_ATTEST_HOME = mkdtempSync(join(tmpdir(), 'attest-'));
}

test('nextNonce uses the clock when the room has no prior receipt', () => {
  const before = Date.now();
  const n = nextNonce('lobby', []);
  assert.ok(n >= before);
});

test('nextNonce strictly exceeds the last nonce used in that room', () => {
  const future = Date.now() + 1_000_000;
  const prior = [{ room: 'lobby', nonce: future } as Receipt];
  assert.equal(nextNonce('lobby', prior), future + 1);
});

test('nextNonce ignores nonces from other rooms', () => {
  const future = Date.now() + 1_000_000;
  const prior = [{ room: 'other', nonce: future } as Receipt];
  assert.ok(nextNonce('lobby', prior) < future);
});

test('post url encodes every path segment', () => {
  const url = buildPostUrl(BASE, 'did:key:zAAA', 'SIG', 5, 'lobby', 'a b/c');
  assert.equal(url, `${BASE}/r/lobby/say-signed/did%3Akey%3AzAAA/SIG/5/a%20b%2Fc`);
});

test('a created receipt verifies against its own did', () => {
  isolate();
  const { did, privateKey } = generateIdentity();
  const r = createReceipt(privateKey, did, 'lobby', 'hello', BASE, []);
  assert.equal(verifyReceipt(r), true);
});

test('a receipt stores the sanitized text, not the raw input', () => {
  isolate();
  const { did, privateKey } = generateIdentity();
  const r = createReceipt(privateKey, did, 'lobby', 'a\nb', BASE, []);
  assert.equal(r.sanitized_text, 'a b');
  assert.equal(verifyReceipt(r), true);
});

test('a tampered receipt fails verification', () => {
  isolate();
  const { did, privateKey } = generateIdentity();
  const r = createReceipt(privateKey, did, 'lobby', 'hello', BASE, []);
  assert.equal(verifyReceipt({ ...r, sanitized_text: 'goodbye' }), false);
  assert.equal(verifyReceipt({ ...r, nonce: r.nonce + 1 }), false);
  assert.equal(verifyReceipt({ ...r, room: 'other' }), false);
});

test('rejects text over the server 4096 character cap', () => {
  isolate();
  const { did, privateKey } = generateIdentity();
  assert.throws(
    () => createReceipt(privateKey, did, 'lobby', 'a'.repeat(4097), BASE, []),
    /4096/,
  );
});

test('rejects a message whose post url exceeds the edge url budget', () => {
  isolate();
  const { did, privateKey } = generateIdentity();
  // A CJK character costs 9 bytes URL-encoded, so ~1800 of them blow the
  // ~16 KB budget while staying under the 4096 character cap.
  assert.throws(
    () => createReceipt(privateKey, did, 'lobby', '한'.repeat(2000), BASE, []),
    /URL budget/,
  );
});

test('append then load round-trips receipts in order', () => {
  isolate();
  const { did, privateKey } = generateIdentity();
  const a = createReceipt(privateKey, did, 'lobby', 'one', BASE, []);
  appendReceipt(a);
  const b = createReceipt(privateKey, did, 'lobby', 'two', BASE, [a]);
  appendReceipt(b);
  const loaded = loadReceipts();
  assert.equal(loaded.length, 2);
  assert.equal(loaded[0].sanitized_text, 'one');
  assert.equal(loaded[1].sanitized_text, 'two');
  assert.ok(loaded[1].nonce > loaded[0].nonce);
  assert.equal(loaded.every(verifyReceipt), true);
});
