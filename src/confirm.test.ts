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

/**
 * Flips every bit of the signature's first byte, then re-encodes. This is
 * deterministically a different 64-byte signature from the original, so it
 * fails verification with certainty. Overwriting only the trailing base64url
 * characters (as opposed to XOR-ing a decoded byte) is NOT safe here: the
 * last byte of a signature is uniformly random, so pinning the last
 * characters to a fixed string has a real chance (1 in 256) of coincidentally
 * reconstructing the original, still-valid signature — exactly the source of
 * an intermittent failure observed in this suite.
 */
function tamperSignature(sigB64url: string): string {
  const buf = Buffer.from(sigB64url, 'base64url');
  buf[0] = buf[0] ^ 0xff;
  return buf.toString('base64url');
}

/**
 * Like scriptedFetch, but each round can also be scripted to fail the way
 * the real server has been observed to fail: a thrown network error, a 503,
 * or a 200 response whose body is not JSON (`res.json()` throws). Running
 * past the end of `rounds` repeats the last entry, which is used to model a
 * server that stays down until the deadline.
 */
type ScriptedRound = RoomMessage[] | 'throw' | 'bad-json' | '503';

function scriptedFetchWithFailures(rounds: ScriptedRound[]) {
  let call = 0;
  return async () => {
    const round = rounds[Math.min(call, rounds.length - 1)];
    call++;
    if (round === 'throw') throw new Error('network error');
    if (round === 'bad-json') return new Response('Service Unavailable', { status: 200 });
    if (round === '503') return new Response('Service Unavailable', { status: 503 });
    return new Response(JSON.stringify({ messages: round }), { status: 200 });
  };
}

/** Records every delay it is asked to wait, without actually waiting. */
function fakeSleep(calls: number[]) {
  return async (ms: number) => {
    calls.push(ms);
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
  const tampered: Receipt = { ...r, sig: tamperSignature(r.sig) };
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
  const tampered: Receipt = { ...r, sig: tamperSignature(r.sig) };
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

test('confirmRoom recovers from a poll round that throws and still confirms on a later round', async () => {
  isolate();
  const { did, privateKey } = generateIdentity();
  const r = createReceipt(privateKey, did, 'lobby', 'hello', BASE, []);
  const fetchImpl = scriptedFetchWithFailures([
    [], // watermark lookup: empty room -> 0
    'throw',
    [{ seq: 1, ts: 't1', from: did, text: r.sanitized_text, nonce: r.nonce }],
  ]);
  const sleepCalls: number[] = [];
  const result = await confirmRoom('lobby', [r], {
    fetchImpl: fetchImpl as unknown as typeof fetch,
    nowMs: fakeClock(0, 1000),
    sleep: fakeSleep(sleepCalls),
  });
  assert.equal(result.timedOut, false);
  assert.equal(result.found.length, 1);
  assert.equal(result.found[0].seq, 1);
  assert.equal(result.errors, 1);
});

test('confirmRoom recovers from a 200 response with a non-JSON body and still confirms later', async () => {
  isolate();
  const { did, privateKey } = generateIdentity();
  const r = createReceipt(privateKey, did, 'lobby', 'hello', BASE, []);
  const fetchImpl = scriptedFetchWithFailures([
    [],
    'bad-json',
    [{ seq: 1, ts: 't1', from: did, text: r.sanitized_text, nonce: r.nonce }],
  ]);
  const sleepCalls: number[] = [];
  const result = await confirmRoom('lobby', [r], {
    fetchImpl: fetchImpl as unknown as typeof fetch,
    nowMs: fakeClock(0, 1000),
    sleep: fakeSleep(sleepCalls),
  });
  assert.equal(result.timedOut, false);
  assert.equal(result.found.length, 1);
  assert.equal(result.found[0].seq, 1);
  assert.equal(result.errors, 1);
});

test('confirmRoom recovers from a 503 and still confirms on a later round', async () => {
  isolate();
  const { did, privateKey } = generateIdentity();
  const r = createReceipt(privateKey, did, 'lobby', 'hello', BASE, []);
  const fetchImpl = scriptedFetchWithFailures([
    [],
    '503',
    [{ seq: 1, ts: 't1', from: did, text: r.sanitized_text, nonce: r.nonce }],
  ]);
  const sleepCalls: number[] = [];
  const result = await confirmRoom('lobby', [r], {
    fetchImpl: fetchImpl as unknown as typeof fetch,
    nowMs: fakeClock(0, 1000),
    sleep: fakeSleep(sleepCalls),
  });
  assert.equal(result.timedOut, false);
  assert.equal(result.found.length, 1);
  assert.equal(result.found[0].seq, 1);
  assert.equal(result.errors, 1);
});

test('confirmRoom times out without throwing when the server errors all the way to the deadline', async () => {
  isolate();
  const { did, privateKey } = generateIdentity();
  const r = createReceipt(privateKey, did, 'lobby', 'hello', BASE, []);
  const fetchImpl = scriptedFetchWithFailures([
    [], // watermark lookup succeeds
    '503',
    'bad-json',
    'throw',
    '503',
    'throw',
  ]);
  const sleepCalls: number[] = [];
  const result = await confirmRoom('lobby', [r], {
    fetchImpl: fetchImpl as unknown as typeof fetch,
    nowMs: fakeClock(0, 1000),
    timeoutMs: 5000,
    sleep: fakeSleep(sleepCalls),
  });
  assert.equal(result.timedOut, true);
  assert.equal(result.found.length, 0);
  assert.ok(result.errors >= 1, `expected at least one recorded error, got ${result.errors}`);
});

test('confirmRoom paces itself against a server that answers instantly, instead of hot-looping', async () => {
  isolate();
  const { did, privateKey } = generateIdentity();
  const r = createReceipt(privateKey, did, 'lobby', 'hello', BASE, []);
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return new Response(JSON.stringify({ messages: [] }), { status: 200 });
  };
  let now = 0;
  const sleepCalls: number[] = [];
  const result = await confirmRoom('lobby', [r], {
    fetchImpl: fetchImpl as unknown as typeof fetch,
    // Only our own `sleep` advances the clock, modelling a server that
    // answers every request instantly (elapsed time per round is ~0).
    nowMs: () => now,
    sleep: async (ms: number) => {
      sleepCalls.push(ms);
      now += ms;
    },
    timeoutMs: 5000,
  });
  assert.equal(result.timedOut, true);
  assert.ok(sleepCalls.length > 0, 'expected the loop to pace itself with sleep calls');
  assert.ok(
    sleepCalls.every((ms) => ms > 0 && ms <= 1000),
    `expected every sleep to be between 0 and minIntervalMs, got ${JSON.stringify(sleepCalls)}`,
  );
  assert.ok(
    calls < 20,
    `expected a bounded number of requests against an instantly-answering server, got ${calls}`,
  );
});
