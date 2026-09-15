import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateIdentity } from './keystore.js';
import { createReceipt } from './receipts.js';
import { labelMessage, archiveRoom, loadArchive } from './archive.js';
import type { RoomMessage } from './client.js';

function isolate() {
  process.env.TECHNOCORE_ATTEST_HOME = mkdtempSync(join(tmpdir(), 'attest-'));
}

test('an anonymous nickname is unsigned', () => {
  const m: RoomMessage = { seq: 1, ts: '1', from: '~spam', text: 'hi' };
  assert.equal(labelMessage(m, []), 'unsigned');
});

test('a did we hold no receipt for is server_attested, never verified', () => {
  const m: RoomMessage = { seq: 1, ts: '1', from: 'did:key:zAAA', text: 'hi', nonce: '5' };
  assert.equal(labelMessage(m, []), 'server_attested');
});

test('a message matching one of our own receipts is self_verified', () => {
  isolate();
  const { did, privateKey } = generateIdentity();
  const r = createReceipt(privateKey, did, 'lobby', 'hello', 'https://x', []);
  const m: RoomMessage = {
    seq: 1, ts: '1', from: did, text: r.sanitized_text, nonce: String(r.nonce),
  };
  assert.equal(labelMessage(m, [r]), 'self_verified');
});

test('a receipt that does not match the message text is not self_verified', () => {
  isolate();
  const { did, privateKey } = generateIdentity();
  const r = createReceipt(privateKey, did, 'lobby', 'hello', 'https://x', []);
  const m: RoomMessage = { seq: 1, ts: '1', from: did, text: 'tampered', nonce: String(r.nonce) };
  assert.equal(labelMessage(m, [r]), 'server_attested');
});

// archiveRoom now reads the full ring via GET /r/<room>/export (JSONL, one
// message per line) rather than the ~200-message ?format=json window, so
// these fakeFetch bodies serve JSONL — the shape /export actually returns —
// instead of the old `{"messages": [...]}` envelope.

test('archiveRoom writes labelled messages and reloads them', async () => {
  isolate();
  const fakeFetch = async () =>
    new Response(
      [
        JSON.stringify({ seq: 1, ts: '1', from: '~a', text: 'hi' }),
        JSON.stringify({ seq: 2, ts: '2', from: 'did:key:zAAA', text: 'yo', nonce: 3 }),
      ].join('\n') + '\n',
      { status: 200 },
    );
  const { written } = await archiveRoom('lobby', {
    fetchImpl: fakeFetch as unknown as typeof fetch,
  });
  assert.equal(written, 2);
  const rows = loadArchive('lobby');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].trust, 'unsigned');
  assert.equal(rows[1].trust, 'server_attested');
});

test('archiving twice does not duplicate messages already recorded', async () => {
  isolate();
  const fakeFetch = async () =>
    new Response(JSON.stringify({ seq: 1, ts: '1', from: '~a', text: 'hi' }) + '\n', {
      status: 200,
    });
  const opts = { fetchImpl: fakeFetch as unknown as typeof fetch };
  await archiveRoom('lobby', opts);
  const second = await archiveRoom('lobby', opts);
  assert.equal(second.written, 0);
  assert.equal(loadArchive('lobby').length, 1);
});

test('archiveRoom carries the sig field from /export through to the archived row', async () => {
  isolate();
  const fakeFetch = async (url: string | URL) => {
    assert.match(String(url), /\/export\b/);
    return new Response(
      JSON.stringify({
        seq: 1, ts: '1', from: 'did:key:zAAA', text: 'yo', nonce: 3, sig: 'the-server-checked-sig',
      }) + '\n',
      { status: 200 },
    );
  };
  await archiveRoom('lobby', { fetchImpl: fakeFetch as unknown as typeof fetch });
  const rows = loadArchive('lobby');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].sig, 'the-server-checked-sig');
});

test('a message matches one of our own receipts even with a nonce beyond Number.MAX_SAFE_INTEGER', () => {
  isolate();
  const { did, privateKey } = generateIdentity();
  // Our own receipts always carry a safe-integer nonce (nextNonce is clock
  // based), but the room message we compare against now carries the nonce
  // as an exact decimal string, possibly one that would round if it were a
  // number. labelMessage must compare via String(receipt.nonce) === message.nonce.
  const r = createReceipt(privateKey, did, 'lobby', 'hello', 'https://x', []);
  const m: RoomMessage = {
    seq: 1, ts: '1', from: did, text: r.sanitized_text, nonce: String(r.nonce),
  };
  assert.equal(labelMessage(m, [r]), 'self_verified');
});
