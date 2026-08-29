import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateIdentity } from './keystore.js';
import { createReceipt, type Receipt } from './receipts.js';
import {
  matchesReceipt,
  loadConfirmations,
  appendConfirmation,
  unconfirmedReceipts,
  confirmRoom,
  type Confirmation,
} from './confirm.js';
import type { RoomMessage } from './client.js';

const BASE = 'https://technocore.chat';

function isolate() {
  process.env.TECHNOCORE_ATTEST_HOME = mkdtempSync(join(tmpdir(), 'attest-'));
}

/**
 * Builds a fetchImpl that replays a fixed sequence of message batches: the
 * first call is treated as the fetchLatestSeq lookup, and each call after
 * that is one long-poll round. Running past the end of `rounds` just repeats
 * an empty batch, so a timeout test can let the loop spin without crashing.
 */
function scriptedFetch(rounds: RoomMessage[][]) {
  let call = 0;
  return async () => {
    const messages = rounds[call] ?? [];
    call++;
    return new Response(JSON.stringify({ messages }), { status: 200 });
  };
}

function fakeClock(start: number, stepMs: number) {
  let now = start;
  return () => {
    const t = now;
    now += stepMs;
    return t;
  };
}

test('matchesReceipt is true only for a message that matches did, nonce, text and verifies', () => {
  isolate();
  const { did, privateKey } = generateIdentity();
  const r = createReceipt(privateKey, did, 'lobby', 'hello', BASE, []);
  const m: RoomMessage = { seq: 1, ts: 't', from: did, text: r.sanitized_text, nonce: r.nonce };
  assert.equal(matchesReceipt(m, r), true);
});

test('matchesReceipt ignores a message from a different did', () => {
  isolate();
  const { did, privateKey } = generateIdentity();
  const other = generateIdentity();
  const r = createReceipt(privateKey, did, 'lobby', 'hello', BASE, []);
  const m: RoomMessage = {
    seq: 1, ts: 't', from: other.did, text: r.sanitized_text, nonce: r.nonce,
  };
  assert.equal(matchesReceipt(m, r), false);
});

test('matchesReceipt ignores a message with the right did and nonce but different text', () => {
  isolate();
  const { did, privateKey } = generateIdentity();
  const r = createReceipt(privateKey, did, 'lobby', 'hello', BASE, []);
  const m: RoomMessage = { seq: 1, ts: 't', from: did, text: 'tampered', nonce: r.nonce };
  assert.equal(matchesReceipt(m, r), false);
});

test('matchesReceipt rejects a receipt whose signature does not verify', () => {
  isolate();
  const { did, privateKey } = generateIdentity();
  const r = createReceipt(privateKey, did, 'lobby', 'hello', BASE, []);
  const tampered: Receipt = { ...r, sig: r.sig.slice(0, -2) + 'AA' };
  const m: RoomMessage = { seq: 1, ts: 't', from: did, text: tampered.sanitized_text, nonce: tampered.nonce };
  assert.equal(matchesReceipt(m, tampered), false);
});

test('appendConfirmation then loadConfirmations round-trips', () => {
  isolate();
  const c: Confirmation = {
    v: 1, did: 'did:key:zAAA', room: 'lobby', nonce: 1, sig: 'sig',
    seq: 5, server_ts: 'ts', confirmed_at: 'now',
  };
  appendConfirmation(c);
  const { confirmations, malformed } = loadConfirmations();
  assert.equal(confirmations.length, 1);
  assert.deepEqual(confirmations[0], c);
  assert.equal(malformed, 0);
});

test('unconfirmedReceipts excludes receipts already confirmed for that room', () => {
  isolate();
  const { did, privateKey } = generateIdentity();
  const r = createReceipt(privateKey, did, 'lobby', 'hello', BASE, []);
  const c: Confirmation = {
    v: 1, did: r.did, room: r.room, nonce: r.nonce, sig: r.sig,
    seq: 5, server_ts: 'ts', confirmed_at: 'now',
  };
  assert.deepEqual(unconfirmedReceipts('lobby', [r], []), [r]);
  assert.deepEqual(unconfirmedReceipts('lobby', [r], [c]), []);
});

test('unconfirmedReceipts only considers receipts for the given room', () => {
  isolate();
  const { did, privateKey } = generateIdentity();
  const r = createReceipt(privateKey, did, 'other-room', 'hello', BASE, []);
  assert.deepEqual(unconfirmedReceipts('lobby', [r], []), []);
});

test('confirmRoom confirms a matching message that appears after the watermark', async () => {
  isolate();
  const { did, privateKey } = generateIdentity();
  const r = createReceipt(privateKey, did, 'lobby', 'hello', BASE, []);
  const fetchImpl = scriptedFetch([
    [{ seq: 5, ts: 't0', from: '~a', text: 'noise' }], // fetchLatestSeq -> watermark 5
    [{ seq: 6, ts: 't1', from: did, text: r.sanitized_text, nonce: r.nonce }],
  ]);
  const result = await confirmRoom('lobby', [r], {
    fetchImpl: fetchImpl as unknown as typeof fetch,
    nowMs: fakeClock(0, 1000),
  });
  assert.equal(result.timedOut, false);
  assert.equal(result.found.length, 1);
  assert.equal(result.found[0].seq, 6);
  assert.equal(result.found[0].server_ts, 't1');
  assert.equal(result.watched, 1);
  const { confirmations } = loadConfirmations();
  assert.equal(confirmations.length, 1);
});

test('confirmRoom ignores a message from a different did', async () => {
  isolate();
  const { did, privateKey } = generateIdentity();
  const other = generateIdentity();
  const r = createReceipt(privateKey, did, 'lobby', 'hello', BASE, []);
  const fetchImpl = scriptedFetch([
    [],
    [{ seq: 1, ts: 't1', from: other.did, text: r.sanitized_text, nonce: r.nonce }],
  ]);
  const result = await confirmRoom('lobby', [r], {
    fetchImpl: fetchImpl as unknown as typeof fetch,
    nowMs: fakeClock(0, 200_000),
    timeoutMs: 100_000,
  });
  assert.equal(result.timedOut, true);
  assert.equal(result.found.length, 0);
});

test('confirmRoom ignores a message with the right did and nonce but different text', async () => {
  isolate();
  const { did, privateKey } = generateIdentity();
  const r = createReceipt(privateKey, did, 'lobby', 'hello', BASE, []);
  const fetchImpl = scriptedFetch([
    [],
    [{ seq: 1, ts: 't1', from: did, text: 'tampered', nonce: r.nonce }],
  ]);
  const result = await confirmRoom('lobby', [r], {
    fetchImpl: fetchImpl as unknown as typeof fetch,
    nowMs: fakeClock(0, 200_000),
    timeoutMs: 100_000,
  });
  assert.equal(result.timedOut, true);
  assert.equal(result.found.length, 0);
});

test('confirmRoom never confirms a receipt whose signature does not verify', async () => {
  isolate();
  const { did, privateKey } = generateIdentity();
  const r = createReceipt(privateKey, did, 'lobby', 'hello', BASE, []);
  const tampered: Receipt = { ...r, sig: r.sig.slice(0, -2) + 'AA' };
  const fetchImpl = scriptedFetch([
    [],
    [{ seq: 1, ts: 't1', from: did, text: tampered.sanitized_text, nonce: tampered.nonce }],
  ]);
  const result = await confirmRoom('lobby', [tampered], {
    fetchImpl: fetchImpl as unknown as typeof fetch,
    nowMs: fakeClock(0, 200_000),
    timeoutMs: 100_000,
  });
  assert.equal(result.timedOut, true);
  assert.equal(result.found.length, 0);
});

test('confirmRoom does not re-confirm an already-confirmed receipt', async () => {
  isolate();
  const { did, privateKey } = generateIdentity();
  const r = createReceipt(privateKey, did, 'lobby', 'hello', BASE, []);
  appendConfirmation({
    v: 1, did: r.did, room: r.room, nonce: r.nonce, sig: r.sig,
    seq: 6, server_ts: 't1', confirmed_at: 'earlier',
  });
  let called = false;
  const fetchImpl = async () => {
    called = true;
    return new Response(JSON.stringify({ messages: [] }), { status: 200 });
  };
  const result = await confirmRoom('lobby', [r], {
    fetchImpl: fetchImpl as unknown as typeof fetch,
    nowMs: fakeClock(0, 1000),
  });
  assert.equal(result.found.length, 0);
  assert.equal(result.timedOut, false);
  assert.equal(called, false);
});

test('confirmRoom advances its watermark across multiple polls and finds a later match', async () => {
  isolate();
  const { did, privateKey } = generateIdentity();
  const r = createReceipt(privateKey, did, 'lobby', 'hello', BASE, []);
  const fetchImpl = scriptedFetch([
    [{ seq: 10, ts: 't0', from: '~a', text: 'noise' }], // watermark 10
    [{ seq: 11, ts: 't1', from: '~a', text: 'still not it' }],
    [{ seq: 12, ts: 't2', from: '~a', text: 'nope' }],
    [{ seq: 13, ts: 't3', from: did, text: r.sanitized_text, nonce: r.nonce }],
  ]);
  const result = await confirmRoom('lobby', [r], {
    fetchImpl: fetchImpl as unknown as typeof fetch,
    nowMs: fakeClock(0, 1000),
  });
  assert.equal(result.timedOut, false);
  assert.equal(result.found.length, 1);
  assert.equal(result.found[0].seq, 13);
  assert.equal(result.watched, 3);
});

test('confirmRoom times out with the receipt still unconfirmed', async () => {
  isolate();
  const { did, privateKey } = generateIdentity();
  const r = createReceipt(privateKey, did, 'lobby', 'hello', BASE, []);
  const fetchImpl = scriptedFetch([[]]); // always empty after the initial watermark lookup
  const result = await confirmRoom('lobby', [r], {
    fetchImpl: fetchImpl as unknown as typeof fetch,
    nowMs: fakeClock(0, 50_000),
    timeoutMs: 120_000,
  });
  assert.equal(result.timedOut, true);
  assert.equal(result.found.length, 0);
  const { confirmations } = loadConfirmations();
  assert.equal(confirmations.length, 0);
});

test('confirmRoom on an empty room starts from watermark 0 and does not crash', async () => {
  isolate();
  const { did, privateKey } = generateIdentity();
  const r = createReceipt(privateKey, did, 'lobby', 'hello', BASE, []);
  const fetchImpl = scriptedFetch([
    [], // empty room -> fetchLatestSeq returns 0
    [{ seq: 1, ts: 't1', from: did, text: r.sanitized_text, nonce: r.nonce }],
  ]);
  const result = await confirmRoom('lobby', [r], {
    fetchImpl: fetchImpl as unknown as typeof fetch,
    nowMs: fakeClock(0, 1000),
  });
  assert.equal(result.timedOut, false);
  assert.equal(result.found.length, 1);
  assert.equal(result.found[0].seq, 1);
});
