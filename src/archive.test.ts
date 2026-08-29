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
  const m: RoomMessage = { seq: 1, ts: '1', from: 'did:key:zAAA', text: 'hi', nonce: 5 };
  assert.equal(labelMessage(m, []), 'server_attested');
});

test('a message matching one of our own receipts is self_verified', () => {
  isolate();
  const { did, privateKey } = generateIdentity();
  const r = createReceipt(privateKey, did, 'lobby', 'hello', 'https://x', []);
  const m: RoomMessage = {
    seq: 1, ts: '1', from: did, text: r.sanitized_text, nonce: r.nonce,
  };
  assert.equal(labelMessage(m, [r]), 'self_verified');
});

test('a receipt that does not match the message text is not self_verified', () => {
  isolate();
  const { did, privateKey } = generateIdentity();
  const r = createReceipt(privateKey, did, 'lobby', 'hello', 'https://x', []);
  const m: RoomMessage = { seq: 1, ts: '1', from: did, text: 'tampered', nonce: r.nonce };
  assert.equal(labelMessage(m, [r]), 'server_attested');
});

test('archiveRoom writes labelled messages and reloads them', async () => {
  isolate();
  const fakeFetch = async () =>
    new Response(
      JSON.stringify({
        messages: [
          { seq: 1, ts: '1', from: '~a', text: 'hi' },
          { seq: 2, ts: '2', from: 'did:key:zAAA', text: 'yo', nonce: 3 },
        ],
      }),
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
    new Response(
      JSON.stringify({ messages: [{ seq: 1, ts: '1', from: '~a', text: 'hi' }] }),
      { status: 200 },
    );
  const opts = { fetchImpl: fakeFetch as unknown as typeof fetch };
  await archiveRoom('lobby', opts);
  const second = await archiveRoom('lobby', opts);
  assert.equal(second.written, 0);
  assert.equal(loadArchive('lobby').length, 1);
});
