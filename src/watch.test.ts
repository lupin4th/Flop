import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  extractText,
  textHash,
  loadWatchState,
  saveWatchState,
  checkGitHub,
  checkPages,
  checkRooms,
  runWatch,
  type WatchState,
  type Finding,
} from './watch.js';
import type { RoomMessage } from './client.js';

function isolate() {
  process.env.TECHNOCORE_ATTEST_HOME = mkdtempSync(join(tmpdir(), 'attest-'));
}

function freshState(): WatchState {
  return { v: 1, repos: {}, pages: {}, rooms: {}, last_run: new Date(0).toISOString() };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

// --- extractText / textHash ---------------------------------------------

test('extractText removes script tags AND their contents', () => {
  const html = '<html><body><script>var x = "<b>not visible</b>";</script>hello</body></html>';
  const text = extractText(html);
  assert.equal(/not visible/.test(text), false);
  assert.equal(/var x/.test(text), false);
  assert.match(text, /hello/);
});

test('extractText removes style tags AND their contents', () => {
  const html = '<html><head><style>body { color: red; } /* secret-token */</style></head><body>hi</body></html>';
  const text = extractText(html);
  assert.equal(/secret-token/.test(text), false);
  assert.equal(/color/.test(text), false);
  assert.match(text, /hi/);
});

test('extractText collapses whitespace and trims', () => {
  const html = '<div>  a   \n\n  b  </div>';
  assert.equal(extractText(html), 'a b');
});

test('two HTML documents differing only inside a style block hash identically', () => {
  const a = '<html><head><style>.x{color:#111}</style></head><body>Same text</body></html>';
  const b = '<html><head><style>.x{color:#222}</style></head><body>Same text</body></html>';
  assert.equal(textHash(a), textHash(b));
});

test('HTML documents differing in visible text hash differently', () => {
  const a = '<html><body>Announcement A</body></html>';
  const b = '<html><body>Announcement B</body></html>';
  assert.notEqual(textHash(a), textHash(b));
});

// --- state round-trip -----------------------------------------------------

test('watch state round-trips through save and load', () => {
  isolate();
  const state: WatchState = {
    v: 1,
    repos: { tclk: '2026-01-01T00:00:00Z' },
    pages: { 'https://flop.finance/': 'deadbeef' },
    rooms: { technocore: 42 },
    last_run: '2026-01-01T00:00:00Z',
  };
  saveWatchState(state);
  const loaded = loadWatchState();
  assert.deepEqual(loaded, state);
});

test('loadWatchState returns a fresh empty state when nothing has been saved', () => {
  isolate();
  const state = loadWatchState();
  assert.equal(state.v, 1);
  assert.deepEqual(state.repos, {});
  assert.deepEqual(state.pages, {});
  assert.deepEqual(state.rooms, {});
});

// --- checkGitHub ------------------------------------------------------------

test('checkGitHub reports a brand-new repo as an official finding', async () => {
  isolate();
  const state = freshState();
  state.repos['tclk'] = '2026-01-01T00:00:00Z';
  const fetchImpl = (async () =>
    jsonResponse([
      { name: 'tclk', pushed_at: '2026-01-01T00:00:00Z', description: 'old', html_url: 'https://github.com/flop-labs/tclk' },
      { name: 'testnet-faucet', pushed_at: '2026-05-01T00:00:00Z', description: 'the faucet', html_url: 'https://github.com/flop-labs/testnet-faucet' },
    ])) as unknown as typeof fetch;
  const findings = await checkGitHub(state, { fetchImpl });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].source, 'github');
  assert.equal(findings[0].trust, 'official');
  assert.match(findings[0].summary, /testnet-faucet/);
  assert.equal(state.repos['testnet-faucet'], '2026-05-01T00:00:00Z');
});

test('checkGitHub reports nothing when the repo list is unchanged', async () => {
  isolate();
  const state = freshState();
  state.repos['tclk'] = '2026-01-01T00:00:00Z';
  const fetchImpl = (async () =>
    jsonResponse([
      { name: 'tclk', pushed_at: '2026-01-01T00:00:00Z', description: 'old', html_url: 'https://github.com/flop-labs/tclk' },
    ])) as unknown as typeof fetch;
  const findings = await checkGitHub(state, { fetchImpl });
  assert.equal(findings.length, 0);
});

test('checkGitHub reports a changed pushed_at on a known repo', async () => {
  isolate();
  const state = freshState();
  state.repos['tclk'] = '2026-01-01T00:00:00Z';
  const fetchImpl = (async () =>
    jsonResponse([
      { name: 'tclk', pushed_at: '2026-06-01T00:00:00Z', description: 'old', html_url: 'https://github.com/flop-labs/tclk' },
    ])) as unknown as typeof fetch;
  const findings = await checkGitHub(state, { fetchImpl });
  assert.equal(findings.length, 1);
  assert.match(findings[0].summary, /tclk/);
  assert.equal(state.repos['tclk'], '2026-06-01T00:00:00Z');
});

// --- checkPages -------------------------------------------------------------

test('checkPages stores hashes and emits no findings on the first run', async () => {
  isolate();
  const state = freshState();
  const fetchImpl = (async () => new Response('<html><body>Coming soon</body></html>')) as unknown as typeof fetch;
  const findings = await checkPages(state, { fetchImpl });
  assert.equal(findings.length, 0);
  assert.equal(Object.keys(state.pages).length, 4);
});

test('checkPages emits an official finding when text changes on a later run', async () => {
  isolate();
  const state = freshState();
  let call = 0;
  const fetchImpl = (async () => {
    call++;
    const changed = call > 4; // second pass over the same 4 pages
    return new Response(`<html><body>${changed ? 'Testnet is live' : 'Coming soon'}</body></html>`);
  }) as unknown as typeof fetch;
  const first = await checkPages(state, { fetchImpl });
  assert.equal(first.length, 0);
  const second = await checkPages(state, { fetchImpl });
  assert.equal(second.length, 4);
  for (const f of second) {
    assert.equal(f.source, 'web');
    assert.equal(f.trust, 'official');
  }
});

// --- checkRooms ---------------------------------------------------------

function fakeRoomFetch(byRoom: Record<string, RoomMessage[]>): typeof fetch {
  return (async (url: string | URL) => {
    const u = new URL(String(url));
    const room = u.pathname.split('/').filter(Boolean).pop() ?? '';
    return jsonResponse({ messages: byRoom[room] ?? [] });
  }) as unknown as typeof fetch;
}

test('checkRooms labels every chat finding unverified', async () => {
  isolate();
  const state = freshState();
  const fetchImpl = fakeRoomFetch({
    technocore: [{ seq: 1, ts: 't', from: '~a', text: 'the faucet is opening soon' }],
  });
  const findings = await checkRooms(state, { fetchImpl });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].trust, 'unverified');
  assert.equal(findings[0].source, 'chat');
});

test('checkRooms emits nothing for a room with no keyword matches', async () => {
  isolate();
  const state = freshState();
  const fetchImpl = fakeRoomFetch({
    technocore: [{ seq: 1, ts: 't', from: '~a', text: 'just saying hi' }],
  });
  const findings = await checkRooms(state, { fetchImpl });
  assert.equal(findings.length, 0);
});

test('checkRooms caps chat findings at 5 per run and reports the suppressed count', async () => {
  isolate();
  const state = freshState();
  const messages: RoomMessage[] = Array.from({ length: 7 }, (_, i) => ({
    seq: i + 1,
    ts: 't',
    from: '~a',
    text: `faucet drip number ${i}`,
  }));
  const fetchImpl = fakeRoomFetch({ technocore: messages });
  const findings = await checkRooms(state, { fetchImpl });
  const chatFindings = findings.filter((f: Finding) => /faucet drip/.test(f.summary));
  assert.equal(chatFindings.length, 5);
  const suppressionNote = findings.find((f: Finding) => /suppressed/i.test(f.summary));
  assert.ok(suppressionNote, 'expected a suppression note');
  assert.match(suppressionNote!.summary, /2/);
});

// --- runWatch -------------------------------------------------------------

test('runWatch keeps checking pages and rooms even when the GitHub fetch throws', async () => {
  isolate();
  const fetchImpl = (async (url: string | URL) => {
    const s = String(url);
    if (s.includes('api.github.com')) throw new Error('network down');
    if (s.includes('flop.finance')) return new Response('<html><body>hi</body></html>');
    return jsonResponse({ messages: [] });
  }) as unknown as typeof fetch;
  const { findings, state } = await runWatch({ fetchImpl });
  assert.equal(findings.length, 0);
  assert.equal(Object.keys(state.pages).length, 4);
});

test('runWatch saves state exactly once at the end', async () => {
  isolate();
  const fetchImpl = (async (url: string | URL) => {
    const s = String(url);
    if (s.includes('api.github.com')) return jsonResponse([]);
    if (s.includes('flop.finance')) return new Response('<html><body>hi</body></html>');
    return jsonResponse({ messages: [] });
  }) as unknown as typeof fetch;
  const { state } = await runWatch({ fetchImpl });
  const reloaded = loadWatchState();
  assert.deepEqual(reloaded, state);
});
