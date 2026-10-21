import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  extractText,
  extractBlocks,
  textHash,
  loadWatchState,
  saveWatchState,
  checkGitHub,
  checkPages,
  checkRooms,
  runWatch,
  headline,
  diffSentences,
  type WatchState,
  type Finding,
} from './watch.js';
import type { RoomMessage } from './client.js';

function isolate() {
  process.env.TECHNOCORE_ATTEST_HOME = mkdtempSync(join(tmpdir(), 'attest-'));
}

function freshState(): WatchState {
  return { v: 1, repos: {}, pages: {}, page_text: {}, rooms: {}, last_run: new Date(0).toISOString() };
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
    page_text: { 'https://flop.finance/': 'Coming soon' },
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

test('checkGitHub emits no findings on the very first run (empty state), but records every repo', async () => {
  isolate();
  const state = freshState();
  const fetchImpl = (async () =>
    jsonResponse([
      { name: 'tclk', pushed_at: '2026-01-01T00:00:00Z', description: 'core', html_url: 'https://github.com/flop-labs/tclk' },
      { name: '.github', pushed_at: '2026-01-01T00:00:00Z', description: null, html_url: 'https://github.com/flop-labs/.github' },
      { name: 'yellowpaper', pushed_at: '2026-01-01T00:00:00Z', description: 'the paper', html_url: 'https://github.com/flop-labs/yellowpaper' },
    ])) as unknown as typeof fetch;
  const findings = await checkGitHub(state, { fetchImpl });
  assert.equal(findings.length, 0);
  assert.equal(state.repos['tclk'], '2026-01-01T00:00:00Z');
  assert.equal(state.repos['.github'], '2026-01-01T00:00:00Z');
  assert.equal(state.repos['yellowpaper'], '2026-01-01T00:00:00Z');
});

test('checkGitHub emits exactly one finding on the run after a baseline, when one repo is added', async () => {
  isolate();
  const state = freshState();
  const firstFetch = (async () =>
    jsonResponse([
      { name: 'tclk', pushed_at: '2026-01-01T00:00:00Z', description: 'core', html_url: 'https://github.com/flop-labs/tclk' },
    ])) as unknown as typeof fetch;
  const firstFindings = await checkGitHub(state, { fetchImpl: firstFetch });
  assert.equal(firstFindings.length, 0); // baseline run

  const secondFetch = (async () =>
    jsonResponse([
      { name: 'tclk', pushed_at: '2026-01-01T00:00:00Z', description: 'core', html_url: 'https://github.com/flop-labs/tclk' },
      { name: 'testnet-faucet', pushed_at: '2026-05-01T00:00:00Z', description: 'the faucet', html_url: 'https://github.com/flop-labs/testnet-faucet' },
    ])) as unknown as typeof fetch;
  const secondFindings = await checkGitHub(state, { fetchImpl: secondFetch });
  assert.equal(secondFindings.length, 1);
  assert.match(secondFindings[0].summary, /testnet-faucet/);
});

// --- checkGitHub: commit detail on push ------------------------------------

function ghCommit(sha: string, message: string) {
  return { sha, commit: { message } };
}

/**
 * Routes by URL: the org-repos list vs. a per-repo commits page. Tracks
 * every URL requested so tests can assert exactly how many requests a run
 * made — the whole point of the rate-limit behaviour under test.
 */
function githubFetch(opts: {
  repos: Array<{ name: string; pushed_at: string; description: string | null; html_url: string }>;
  commitsByRepo?: Record<string, unknown>;
  calls: string[];
}): typeof fetch {
  return (async (url: string | URL) => {
    const s = String(url);
    opts.calls.push(s);
    if (s.includes('/repos/flop-labs/') && s.includes('/commits')) {
      const name = s.split('/repos/flop-labs/')[1].split('/commits')[0];
      const commits = opts.commitsByRepo?.[name];
      if (commits === undefined) return jsonResponse({ not: 'found' }, 404);
      return jsonResponse(commits);
    }
    return jsonResponse(opts.repos);
  }) as unknown as typeof fetch;
}

test('a changed pushed_at with a known prior sha reports only the commits above it', async () => {
  isolate();
  const state = freshState();
  state.repos['tclk'] = '2026-01-01T00:00:00Z';
  state.repo_commits = { tclk: 'sha-old' };
  const calls: string[] = [];
  const fetchImpl = githubFetch({
    repos: [{ name: 'tclk', pushed_at: '2026-06-01T00:00:00Z', description: null, html_url: 'https://github.com/flop-labs/tclk' }],
    commitsByRepo: {
      tclk: [
        ghCommit('sha-new-2', 'bump alpha warning\n\nlonger body here'),
        ghCommit('sha-new-1', 'wire up settlement rail'),
        ghCommit('sha-old', 'previous commit, already seen'),
      ],
    },
    calls,
  });
  const findings = await checkGitHub(state, { fetchImpl });
  assert.equal(findings.length, 1);
  assert.match(findings[0].summary, /tclk/);
  assert.match(findings[0].summary, /wire up settlement rail/);
  assert.match(findings[0].summary, /bump alpha warning/);
  assert.equal(/previous commit/.test(findings[0].summary), false);
  assert.equal(state.repo_commits!['tclk'], 'sha-new-2');
});

test('a changed pushed_at whose stored sha is absent from the returned page reports just the newest commit', async () => {
  isolate();
  const state = freshState();
  state.repos['tclk'] = '2026-01-01T00:00:00Z';
  state.repo_commits = { tclk: 'sha-long-gone' };
  const calls: string[] = [];
  const fetchImpl = githubFetch({
    repos: [{ name: 'tclk', pushed_at: '2026-06-01T00:00:00Z', description: null, html_url: 'https://github.com/flop-labs/tclk' }],
    commitsByRepo: {
      tclk: [
        ghCommit('sha-new', 'force-pushed history'),
        ghCommit('sha-other', 'unrelated older commit'),
      ],
    },
    calls,
  });
  const findings = await checkGitHub(state, { fetchImpl });
  assert.equal(findings.length, 1);
  assert.match(findings[0].summary, /force-pushed history/);
  assert.equal(/unrelated older commit/.test(findings[0].summary), false);
  assert.equal(state.repo_commits!['tclk'], 'sha-new');
});

test('a repo with no stored sha records the newest sha and reports the push without commit detail', async () => {
  isolate();
  const state = freshState();
  state.repos['tclk'] = '2026-01-01T00:00:00Z';
  // No state.repo_commits at all yet — matches the shape written by every
  // version of this tool before this feature existed.
  const calls: string[] = [];
  const fetchImpl = githubFetch({
    repos: [{ name: 'tclk', pushed_at: '2026-06-01T00:00:00Z', description: null, html_url: 'https://github.com/flop-labs/tclk' }],
    commitsByRepo: {
      tclk: [ghCommit('sha-1', 'some commit subject')],
    },
    calls,
  });
  const findings = await checkGitHub(state, { fetchImpl });
  assert.equal(findings.length, 1);
  assert.match(findings[0].summary, /Repo pushed: tclk/);
  assert.equal(/some commit subject/.test(findings[0].summary), false);
  assert.equal(state.repo_commits!['tclk'], 'sha-1');
});

test('an unchanged pushed_at issues no commits request', async () => {
  isolate();
  const state = freshState();
  state.repos['tclk'] = '2026-01-01T00:00:00Z';
  state.repo_commits = { tclk: 'sha-old' };
  const calls: string[] = [];
  const fetchImpl = githubFetch({
    repos: [{ name: 'tclk', pushed_at: '2026-01-01T00:00:00Z', description: null, html_url: 'https://github.com/flop-labs/tclk' }],
    calls,
  });
  const findings = await checkGitHub(state, { fetchImpl });
  assert.equal(findings.length, 0);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /orgs\/flop-labs\/repos/);
});

test('a failing commits fetch still yields the plain push finding and does not throw', async () => {
  isolate();
  const state = freshState();
  state.repos['tclk'] = '2026-01-01T00:00:00Z';
  state.repo_commits = { tclk: 'sha-old' };
  const calls: string[] = [];
  const fetchImpl = githubFetch({
    repos: [{ name: 'tclk', pushed_at: '2026-06-01T00:00:00Z', description: null, html_url: 'https://github.com/flop-labs/tclk' }],
    // no commitsByRepo entry for tclk -> the fake returns a 404
    calls,
  });
  const findings = await checkGitHub(state, { fetchImpl });
  assert.equal(findings.length, 1);
  assert.match(findings[0].summary, /Repo pushed: tclk/);
});

test('more than five new commits are capped with a remainder count', async () => {
  isolate();
  const state = freshState();
  state.repos['tclk'] = '2026-01-01T00:00:00Z';
  state.repo_commits = { tclk: 'sha-base' };
  const calls: string[] = [];
  const newCommits = Array.from({ length: 7 }, (_, i) => ghCommit(`sha-${i}`, `commit subject ${i}`));
  const fetchImpl = githubFetch({
    repos: [{ name: 'tclk', pushed_at: '2026-06-01T00:00:00Z', description: null, html_url: 'https://github.com/flop-labs/tclk' }],
    commitsByRepo: {
      tclk: [...newCommits, ghCommit('sha-base', 'base commit')],
    },
    calls,
  });
  const findings = await checkGitHub(state, { fetchImpl });
  assert.equal(findings.length, 1);
  assert.match(findings[0].summary, /7 new commit/);
  assert.match(findings[0].summary, /2 more/);
});

test('checkGitHub does not throw when state has no repo_commits at all (currently committed shape)', async () => {
  isolate();
  const state: WatchState = { v: 1, repos: { tclk: '2026-01-01T00:00:00Z' }, pages: {}, page_text: {}, rooms: {}, last_run: new Date(0).toISOString() };
  delete (state as { repo_commits?: unknown }).repo_commits;
  const calls: string[] = [];
  const fetchImpl = githubFetch({
    repos: [{ name: 'tclk', pushed_at: '2026-06-01T00:00:00Z', description: null, html_url: 'https://github.com/flop-labs/tclk' }],
    commitsByRepo: { tclk: [ghCommit('sha-1', 'a commit')] },
    calls,
  });
  await assert.doesNotReject(checkGitHub(state, { fetchImpl }));
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

/** A state whose rooms already have a baseline (as if a prior run happened). */
function stateWithRoomBaseline(rooms: Record<string, number>): WatchState {
  const state = freshState();
  state.rooms = { ...rooms };
  return state;
}

test('checkRooms emits no chat findings on a room\'s first run, but records its seq', async () => {
  isolate();
  const state = freshState();
  const fetchImpl = fakeRoomFetch({
    technocore: [{ seq: 5, ts: 't', from: '~a', text: 'the faucet is opening soon' }],
  });
  const findings = await checkRooms(state, { fetchImpl });
  assert.equal(findings.length, 0);
  assert.equal(state.rooms['technocore'], 5);
});

test('checkRooms labels every chat finding unverified, once a room has a baseline', async () => {
  isolate();
  const state = stateWithRoomBaseline({ technocore: 0 });
  const fetchImpl = fakeRoomFetch({
    technocore: [{ seq: 1, ts: 't', from: '~a', text: 'the faucet is opening soon' }],
  });
  const findings = await checkRooms(state, { fetchImpl });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].trust, 'unverified');
  assert.equal(findings[0].source, 'chat');
});

test('checkRooms emits nothing for an already-baselined room with no keyword matches', async () => {
  isolate();
  const state = stateWithRoomBaseline({ technocore: 0 });
  const fetchImpl = fakeRoomFetch({
    technocore: [{ seq: 1, ts: 't', from: '~a', text: 'just saying hi' }],
  });
  const findings = await checkRooms(state, { fetchImpl });
  assert.equal(findings.length, 0);
});

test('a room\'s first run does not suppress findings for an already-baselined room', async () => {
  isolate();
  const state = stateWithRoomBaseline({ technocore: 0 });
  const fetchImpl = fakeRoomFetch({
    technocore: [{ seq: 1, ts: 't', from: '~a', text: 'the faucet is open' }],
    flop_labs: [{ seq: 1, ts: 't', from: '~a', text: 'the faucet is open' }],
  });
  const findings = await checkRooms(state, { fetchImpl });
  // technocore already had a baseline and should report; flop_labs is on
  // its first run and should stay silent, independently of technocore.
  assert.equal(findings.length, 1);
  assert.match(findings[0].detail, /^technocore#/);
  assert.equal(state.rooms['flop_labs'], 1);
});

test('checkRooms caps chat findings at 5 per run and reports the suppressed count', async () => {
  isolate();
  const state = stateWithRoomBaseline({ technocore: 0 });
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

// --- keyword precision ------------------------------------------------

function oneMessageFinding(text: string): Promise<Finding[]> {
  const state = stateWithRoomBaseline({ technocore: 0 });
  const fetchImpl = fakeRoomFetch({
    technocore: [{ seq: 1, ts: 't', from: '~a', text }],
  });
  return checkRooms(state, { fetchImpl });
}

test('checkRooms does not match generic agent chatter containing "claiming"', async () => {
  isolate();
  const findings = await oneMessageFinding(
    'My agent is tracking it without automatically claiming the task.',
  );
  assert.equal(findings.length, 0);
});

test('checkRooms does not match a bare testnet-presence heartbeat', async () => {
  isolate();
  const findings = await oneMessageFinding('[FLOP-8DCBA7] testnet node · cap=poui_verifier_v1 · t=6aa8009d');
  assert.equal(findings.length, 0);
});

test('checkRooms does not match "maintaining technocore testnet presence"', async () => {
  isolate();
  const findings = await oneMessageFinding('maintaining technocore testnet presence');
  assert.equal(findings.length, 0);
});

test('checkRooms matches "the faucet is open"', async () => {
  isolate();
  const findings = await oneMessageFinding('the faucet is open');
  assert.equal(findings.length, 1);
});

test('checkRooms matches a bare mention of "faucet"', async () => {
  isolate();
  const findings = await oneMessageFinding('does anyone know when the faucet drops');
  assert.equal(findings.length, 1);
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

test('runWatch reports which sources were baselined on a first run, and none on a second', async () => {
  isolate();
  const fetchImpl = (async (url: string | URL) => {
    const s = String(url);
    if (s.includes('api.github.com')) {
      return jsonResponse([
        { name: 'tclk', pushed_at: '2026-01-01T00:00:00Z', description: 'core', html_url: 'https://github.com/flop-labs/tclk' },
      ]);
    }
    if (s.includes('flop.finance')) return new Response('<html><body>hi</body></html>');
    return jsonResponse({ messages: [] });
  }) as unknown as typeof fetch;

  const first = await runWatch({ fetchImpl });
  assert.equal(first.findings.length, 0);
  assert.equal(first.baselined.github, true);
  assert.equal(first.baselined.repoCount, 1);
  assert.deepEqual(first.baselined.rooms.sort(), ['flop_labs', 'technocore', 'technocore-genesis']);

  const second = await runWatch({ fetchImpl });
  assert.equal(second.baselined.github, false);
  assert.deepEqual(second.baselined.rooms, []);
});

// --- headline ---------------------------------------------------------------

function official(kind: Finding['kind'], title: string): Finding {
  return { source: kind === 'page_change' ? 'web' : 'github', trust: 'official', kind, title, summary: `summary of ${title}`, detail: 'd', at: 't' };
}
function chat(): Finding {
  return { source: 'chat', trust: 'unverified', kind: 'chat', summary: 'Keyword match', detail: 'r#1', at: 't' };
}

test('headline is null when there are no findings or only chat findings', () => {
  assert.equal(headline([]), null);
  assert.equal(headline([chat(), chat()]), null);
});

test('headline prefers a new repo over a page change over a push, whatever the input order', () => {
  const push = official('repo_push', 'tclk pushed: wire up settlement rail');
  const page = official('page_change', 'flop.finance changed: /teaser/');
  const repo = official('new_repo', 'NEW REPO technocore-close-call-challenge');
  assert.equal(headline([push, page, repo]), 'NEW REPO technocore-close-call-challenge (+2 more)');
  assert.equal(headline([push, page]), 'flop.finance changed: /teaser/ (+1 more)');
  assert.equal(headline([push]), 'tclk pushed: wire up settlement rail');
});

test('headline ignores chat findings in both the choice and the count', () => {
  const repo = official('new_repo', 'NEW REPO x');
  assert.equal(headline([chat(), repo, chat()]), 'NEW REPO x');
});

test('headline stays under about 100 characters for a long repo name, keeping the (+N more) suffix', () => {
  const long = official('new_repo', 'NEW REPO ' + 'a'.repeat(300));
  const h = headline([long, official('repo_push', 'x pushed'), official('repo_push', 'y pushed')]);
  assert.ok(h !== null);
  assert.ok(h.length <= 100, `length ${h.length}`);
  assert.ok(h.endsWith(' (+2 more)'));
  assert.ok(h.startsWith('NEW REPO aaa'));
});

test('headline collapses whitespace so a title is always a single line', () => {
  const h = headline([official('repo_push', 'tclk pushed: line one\nline two')]);
  assert.equal(h, 'tclk pushed: line one line two');
});

test('headline falls back to the summary for an official finding with no kind', () => {
  const f: Finding = { source: 'github', trust: 'official', summary: 'Something odd', detail: 'd', at: 't' };
  assert.equal(headline([f]), 'Something odd');
});

test('checkGitHub tags findings with kind and a short title', async () => {
  isolate();
  const state = freshState();
  state.repos = { tclk: '2026-01-01T00:00:00Z' };
  state.repo_commits = { tclk: 'sha-0' };
  const fetchImpl = githubFetch({
    repos: [
      { name: 'tclk', pushed_at: '2026-06-01T00:00:00Z', description: null, html_url: 'https://github.com/flop-labs/tclk' },
      { name: 'technocore-close-call-challenge', pushed_at: '2026-06-01T00:00:00Z', description: 'contest', html_url: 'https://github.com/flop-labs/technocore-close-call-challenge' },
    ],
    commitsByRepo: { tclk: [ghCommit('sha-1', 'wire up settlement rail\n\nbody'), ghCommit('sha-0', 'older')] },
    calls: [],
  });
  const findings = await checkGitHub(state, { fetchImpl });
  const repo = findings.find((f) => f.kind === 'new_repo');
  const push = findings.find((f) => f.kind === 'repo_push');
  assert.equal(repo?.title, 'NEW REPO technocore-close-call-challenge');
  assert.equal(push?.title, 'tclk pushed: wire up settlement rail');
});

test('checkRooms tags every chat finding with kind chat', async () => {
  isolate();
  const state = stateWithRoomBaseline({ technocore: 1, flop_labs: 1, 'technocore-genesis': 1 });
  const fetchImpl = fakeRoomFetch({ technocore: [{ seq: 2, ts: 't', from: '~a', text: 'faucet is live' }] });
  const findings = await checkRooms(state, { fetchImpl });
  assert.ok(findings.length > 0);
  for (const f of findings) assert.equal(f.kind, 'chat');
});

// --- page diffs ---------------------------------------------------------------

const PAGE_URLS = [
  'https://flop.finance/',
  'https://flop.finance/teaser/',
  'https://flop.finance/intro/',
  'https://flop.finance/intro/yellowpaper/',
];

/** Serves `byUrl[url]` as the body of each page, defaulting to a constant. */
function pageFetch(byUrl: Record<string, string>): typeof fetch {
  return (async (url: string | URL) => {
    const body = byUrl[String(url)] ?? 'Stable page.';
    return new Response(`<html><body>${body}</body></html>`);
  }) as unknown as typeof fetch;
}

const TEASER = 'https://flop.finance/teaser/';

test('a changed page reports the removed and added sentences with - and +', async () => {
  isolate();
  const state = freshState();
  await checkPages(state, {
    fetchImpl: pageFetch({ [TEASER]: 'Welcome to FLOP. every 3 $FLOP spent on inference unlocks 1 airdropped $FLOP. Join us.' }),
  });
  const findings = await checkPages(state, {
    fetchImpl: pageFetch({ [TEASER]: 'Welcome to FLOP. The unlock schedule is not set. Join us.' }),
  });
  assert.equal(findings.length, 1);
  const f = findings[0];
  assert.equal(f.kind, 'page_change');
  assert.equal(f.title, 'flop.finance changed: /teaser/');
  assert.match(f.summary, /^- every 3 \$FLOP spent on inference unlocks 1 airdropped \$FLOP\.$/m);
  assert.match(f.summary, /^\+ The unlock schedule is not set\.$/m);
  assert.ok(!f.summary.includes('Join us'), 'unchanged sentences are not listed');
  assert.ok(f.summary.startsWith(`Page content changed: ${TEASER}`));
  // Stored text is the newline-joined blocks (see extractBlocks).
  assert.equal(state.page_text[TEASER], 'Welcome to FLOP.\nThe unlock schedule is not set.\nJoin us.');
});

test('checkPages stores page text on the first run', async () => {
  isolate();
  const state = freshState();
  await checkPages(state, { fetchImpl: pageFetch({}) });
  for (const u of PAGE_URLS) assert.equal(state.page_text[u], 'Stable page.');
});

test('a page diff is capped at eight sentences, each truncated, and reports the omitted count', () => {
  const oldText = Array.from({ length: 12 }, (_, i) => `Old sentence number ${i}.`).join(' ');
  const longNew = 'N'.repeat(500) + '.';
  const newText = [longNew, ...Array.from({ length: 11 }, (_, i) => `New sentence number ${i}.`)].join(' ');
  const out = diffSentences(oldText, newText);
  const lines = out.split('\n').filter((l) => /^[-+] /.test(l));
  assert.equal(lines.length, 8);
  assert.ok(lines.every((l) => l.length <= 2 + 200), 'each sentence truncated to about 200 chars');
  assert.ok(lines.some((l) => l.startsWith('+ NNN')), 'the long sentence appears, truncated');
  assert.ok(lines.some((l) => l.startsWith('- ')) && lines.some((l) => l.startsWith('+ ')), 'both sides represented');
  assert.match(out, /16 more sentence\(s\) omitted/);
});

test('a one-sided rewrite still shows up to eight sentences and counts the rest', () => {
  const oldText = Array.from({ length: 30 }, (_, i) => `Old ${i}.`).join(' ');
  const out = diffSentences(oldText, 'Brand new.');
  const lines = out.split('\n').filter((l) => /^[-+] /.test(l));
  assert.equal(lines.length, 8);
  assert.ok(lines.includes('+ Brand new.'));
  assert.match(out, /23 more sentence\(s\) omitted/);
});

test('a sentence containing a code fence cannot break out of the diff block', () => {
  const out = diffSentences('Same.', 'Same. Evil ``` fence.');
  assert.ok(!out.split('\n').slice(1, -1).some((l) => l.includes('```')));
});

test('legacy state: hash unchanged and no stored text stores the text and emits nothing', async () => {
  isolate();
  const state = freshState();
  await checkPages(state, { fetchImpl: pageFetch({}) });
  const legacy = { ...state, page_text: undefined } as unknown as WatchState;
  delete (legacy as { page_text?: unknown }).page_text;
  const findings = await checkPages(legacy, { fetchImpl: pageFetch({}) });
  assert.equal(findings.length, 0);
  for (const u of PAGE_URLS) assert.equal(legacy.page_text[u], 'Stable page.');
});

test('legacy state: hash changed and no stored text says no diff is available, then stores the text', async () => {
  isolate();
  const state = freshState();
  await checkPages(state, { fetchImpl: pageFetch({}) });
  const legacy = { ...state } as WatchState;
  delete (legacy as { page_text?: unknown }).page_text;
  const findings = await checkPages(legacy, { fetchImpl: pageFetch({ [TEASER]: 'Something new.' }) });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, 'page_change');
  assert.equal(findings[0].trust, 'official');
  assert.match(findings[0].summary, /no diff is available/i);
  assert.equal(legacy.page_text[TEASER], 'Something new.');
  // And the next change does produce a diff.
  const next = await checkPages(legacy, { fetchImpl: pageFetch({ [TEASER]: 'Something newer.' }) });
  assert.match(next[0].summary, /^- Something new\.$/m);
  assert.match(next[0].summary, /^\+ Something newer\.$/m);
});

test('loadWatchState accepts a legacy state file with no page_text and supplies an empty one', () => {
  isolate();
  saveWatchState({ v: 1, repos: {}, pages: { 'https://flop.finance/': 'h' }, rooms: {}, last_run: 'x' } as unknown as WatchState);
  const loaded = loadWatchState();
  assert.deepEqual(loaded.page_text, {});
  assert.equal(loaded.pages['https://flop.finance/'], 'h');
});

// --- block-structured diffs ---------------------------------------------------

test('extractBlocks splits lists and sentences into separate items, not one run-on string', () => {
  const blocks = extractBlocks('<ul><li>Miners</li><li>Validators</li></ul><p>One. Two.</p>');
  assert.deepEqual(blocks, ['Miners', 'Validators', 'One.', 'Two.']);
});

test('extractBlocks drops script and style contents, splits on br and table cells, and drops empties', () => {
  const html =
    '<style>.a{color:red}</style><script>var x = "a. b";</script>' +
    '<h2>Title</h2><table><tr><td>Cell  one</td><th>Cell two</th></tr></table>line a<br/>line b<BR>  <div>  </div>';
  assert.deepEqual(extractBlocks(html), ['Title', 'Cell one', 'Cell two', 'line a', 'line b']);
});

test('stored page hashes are unchanged: still the hash of extractText, not of the blocks', async () => {
  isolate();
  const html = '<html><body><ul><li>Miners</li><li>Validators</li></ul><p>One. Two.</p></body></html>';
  // Pinned literal: sha256 of the extractText output as it was before extractBlocks
  // existed. Hashes already cached by the workflow were produced this way.
  const expected = '681382bc4be9793bd4023214c115b936c5c9159c43698ab12b1d31465aa4ebce';
  assert.equal(extractText(html), 'MinersValidatorsOne. Two.');
  assert.equal(textHash(html), expected);
  const state = freshState();
  const fetchImpl = (async () => new Response(html)) as unknown as typeof fetch;
  await checkPages(state, { fetchImpl });
  for (const u of PAGE_URLS) assert.equal(state.pages[u], expected);
  assert.equal(state.page_text[PAGE_URLS[0]], 'Miners\nValidators\nOne.\nTwo.');
});

/** A ~800 char list item whose one differing word sits near character 500. */
function longBlock(word: string): string {
  const filler = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `${tag}${i}`).join(' ');
  return `${filler(70, 'lead')} ${word} ${filler(45, 'tail')}`;
}

test('a one-word change deep inside a long block is visible on both the - and + lines', async () => {
  isolate();
  const oldBlock = longBlock('ALPHA');
  const newBlock = longBlock('OMEGA');
  assert.ok(oldBlock.length > 750 && oldBlock.indexOf('ALPHA') > 400, `fixture: len ${oldBlock.length} at ${oldBlock.indexOf('ALPHA')}`);
  const state = freshState();
  await checkPages(state, { fetchImpl: pageFetch({ [TEASER]: `<ul><li>Intro</li><li>${oldBlock}</li></ul>` }) });
  const findings = await checkPages(state, { fetchImpl: pageFetch({ [TEASER]: `<ul><li>Intro</li><li>${newBlock}</li></ul>` }) });
  assert.equal(findings.length, 1);
  const lines = findings[0].summary.split('\n');
  const minus = lines.find((l) => l.startsWith('- '));
  const plus = lines.find((l) => l.startsWith('+ '));
  assert.ok(minus !== undefined && plus !== undefined);
  assert.ok(minus.includes('ALPHA') && !minus.includes('OMEGA'), minus);
  assert.ok(plus.includes('OMEGA') && !plus.includes('ALPHA'), plus);
  assert.ok(minus.length <= 202 && plus.length <= 202, 'each line stays within about 200 characters');
});

test('a paired window that does not start at character 0 is marked with an ellipsis at the front, and at the back when cut', () => {
  const out = diffSentences(longBlock('ALPHA'), longBlock('OMEGA'));
  const minus = out.split('\n').find((l) => l.startsWith('- '))!;
  const plus = out.split('\n').find((l) => l.startsWith('+ '))!;
  assert.ok(minus.startsWith('- …'), minus);
  assert.ok(plus.startsWith('+ …'), plus);
  assert.ok(minus.endsWith('…') && plus.endsWith('…'));
  assert.ok(!minus.startsWith('- lead0'), 'window does not begin at the start of the block');
});

test('a window is not marked with a front ellipsis when the change is near the start', () => {
  const a = 'Start ALPHA ' + 'x '.repeat(200);
  const b = 'Start OMEGA ' + 'x '.repeat(200);
  const out = diffSentences(a, b);
  const minus = out.split('\n').find((l) => l.startsWith('- '))!;
  assert.ok(minus.startsWith('- Start ALPHA'), minus);
  assert.ok(minus.endsWith('…'));
});

test('unpaired lines keep start-truncation', () => {
  const out = diffSentences('Keep. ' + 'Q'.repeat(500) + '.', 'Keep.');
  const minus = out.split('\n').find((l) => l.startsWith('- '))!;
  assert.ok(minus.startsWith('- QQQ'));
  assert.ok(minus.endsWith('…'));
  assert.ok(minus.length <= 202);
});
