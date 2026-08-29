import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, appendFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateIdentity } from './keystore.js';
import {
  nextNonce, buildPostUrl, createReceipt, appendReceipt, loadReceipts, verifyReceipt, readReceiptLog,
  type Receipt,
} from './receipts.js';
import { receiptsPath, ensureHome } from './paths.js';

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

test('loadReceipts skips a truncated line and returns both prior receipts', () => {
  isolate();
  const { did, privateKey } = generateIdentity();
  const a = createReceipt(privateKey, did, 'lobby', 'one', BASE, []);
  appendReceipt(a);
  const b = createReceipt(privateKey, did, 'lobby', 'two', BASE, [a]);
  appendReceipt(b);
  // Append a truncated JSON line that will fail to parse
  appendFileSync(receiptsPath(), '{"v":1,"did":"did:key:z', { mode: 0o600 });
  const loaded = loadReceipts();
  assert.equal(loaded.length, 2);
  assert.equal(loaded[0].sanitized_text, 'one');
  assert.equal(loaded[1].sanitized_text, 'two');
  const { malformed } = readReceiptLog();
  assert.equal(malformed, 1);
});

test('loadReceipts recovers after a truncated line in the middle', () => {
  isolate();
  const { did, privateKey } = generateIdentity();
  const a = createReceipt(privateKey, did, 'lobby', 'one', BASE, []);
  appendReceipt(a);
  // Append a truncated line
  appendFileSync(receiptsPath(), '{"v":1,"did":"did:key:z\n', { mode: 0o600 });
  const b = createReceipt(privateKey, did, 'lobby', 'two', BASE, [a]);
  appendReceipt(b);
  const loaded = loadReceipts();
  assert.equal(loaded.length, 2);
  assert.equal(loaded[0].sanitized_text, 'one');
  assert.equal(loaded[1].sanitized_text, 'two');
  const { malformed } = readReceiptLog();
  assert.equal(malformed, 1);
});

test('loadReceipts skips valid JSON that is not a receipt object', () => {
  isolate();
  const { did, privateKey } = generateIdentity();
  const a = createReceipt(privateKey, did, 'lobby', 'one', BASE, []);
  appendReceipt(a);
  appendFileSync(receiptsPath(), '{"hello":"world"}\n', { mode: 0o600 });
  appendFileSync(receiptsPath(), '[1,2,3]\n', { mode: 0o600 });
  const b = createReceipt(privateKey, did, 'lobby', 'two', BASE, [a]);
  appendReceipt(b);
  const loaded = loadReceipts();
  assert.equal(loaded.length, 2);
  assert.equal(loaded[0].sanitized_text, 'one');
  assert.equal(loaded[1].sanitized_text, 'two');
  const { malformed } = readReceiptLog();
  assert.equal(malformed, 2);
});

test('nextNonce works with loadReceipts even after a truncated line exists', () => {
  isolate();
  const { did, privateKey } = generateIdentity();
  const a = createReceipt(privateKey, did, 'lobby', 'one', BASE, []);
  appendReceipt(a);
  // Append a truncated line
  appendFileSync(receiptsPath(), '{"v":1,"did":"did:key:z\n', { mode: 0o600 });
  // Create a new receipt using nextNonce with the recovered receipts
  const loaded = loadReceipts();
  const nonce = nextNonce('lobby', loaded);
  assert.ok(nonce > a.nonce);
  // Verify that we can still create a receipt
  const b = createReceipt(privateKey, did, 'lobby', 'two', BASE, loaded);
  assert.ok(b.nonce > a.nonce);
});

test('empty receipt log and blank lines return zero receipts and zero malformed', () => {
  isolate();
  ensureHome();
  // Create a file with only blank lines
  appendFileSync(receiptsPath(), '\n\n  \n', { mode: 0o600 });
  const result = readReceiptLog();
  assert.equal(result.receipts.length, 0);
  assert.equal(result.malformed, 0);
});

test('appendReceipt recovers after a newline-less fragment: both receipts survive', () => {
  isolate();
  const { did, privateKey } = generateIdentity();
  const a = createReceipt(privateKey, did, 'lobby', 'one', BASE, []);
  appendReceipt(a);
  // Simulate an interrupted write: append a fragment with no trailing newline
  appendFileSync(receiptsPath(), '{"v":1,"did":"did:key:z', { mode: 0o600 });
  // Now append a valid receipt; appendReceipt should start on a new line
  const b = createReceipt(privateKey, did, 'lobby', 'two', BASE, [a]);
  appendReceipt(b);
  const { receipts, malformed } = readReceiptLog();
  assert.equal(receipts.length, 2);
  assert.equal(malformed, 1);
  assert.equal(receipts[0].sanitized_text, 'one');
  assert.equal(receipts[1].sanitized_text, 'two');
  assert.equal(receipts.every(verifyReceipt), true);
});

test('after newline-less fragment, the fragment and new receipt are on separate lines', () => {
  isolate();
  const { did, privateKey } = generateIdentity();
  const a = createReceipt(privateKey, did, 'lobby', 'one', BASE, []);
  appendReceipt(a);
  // Simulate an interrupted write: append a fragment with no trailing newline
  appendFileSync(receiptsPath(), '{"v":1,"did":"did:key:z', { mode: 0o600 });
  // Now append a valid receipt
  const b = createReceipt(privateKey, did, 'lobby', 'two', BASE, [a]);
  appendReceipt(b);
  // Read the raw file and verify that no single line contains two {"v":1 occurrences
  const content = readFileSync(receiptsPath(), 'utf8');
  const lines = content.split('\n').filter((line) => line.trim() !== '');
  let foundTwoVersions = false;
  for (const line of lines) {
    const count = (line.match(/\{"v":1/g) || []).length;
    if (count > 1) foundTwoVersions = true;
  }
  assert.equal(foundTwoVersions, false);
});

test('appending to a file already ending with newline does not insert blank lines', () => {
  isolate();
  const { did, privateKey } = generateIdentity();
  const a = createReceipt(privateKey, did, 'lobby', 'one', BASE, []);
  appendReceipt(a);
  const b = createReceipt(privateKey, did, 'lobby', 'two', BASE, [a]);
  appendReceipt(b);
  const content = readFileSync(receiptsPath(), 'utf8');
  const lines = content.split('\n').filter((line) => line.trim() !== '');
  assert.equal(lines.length, 2);
  const { malformed } = readReceiptLog();
  assert.equal(malformed, 0);
});

test('appendReceipt on a non-existent file creates it and produces one line', () => {
  isolate();
  const { did, privateKey } = generateIdentity();
  const r = createReceipt(privateKey, did, 'lobby', 'hello', BASE, []);
  appendReceipt(r);
  const loaded = loadReceipts();
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].sanitized_text, 'hello');
  assert.equal(verifyReceipt(loaded[0]), true);
});
