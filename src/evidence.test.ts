import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { generateIdentity } from './keystore.js';
import { signPayload } from './verify.js';
import { captureSelfEvidence, verifySelfEvidence } from './evidence.js';

const OTHER_DID = 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK';

function fakeExportFetch(byRoom: Record<string, string>) {
  return (async (url: string | URL) => {
    const s = String(url);
    for (const [room, body] of Object.entries(byRoom)) {
      if (s.includes(`/r/${room}/export`)) {
        return new Response(body, { status: 200 });
      }
    }
    return new Response('boom', { status: 500 });
  }) as unknown as typeof fetch;
}

function jsonl(lines: unknown[]): string {
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
}

test('captureSelfEvidence keeps only messages whose from matches our did', async () => {
  const { did, privateKey } = generateIdentity();
  const sig = signPayload(privateKey, 'technocore', 5, 'hello');
  const body = jsonl([
    { seq: 1, ts: 't1', from: OTHER_DID, text: 'not mine' },
    { seq: 2, ts: 't2', from: did, text: 'hello', nonce: 5, sig },
  ]);
  const evidence = await captureSelfEvidence(did, ['technocore'], {
    fetchImpl: fakeExportFetch({ technocore: body }),
  });
  assert.equal(evidence.rooms.length, 1);
  const room = evidence.rooms[0];
  assert.equal(room.room, 'technocore');
  assert.equal(room.mine.length, 1);
  assert.equal(room.mine[0].seq, 2);
  assert.equal(room.mine[0].from, did);
});

test('captureSelfEvidence records first/last seq, total message count and a stable body hash', async () => {
  const { did } = generateIdentity();
  const body = jsonl([
    { seq: 10, ts: 't1', from: OTHER_DID, text: 'a' },
    { seq: 11, ts: 't2', from: OTHER_DID, text: 'b' },
    { seq: 12, ts: 't3', from: OTHER_DID, text: 'c' },
  ]);
  const evidence = await captureSelfEvidence(did, ['technocore'], {
    fetchImpl: fakeExportFetch({ technocore: body }),
  });
  const room = evidence.rooms[0];
  assert.equal(room.first_seq, 10);
  assert.equal(room.last_seq, 12);
  assert.equal(room.message_count, 3);
  assert.equal(room.export_sha256, createHash('sha256').update(body).digest('hex'));
});

test('a room that fails to fetch is recorded as message_count -1 and does not abort other rooms', async () => {
  const { did } = generateIdentity();
  const okBody = jsonl([{ seq: 1, ts: 't', from: OTHER_DID, text: 'ok' }]);
  const evidence = await captureSelfEvidence(did, ['broken', 'technocore'], {
    fetchImpl: fakeExportFetch({ technocore: okBody }),
  });
  const broken = evidence.rooms.find((r: { room: string }) => r.room === 'broken')!;
  const ok = evidence.rooms.find((r: { room: string }) => r.room === 'technocore')!;
  assert.equal(broken.message_count, -1);
  assert.deepEqual(broken.mine, []);
  assert.equal(ok.message_count, 1);
});

test('an empty room is handled without error', async () => {
  const { did } = generateIdentity();
  const evidence = await captureSelfEvidence(did, ['empty'], {
    fetchImpl: fakeExportFetch({ empty: '' }),
  });
  const room = evidence.rooms[0];
  assert.equal(room.message_count, 0);
  assert.equal(room.first_seq, 0);
  assert.equal(room.last_seq, 0);
  assert.deepEqual(room.mine, []);
});

test('verifySelfEvidence returns all-valid for a genuine capture', async () => {
  const { did, privateKey } = generateIdentity();
  const sig = signPayload(privateKey, 'technocore', 5, 'hello');
  const body = jsonl([{ seq: 2, ts: 't2', from: did, text: 'hello', nonce: 5, sig }]);
  const evidence = await captureSelfEvidence(did, ['technocore'], {
    fetchImpl: fakeExportFetch({ technocore: body }),
  });
  const result = verifySelfEvidence(evidence);
  assert.equal(result.checked, 1);
  assert.equal(result.valid, 1);
  assert.deepEqual(result.invalid, []);
});

test('verifySelfEvidence flags a tampered text', async () => {
  const { did, privateKey } = generateIdentity();
  const sig = signPayload(privateKey, 'technocore', 5, 'hello');
  // The server now serves different text under the same signature — as if
  // the capture (or the room) had been tampered with after the fact.
  const body = jsonl([{ seq: 2, ts: 't2', from: did, text: 'tampered', nonce: 5, sig }]);
  const evidence = await captureSelfEvidence(did, ['technocore'], {
    fetchImpl: fakeExportFetch({ technocore: body }),
  });
  const result = verifySelfEvidence(evidence);
  assert.equal(result.checked, 1);
  assert.equal(result.valid, 0);
  assert.equal(result.invalid.length, 1);
  assert.match(result.invalid[0], /technocore/);
});
