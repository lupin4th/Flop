import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from './cli.js';
import { receiptsPath } from './paths.js';

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
