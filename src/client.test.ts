import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRoomResponse, fetchRoom, fetchLatestSeq } from './client.js';

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

test('fetchRoom adds wait to the query string when set', async () => {
  let seen = '';
  const fakeFetch = async (url: string | URL) => {
    seen = String(url);
    return new Response(JSON.stringify({ messages: [] }), { status: 200 });
  };
  await fetchRoom('lobby', { wait: 10, fetchImpl: fakeFetch as unknown as typeof fetch });
  assert.match(seen, /wait=10/);
});

test('fetchRoom omits wait from the query string when unset', async () => {
  let seen = '';
  const fakeFetch = async (url: string | URL) => {
    seen = String(url);
    return new Response(JSON.stringify({ messages: [] }), { status: 200 });
  };
  await fetchRoom('lobby', { fetchImpl: fakeFetch as unknown as typeof fetch });
  assert.equal(/wait=/.test(seen), false);
});

test('fetchRoom clamps wait above 10 down to 10', async () => {
  let seen = '';
  const fakeFetch = async (url: string | URL) => {
    seen = String(url);
    return new Response(JSON.stringify({ messages: [] }), { status: 200 });
  };
  await fetchRoom('lobby', { wait: 999, fetchImpl: fakeFetch as unknown as typeof fetch });
  assert.match(seen, /wait=10/);
});

test('fetchRoom clamps a negative wait up to 0', async () => {
  let seen = '';
  const fakeFetch = async (url: string | URL) => {
    seen = String(url);
    return new Response(JSON.stringify({ messages: [] }), { status: 200 });
  };
  await fetchRoom('lobby', { wait: -5, fetchImpl: fakeFetch as unknown as typeof fetch });
  assert.match(seen, /wait=0/);
});

test('fetchLatestSeq returns the highest seq in the room', async () => {
  const fakeFetch = async () =>
    new Response(
      JSON.stringify({ messages: [{ seq: 42, ts: '1', from: '~a', text: 'hi' }] }),
      { status: 200 },
    );
  const seq = await fetchLatestSeq('lobby', { fetchImpl: fakeFetch as unknown as typeof fetch });
  assert.equal(seq, 42);
});

test('fetchLatestSeq requests limit=1', async () => {
  let seen = '';
  const fakeFetch = async (url: string | URL) => {
    seen = String(url);
    return new Response(JSON.stringify({ messages: [] }), { status: 200 });
  };
  await fetchLatestSeq('lobby', { fetchImpl: fakeFetch as unknown as typeof fetch });
  assert.match(seen, /limit=1\b/);
});

test('fetchLatestSeq returns 0 for an empty room', async () => {
  const fakeFetch = async () =>
    new Response(JSON.stringify({ messages: [] }), { status: 200 });
  const seq = await fetchLatestSeq('lobby', { fetchImpl: fakeFetch as unknown as typeof fetch });
  assert.equal(seq, 0);
});
