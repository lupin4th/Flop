import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, appendFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from './cli.js';
import { receiptsPath } from './paths.js';
import { readStoredDid, loadIdentity, generateIdentity } from './keystore.js';
import { signPayload } from './verify.js';

function harness(answers: string[] = []) {
  const lines: string[] = [];
  let i = 0;
  return {
    lines,
    io: {
      out: (s: string) => lines.push(s),
      prompt: async () => answers[i++] ?? '',
    },
  };
}

function isolate() {
  process.env.TECHNOCORE_ATTEST_HOME = mkdtempSync(join(tmpdir(), 'attest-'));
}

test('keygen prints a did:key and creates an identity', async () => {
  isolate();
  const h = harness(['pw', 'pw']);
  const code = await run(['keygen'], h.io);
  assert.equal(code, 0);
  assert.match(h.lines.join('\n'), /did:key:z6Mk/);
});

test('keygen refuses to overwrite an existing identity', async () => {
  isolate();
  await run(['keygen'], harness(['pw', 'pw']).io);
  const h = harness(['pw', 'pw']);
  const code = await run(['keygen'], h.io);
  assert.notEqual(code, 0);
  assert.match(h.lines.join('\n'), /already exists/);
});

test('keygen aborts when the two passphrase entries differ', async () => {
  isolate();
  const h = harness(['pw', 'different']);
  const code = await run(['keygen'], h.io);
  assert.notEqual(code, 0);
  assert.match(h.lines.join('\n'), /did not match/);
});

test('sign prints a post url but never sends it', async () => {
  isolate();
  await run(['keygen'], harness(['pw', 'pw']).io);
  const h = harness(['pw']);
  const code = await run(['sign', 'lobby', 'hello there'], h.io);
  assert.equal(code, 0);
  const out = h.lines.join('\n');
  assert.match(out, /say-signed/);
  assert.match(out, /not been sent/i);
});

test('receipts verify reports the stored receipt as verified', async () => {
  isolate();
  await run(['keygen'], harness(['pw', 'pw']).io);
  await run(['sign', 'lobby', 'hello'], harness(['pw']).io);
  const h = harness();
  const code = await run(['receipts', 'verify'], h.io);
  assert.equal(code, 0);
  assert.match(h.lines.join('\n'), /1 verified/);
});

test('an unknown command exits non-zero with usage', async () => {
  isolate();
  const h = harness();
  const code = await run(['nope'], h.io);
  assert.notEqual(code, 0);
  assert.match(h.lines.join('\n'), /Usage/);
});

test('receipts verify warns and exits non-zero when the log has a malformed line', async () => {
  isolate();
  await run(['keygen'], harness(['pw', 'pw']).io);
  await run(['sign', 'lobby', 'hello'], harness(['pw']).io);
  // Append a truncated fragment that cannot be parsed as a receipt.
  appendFileSync(receiptsPath(), '{"v":1,"did":"did:key:z', { mode: 0o600 });
  const h = harness();
  const code = await run(['receipts', 'verify'], h.io);
  assert.notEqual(code, 0);
  assert.match(h.lines.join('\n'), /1 .*(malformed|could not be read|lost)/i);
});

test('receipts verify prints no warning and exits zero when the log is clean', async () => {
  isolate();
  await run(['keygen'], harness(['pw', 'pw']).io);
  await run(['sign', 'lobby', 'hello'], harness(['pw']).io);
  const h = harness();
  const code = await run(['receipts', 'verify'], h.io);
  assert.equal(code, 0);
  assert.doesNotMatch(h.lines.join('\n'), /malformed|could not be read/i);
});

test('confirm with no room argument prints usage and returns non-zero', async () => {
  isolate();
  const h = harness();
  const code = await run(['confirm'], h.io);
  assert.notEqual(code, 0);
  assert.match(h.lines.join('\n'), /Usage/);
});

test('confirm rejects an unsafe room name before any fetch', async () => {
  isolate();
  const originalFetch = global.fetch;
  let called = false;
  global.fetch = (async () => {
    called = true;
    throw new Error('confirm must not fetch for an unsafe room name');
  }) as unknown as typeof fetch;
  try {
    const h = harness();
    const code = await run(['confirm', '../etc'], h.io);
    assert.notEqual(code, 0);
    assert.equal(called, false);
  } finally {
    global.fetch = originalFetch;
  }
});

test('sign rejects an unsafe room name before ever prompting for a passphrase', async () => {
  isolate();
  await run(['keygen'], harness(['pw', 'pw']).io);
  let prompted = false;
  const io = {
    out: (s: string) => void s,
    prompt: async () => {
      prompted = true;
      return 'pw';
    },
  };
  const code = await run(['sign', '../etc', 'hi'], io);
  assert.notEqual(code, 0);
  assert.equal(prompted, false);
});

function fakeFetchFor(overrides: { github?: unknown; roomMessages?: unknown[] } = {}) {
  return (async (url: string | URL) => {
    const s = String(url);
    if (s.includes('api.github.com')) {
      return new Response(JSON.stringify(overrides.github ?? []), { status: 200 });
    }
    if (s.includes('flop.finance')) {
      return new Response('<html><body>Coming soon</body></html>', { status: 200 });
    }
    return new Response(JSON.stringify({ messages: overrides.roomMessages ?? [] }), { status: 200 });
  }) as unknown as typeof fetch;
}

test('watch exits 0 and reports no changes when nothing is new', async () => {
  isolate();
  const originalFetch = global.fetch;
  global.fetch = fakeFetchFor();
  try {
    const h = harness();
    const code = await run(['watch'], h.io);
    assert.equal(code, 0);
    assert.match(h.lines.join('\n'), /no changes/i);
  } finally {
    global.fetch = originalFetch;
  }
});

test('watch prints a Baselined line and stays quiet the first time it sees a GitHub repo', async () => {
  isolate();
  const originalFetch = global.fetch;
  global.fetch = fakeFetchFor({
    github: [
      {
        name: 'tclk',
        pushed_at: '2026-01-01T00:00:00Z',
        description: 'core',
        html_url: 'https://github.com/flop-labs/tclk',
      },
    ],
  });
  try {
    const h = harness();
    const code = await run(['watch'], h.io);
    assert.equal(code, 0);
    assert.match(h.lines.join('\n'), /baselined/i);
  } finally {
    global.fetch = originalFetch;
  }
});

test('watch exits 10 and prints official findings once a baseline exists and a new GitHub repo appears', async () => {
  isolate();
  const originalFetch = global.fetch;
  try {
    // First run: establishes the baseline with one known repo. Nothing is
    // "new" yet, so this must come back quiet.
    global.fetch = fakeFetchFor({
      github: [
        {
          name: 'tclk',
          pushed_at: '2026-01-01T00:00:00Z',
          description: 'core',
          html_url: 'https://github.com/flop-labs/tclk',
        },
      ],
    });
    const baseline = harness();
    const baselineCode = await run(['watch'], baseline.io);
    assert.equal(baselineCode, 0);

    // Second run: a genuinely new repo shows up alongside the known one.
    global.fetch = fakeFetchFor({
      github: [
        {
          name: 'tclk',
          pushed_at: '2026-01-01T00:00:00Z',
          description: 'core',
          html_url: 'https://github.com/flop-labs/tclk',
        },
        {
          name: 'testnet-faucet',
          pushed_at: '2026-05-01T00:00:00Z',
          description: 'the faucet',
          html_url: 'https://github.com/flop-labs/testnet-faucet',
        },
      ],
    });
    const h = harness();
    const code = await run(['watch'], h.io);
    assert.equal(code, 10);
    assert.match(h.lines.join('\n'), /testnet-faucet/);
  } finally {
    global.fetch = originalFetch;
  }
});

// --- mine -------------------------------------------------------------

function fakeExportFetchFor(byRoom: Record<string, string>) {
  return (async (url: string | URL) => {
    const s = String(url);
    for (const [room, body] of Object.entries(byRoom)) {
      if (s.includes(`/r/${room}/export`)) {
        return new Response(body, { status: 200 });
      }
    }
    // Any room not given an explicit body (i.e. the other defaults) is an
    // empty room — a legitimate, common case that must not fail the run.
    return new Response('', { status: 200 });
  }) as unknown as typeof fetch;
}

test('mine refuses to run before an identity exists, and names --did and TECHNOCORE_DID', async () => {
  isolate();
  const h = harness();
  const code = await run(['mine'], h.io);
  assert.notEqual(code, 0);
  const out = h.lines.join('\n');
  assert.match(out, /No identity/i);
  assert.match(out, /--did/);
  assert.match(out, /TECHNOCORE_DID/);
});

test('mine --did works with no key file present and produces the evidence file', async () => {
  isolate();
  const { did } = generateIdentity();
  const originalFetch = global.fetch;
  global.fetch = fakeExportFetchFor({});
  try {
    assert.equal(readStoredDid(), undefined);
    const outPath = join(mkdtempSync(join(tmpdir(), 'attest-out-')), 'evidence.json');
    const h = harness();
    const code = await run(['mine', '--did', did, '--out', outPath], h.io);
    assert.equal(code, 0);
    assert.equal(existsSync(outPath), true);
    const written = JSON.parse(readFileSync(outPath, 'utf8'));
    assert.equal(written.did, did);
  } finally {
    global.fetch = originalFetch;
  }
});

test('TECHNOCORE_DID is used when --did is absent; --did wins when both are set', async () => {
  isolate();
  const { did: envDid } = generateIdentity();
  const { did: flagDid } = generateIdentity();
  const originalFetch = global.fetch;
  global.fetch = fakeExportFetchFor({});
  try {
    process.env.TECHNOCORE_DID = envDid;
    const outPath1 = join(mkdtempSync(join(tmpdir(), 'attest-out-')), 'evidence.json');
    const code1 = await run(['mine', '--out', outPath1], harness().io);
    assert.equal(code1, 0);
    assert.equal(JSON.parse(readFileSync(outPath1, 'utf8')).did, envDid);

    const outPath2 = join(mkdtempSync(join(tmpdir(), 'attest-out-')), 'evidence.json');
    const code2 = await run(['mine', '--did', flagDid, '--out', outPath2], harness().io);
    assert.equal(code2, 0);
    assert.equal(JSON.parse(readFileSync(outPath2, 'utf8')).did, flagDid);
  } finally {
    global.fetch = originalFetch;
    delete process.env.TECHNOCORE_DID;
  }
});

test('mine falls back to the local keystore when neither --did nor TECHNOCORE_DID is supplied', async () => {
  isolate();
  await run(['keygen'], harness(['pw', 'pw']).io);
  const did = readStoredDid()!;
  const originalFetch = global.fetch;
  global.fetch = fakeExportFetchFor({});
  try {
    delete process.env.TECHNOCORE_DID;
    const outPath = join(mkdtempSync(join(tmpdir(), 'attest-out-')), 'evidence.json');
    const code = await run(['mine', '--out', outPath], harness().io);
    assert.equal(code, 0);
    assert.equal(JSON.parse(readFileSync(outPath, 'utf8')).did, did);
  } finally {
    global.fetch = originalFetch;
  }
});

for (const bad of ['did:key:zNOTVALID', 'not-a-did', '']) {
  test(`mine --did rejects a malformed DID (${JSON.stringify(bad)}) without writing a file`, async () => {
    isolate();
    const outDir = mkdtempSync(join(tmpdir(), 'attest-out-'));
    const outPath = join(outDir, 'evidence.json');
    const h = harness();
    const code = await run(['mine', '--did', bad, '--out', outPath], h.io);
    assert.notEqual(code, 0);
    assert.equal(existsSync(outPath), false);
    const out = h.lines.join('\n');
    assert.match(out, /did|DID/);
  });
}

test('mine writes the evidence file and exits 0 when every stored signature verifies', async () => {
  isolate();
  await run(['keygen'], harness(['pw', 'pw']).io);
  const did = readStoredDid()!;
  const { privateKey } = loadIdentity('pw');
  const sig = signPayload(privateKey, 'technocore', 5, 'hello there');
  const body =
    JSON.stringify({ seq: 1, ts: 't1', from: '~someone-else', text: 'noise' }) +
    '\n' +
    JSON.stringify({ seq: 2, ts: 't2', from: did, text: 'hello there', nonce: 5, sig }) +
    '\n';
  const originalFetch = global.fetch;
  global.fetch = fakeExportFetchFor({ technocore: body });
  try {
    const outPath = join(mkdtempSync(join(tmpdir(), 'attest-out-')), 'evidence.json');
    const h = harness();
    const code = await run(['mine', '--out', outPath], h.io);
    assert.equal(code, 0);
    assert.equal(existsSync(outPath), true);
    const written = JSON.parse(readFileSync(outPath, 'utf8'));
    assert.equal(written.v, 1);
    assert.equal(written.did, did);
    const technocore = written.rooms.find((r: { room: string }) => r.room === 'technocore');
    assert.equal(technocore.mine.length, 1);
    assert.equal(technocore.mine[0].sig, sig);
    // pretty-printed with a trailing newline, so diffs stay readable
    const raw = readFileSync(outPath, 'utf8');
    assert.match(raw, /\n$/);
    assert.match(raw, /\n {2}"v": 1/);
    assert.match(h.lines.join('\n'), /1\/1|valid/i);
  } finally {
    global.fetch = originalFetch;
  }
});

test('mine exits non-zero when a stored signature fails verification', async () => {
  isolate();
  await run(['keygen'], harness(['pw', 'pw']).io);
  const did = readStoredDid()!;
  const { privateKey } = loadIdentity('pw');
  const sig = signPayload(privateKey, 'technocore', 5, 'hello there');
  // The server now serves different text under the same nonce/sig — as if
  // the room (or a captured copy of it) had been tampered with.
  const body =
    JSON.stringify({ seq: 2, ts: 't2', from: did, text: 'TAMPERED', nonce: 5, sig }) + '\n';
  const originalFetch = global.fetch;
  global.fetch = fakeExportFetchFor({ technocore: body });
  try {
    const outPath = join(mkdtempSync(join(tmpdir(), 'attest-out-')), 'evidence.json');
    const h = harness();
    const code = await run(['mine', '--out', outPath], h.io);
    assert.notEqual(code, 0);
    assert.equal(existsSync(outPath), true);
  } finally {
    global.fetch = originalFetch;
  }
});

test('mine captures every room the user has a receipt for, in addition to the defaults', async () => {
  isolate();
  await run(['keygen'], harness(['pw', 'pw']).io);
  await run(['sign', 'my-custom-room', 'hi'], harness(['pw']).io);
  const originalFetch = global.fetch;
  const seenRooms: string[] = [];
  global.fetch = (async (url: string | URL) => {
    const s = String(url);
    const m = s.match(/\/r\/([^/]+)\/export/);
    if (m) seenRooms.push(m[1]);
    return new Response('', { status: 200 });
  }) as unknown as typeof fetch;
  try {
    const outPath = join(mkdtempSync(join(tmpdir(), 'attest-out-')), 'evidence.json');
    const h = harness();
    await run(['mine', '--out', outPath], h.io);
    assert.ok(seenRooms.includes('my-custom-room'));
    assert.ok(seenRooms.includes('technocore'));
    assert.ok(seenRooms.includes('flop_labs'));
    assert.ok(seenRooms.includes('technocore-genesis'));
  } finally {
    global.fetch = originalFetch;
  }
});

test('watch labels chat matches as unverified chatter, once a room has a baseline', async () => {
  isolate();
  const originalFetch = global.fetch;
  try {
    // First run: baselines the room. The message is already present but
    // must not be reported yet — there is no "since" to compare against.
    global.fetch = fakeFetchFor({
      roomMessages: [{ seq: 1, ts: 't', from: '~a', text: 'faucet is live!' }],
    });
    const baseline = harness();
    const baselineCode = await run(['watch'], baseline.io);
    assert.equal(baselineCode, 0);

    // Second run: the same message is still being served, and the room now
    // has a baseline, so it is reported as unverified chat chatter.
    const h = harness();
    const code = await run(['watch'], h.io);
    assert.equal(code, 10);
    const out = h.lines.join('\n');
    assert.match(out, /unverified/i);
    assert.match(out, /faucet is live/);
  } finally {
    global.fetch = originalFetch;
  }
});
