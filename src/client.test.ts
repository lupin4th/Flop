import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRoomResponse, fetchRoom, fetchLatestSeq, exportRoom } from './client.js';

test('parses well-formed messages', () => {
  const msgs = parseRoomResponse({
    messages: [
      { seq: 1, ts: '1', from: '~nick', text: 'hi' },
      { seq: 2, ts: '2', from: 'did:key:zAAA', text: 'yo', nonce: 9 },
    ],
  });
  assert.equal(msgs.length, 2);
  // nonce is always normalised to its exact decimal string, never a number,
  // so that a nonce beyond Number.MAX_SAFE_INTEGER is never silently rounded.
  assert.equal(msgs[1].nonce, '9');
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

// --- exact-nonce recovery (regression: nanosecond nonces beyond 2^53) ------

test('fetchRoom recovers a nonce beyond Number.MAX_SAFE_INTEGER as its exact digit string', async () => {
  const bigNonce = '1789348196321255900';
  // Built by hand, not via JSON.stringify: JSON.stringify(1789348196321255900)
  // would already have rounded the number before it ever became text, which
  // is exactly the bug. The raw body must carry the unrounded digits, the
  // way the real server's response bytes do.
  const body = `{"messages":[{"seq":1,"ts":"t","from":"did:key:zAAA","text":"hi","nonce":${bigNonce}}]}`;
  const fakeFetch = async () => new Response(body, { status: 200 });
  const msgs = await fetchRoom('lobby', { fetchImpl: fakeFetch as unknown as typeof fetch });
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].nonce, bigNonce);
  assert.notEqual(msgs[0].nonce, String(Number(bigNonce)));
});

test('fetchRoom falls back to the parsed (rounded) nonce when raw and parsed counts disagree', async () => {
  // A pathological body where the number of raw "nonce": occurrences does not
  // match the number of messages carrying a nonce after parsing (here, an
  // extra "nonce" substring appears outside the messages array). The fix
  // must not mispair in this case — it should fall back to the parsed value
  // rather than guess.
  const body =
    '{"decoyNonce":{"nonce":1},"messages":[{"seq":1,"ts":"t","from":"did:key:zAAA","text":"hi","nonce":5}]}';
  const fakeFetch = async () => new Response(body, { status: 200 });
  const msgs = await fetchRoom('lobby', { fetchImpl: fakeFetch as unknown as typeof fetch });
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].nonce, '5');
});

// --- exportRoom ------------------------------------------------------------

test('exportRoom parses JSONL and carries the sig field through', async () => {
  const lines = [
    JSON.stringify({ seq: 1, ts: 't1', from: '~anon', text: 'hi' }),
    JSON.stringify({ seq: 2, ts: 't2', from: 'did:key:zAAA', text: 'yo', nonce: 9, sig: 'AbC123' }),
  ];
  let seen = '';
  const fakeFetch = async (url: string | URL) => {
    seen = String(url);
    return new Response(lines.join('\n') + '\n', { status: 200 });
  };
  const msgs = await exportRoom('lobby', { fetchImpl: fakeFetch as unknown as typeof fetch });
  assert.match(seen, /\/r\/lobby\/export/);
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].sig, undefined);
  assert.equal(msgs[1].sig, 'AbC123');
  assert.equal(msgs[1].nonce, '9');
});

test('exportRoom recovers a nanosecond nonce as exact decimal text, not a rounded number', async () => {
  const bigNonce = '1789348196321255900';
  const line = `{"seq":1,"ts":"t","from":"did:key:zAAA","text":"hi","nonce":${bigNonce},"sig":"s"}`;
  const fakeFetch = async () => new Response(line + '\n', { status: 200 });
  const msgs = await exportRoom('lobby', { fetchImpl: fakeFetch as unknown as typeof fetch });
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].nonce, bigNonce);
  assert.notEqual(msgs[0].nonce, String(Number(bigNonce)));
});

test('exportRoom rejects an unsafe room name before making a request', async () => {
  let called = false;
  const fakeFetch = async () => {
    called = true;
    return new Response('');
  };
  await assert.rejects(
    () => exportRoom('../etc', { fetchImpl: fakeFetch as unknown as typeof fetch }),
    /unsafe room name/,
  );
  assert.equal(called, false);
});

test('exportRoom throws on a non-ok response', async () => {
  const fakeFetch = async () => new Response('nope', { status: 500 });
  await assert.rejects(
    () => exportRoom('lobby', { fetchImpl: fakeFetch as unknown as typeof fetch }),
    /500/,
  );
});

test('exportRoom skips a blank line and a malformed line rather than throwing', async () => {
  const lines = [
    JSON.stringify({ seq: 1, ts: 't1', from: '~anon', text: 'ok one' }),
    '',
    'not json at all {{{',
    JSON.stringify({ seq: 3, ts: 't3', from: '~anon', text: 'ok two' }),
  ];
  const fakeFetch = async () => new Response(lines.join('\n') + '\n', { status: 200 });
  const msgs = await exportRoom('lobby', { fetchImpl: fakeFetch as unknown as typeof fetch });
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].seq, 1);
  assert.equal(msgs[1].seq, 3);
});
