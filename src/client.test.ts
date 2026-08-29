import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRoomResponse, fetchRoom } from './client.js';

test('parses well-formed messages', () => {
  const msgs = parseRoomResponse({
    messages: [
      { seq: 1, ts: '1', from: '~nick', text: 'hi' },
      { seq: 2, ts: '2', from: 'did:key:zAAA', text: 'yo', nonce: 9 },
    ],
  });
  assert.equal(msgs.length, 2);
  assert.equal(msgs[1].nonce, 9);
});

test('drops entries that are not shaped like messages', () => {
  const msgs = parseRoomResponse({
    messages: [{ seq: 1, ts: '1', from: '~a', text: 'ok' }, null, 42, { seq: 'x' }],
  });
  assert.equal(msgs.length, 1);
});

test('returns an empty list for a body without a messages array', () => {
  assert.deepEqual(parseRoomResponse({}), []);
  assert.deepEqual(parseRoomResponse(null), []);
});

test('fetchRoom requests the json format and returns parsed messages', async () => {
  let seen = '';
  const fakeFetch = async (url: string | URL) => {
    seen = String(url);
    return new Response(
      JSON.stringify({ messages: [{ seq: 1, ts: '1', from: '~a', text: 'hi' }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
  const msgs = await fetchRoom('lobby', {
    limit: 200,
    fetchImpl: fakeFetch as unknown as typeof fetch,
  });
  assert.match(seen, /\/r\/lobby\?/);
  assert.match(seen, /format=json/);
  assert.match(seen, /limit=200/);
  assert.equal(msgs.length, 1);
});

test('fetchRoom throws on a non-ok response', async () => {
  const fakeFetch = async () => new Response('nope', { status: 429 });
  await assert.rejects(
    () => fetchRoom('lobby', { fetchImpl: fakeFetch as unknown as typeof fetch }),
    /429/,
  );
});

test('fetchRoom rejects an unsafe room name before making a request', async () => {
  let called = false;
  const fakeFetch = async () => {
    called = true;
    return new Response('{}');
  };
  await assert.rejects(
    () => fetchRoom('../etc', { fetchImpl: fakeFetch as unknown as typeof fetch }),
    /room name/,
  );
  assert.equal(called, false);
});

test('fetchRoom rejects the dot name without making a request', async () => {
  let called = false;
  const fakeFetch = async () => {
    called = true;
    return new Response('{}');
  };
  await assert.rejects(
    () => fetchRoom('.', { fetchImpl: fakeFetch as unknown as typeof fetch }),
    /unsafe room name/,
  );
  assert.equal(called, false);
});

test('fetchRoom rejects the double-dot name without making a request', async () => {
  let called = false;
  const fakeFetch = async () => {
    called = true;
    return new Response('{}');
  };
  await assert.rejects(
    () => fetchRoom('..', { fetchImpl: fakeFetch as unknown as typeof fetch }),
    /unsafe room name/,
  );
  assert.equal(called, false);
});

test('fetchRoom rejects names with path separators without making a request', async () => {
  let called = false;
  const fakeFetch = async () => {
    called = true;
    return new Response('{}');
  };
  await assert.rejects(
    () => fetchRoom('a/b', { fetchImpl: fakeFetch as unknown as typeof fetch }),
    /unsafe room name/,
  );
  assert.equal(called, false);
});

test('fetchRoom rejects empty room name without making a request', async () => {
  let called = false;
  const fakeFetch = async () => {
    called = true;
    return new Response('{}');
  };
  await assert.rejects(
    () => fetchRoom('', { fetchImpl: fakeFetch as unknown as typeof fetch }),
    /unsafe room name/,
  );
  assert.equal(called, false);
});

test('fetchRoom rejects names over 64 characters without making a request', async () => {
  let called = false;
  const fakeFetch = async () => {
    called = true;
    return new Response('{}');
  };
  const longName = 'a'.repeat(65);
  await assert.rejects(
    () => fetchRoom(longName, { fetchImpl: fakeFetch as unknown as typeof fetch }),
    /unsafe room name/,
  );
  assert.equal(called, false);
});

test('fetchRoom rejects names with spaces without making a request', async () => {
  let called = false;
  const fakeFetch = async () => {
    called = true;
    return new Response('{}');
  };
  await assert.rejects(
    () => fetchRoom('a b', { fetchImpl: fakeFetch as unknown as typeof fetch }),
    /unsafe room name/,
  );
  assert.equal(called, false);
});

test('fetchRoom accepts legitimate dotted room names', async () => {
  let seen = '';
  const fakeFetch = async (url: string | URL) => {
    seen = String(url);
    return new Response(JSON.stringify({ messages: [] }), { status: 200 });
  };
  const msgs = await fetchRoom('room.v2', {
    fetchImpl: fakeFetch as unknown as typeof fetch,
  });
  assert.match(seen, /\/r\/room\.v2\?/);
  assert.equal(msgs.length, 0);
});
