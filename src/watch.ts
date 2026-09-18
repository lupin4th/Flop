import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { watchStatePath, ensureHome } from './paths.js';
import { fetchRoom, type RoomMessage } from './client.js';

/**
 * No signal here is ever treated as authoritative on its own. GitHub and
 * flop.finance are the only channels this tool labels `official`, because
 * they are the two channels FLOP Labs actually controls; everything seen in
 * chat is unauthenticated third-party text with no discoverable "official
 * DID" to check it against (see the sonnet contest: the referee's identity
 * was pinned in a GitHub repo, never inferable from who posts in a room).
 * So a chat message can never be labelled `official`, no matter who signed
 * it or how official it sounds.
 */
export type Finding = {
  source: 'github' | 'web' | 'chat';
  trust: 'official' | 'unverified';
  summary: string;
  detail: string;
  at: string;
};

export type WatchState = {
  v: 1;
  repos: Record<string, string>;
  pages: Record<string, string>;
  rooms: Record<string, number>;
  last_run: string;
  /**
   * Newest commit `sha` seen per repo, used to report only the commits
   * that are new since the last run when a push is detected. Optional —
   * not required — so that a state file written by every version of this
   * tool before this field existed (no `repo_commits` key at all) loads
   * and behaves exactly as it did before: missing per-repo entries are
   * treated as "no baseline yet" (see `checkGitHub`), the same posture
   * `repos` and `rooms` already take toward an unseen key.
   */
  repo_commits?: Record<string, string>;
};

type WatchOpts = { fetchImpl?: typeof fetch; nowMs?: () => number };

const GITHUB_REPOS_URL = 'https://api.github.com/orgs/flop-labs/repos?per_page=100';

const PAGES = [
  'https://flop.finance/',
  'https://flop.finance/teaser/',
  'https://flop.finance/intro/',
  'https://flop.finance/intro/yellowpaper/',
];

// `lobby` is excluded on purpose: it runs at millions of seq and is pure
// noise, so watching it would only slow every run down for nothing.
const ROOMS = ['technocore', 'flop_labs', 'technocore-genesis'];

/**
 * Bare `testnet`, `mainnet` and `claim` were tried first and measured
 * against a live room snapshot: they matched bot presence heartbeats
 * (`"testnet node · cap=poui_verifier_v1"`, `"maintaining technocore
 * testnet presence"`) and unrelated agent chatter (`"without automatically
 * claiming the task"`), at a rate that buried any real hit under noise.
 * `faucet` alone stayed precise even in a full room snapshot (38 mentions
 * from only 3 distinct DIDs), so it is kept bare; everything else here is a
 * multi-word phrase specific enough not to fire on routine chatter.
 */
const KEYWORDS = [
  'faucet',
  'drip',
  'genesis block',
  'testnet is live',
  'testnet is open',
  'testnet has launched',
  'faucet is live',
  'faucet is open',
];

/** A spam burst in a watched room must not flood a run's output. */
const MAX_CHAT_FINDINGS_PER_ROOM = 5;

/**
 * Strips `<script>`/`<style>` blocks (contents included, not just the tags)
 * before stripping remaining tags and collapsing whitespace. Raw HTML from
 * flop.finance has been observed to hash differently on every fetch of the
 * same page — three fetches, three different hashes, at identical byte
 * length, diverging inside a Cloudflare-injected font `<style>` block. Text
 * extracted this way hashed identically across three consecutive fetches,
 * which is the only reason hashing page content is viable at all here.
 */
export function extractText(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function textHash(html: string): string {
  return createHash('sha256').update(extractText(html)).digest('hex');
}

function emptyState(): WatchState {
  return { v: 1, repos: {}, pages: {}, rooms: {}, last_run: new Date(0).toISOString() };
}

function isRecordOf<T>(value: unknown, check: (v: unknown) => v is T): value is Record<string, T> {
  if (typeof value !== 'object' || value === null) return false;
  return Object.values(value as Record<string, unknown>).every(check);
}

function isString(v: unknown): v is string {
  return typeof v === 'string';
}

function isNumber(v: unknown): v is number {
  return typeof v === 'number';
}

function isWatchState(value: unknown): value is WatchState {
  if (typeof value !== 'object' || value === null) return false;
  const s = value as Record<string, unknown>;
  return (
    s.v === 1 &&
    typeof s.last_run === 'string' &&
    isRecordOf(s.repos, isString) &&
    isRecordOf(s.pages, isString) &&
    isRecordOf(s.rooms, isNumber) &&
    // `repo_commits` postdates every state file already on disk, so a
    // state written before this field existed simply lacks the key —
    // that must load cleanly, not fail validation.
    (s.repo_commits === undefined || isRecordOf(s.repo_commits, isString))
  );
}

/**
 * A watch state file that fails to parse or fails validation is treated the
 * same as no file at all: this command only reads and only compares against
 * its own prior run, so losing that baseline costs one no-op comparison
 * cycle, never correctness or safety.
 */
export function loadWatchState(): WatchState {
  const path = watchStatePath();
  if (!existsSync(path)) return emptyState();
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (isWatchState(parsed)) return parsed;
  } catch {
    // fall through to a fresh baseline
  }
  return emptyState();
}

export function saveWatchState(s: WatchState): void {
  ensureHome();
  writeFileSync(watchStatePath(), JSON.stringify(s, null, 2));
}

type GhRepo = {
  name: string;
  pushed_at: string;
  description: string | null;
  html_url: string;
};

function isGhRepo(value: unknown): value is GhRepo {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.name === 'string' &&
    typeof r.pushed_at === 'string' &&
    typeof r.html_url === 'string' &&
    (r.description === null || typeof r.description === 'string')
  );
}

type GhCommit = { sha: string; commit: { message: string } };

function isGhCommit(value: unknown): value is GhCommit {
  if (typeof value !== 'object' || value === null) return false;
  const c = value as Record<string, unknown>;
  if (typeof c.sha !== 'string') return false;
  if (typeof c.commit !== 'object' || c.commit === null) return false;
  const commit = c.commit as Record<string, unknown>;
  return typeof commit.message === 'string';
}

/** One noisy multi-line commit message must not blow up the issue body. */
const MAX_COMMIT_SUBJECT_LEN = 100;
/** Cap how many subjects are listed per push; the rest are just counted. */
const MAX_COMMITS_LISTED = 5;

function commitSubject(message: string): string {
  const line = message.split('\n', 1)[0].trim();
  return line.length > MAX_COMMIT_SUBJECT_LEN
    ? line.slice(0, MAX_COMMIT_SUBJECT_LEN - 1) + '…'
    : line;
}

type CommitFetchResult =
  | { ok: true; subjects: string[]; newestSha: string }
  | { ok: false };

/**
 * Fetches a repo's recent commits and returns the subjects of whatever is
 * new since `lastSeenSha`. Only ever called from `checkGitHub` for a repo
 * whose `pushed_at` just changed — see the comment there for why this must
 * not be widened into a per-repo poll on every run.
 *
 * `lastSeenSha === undefined` means this repo has no commit baseline yet
 * (either truly new, or a state file predating `repo_commits`): the caller
 * treats that as first-run baselining, so this just hands back the newest
 * sha with no subjects to report.
 *
 * If `lastSeenSha` isn't found in the page of commits returned (the repo
 * moved more than `per_page` commits, or was force-pushed), there is no
 * reliable diff to compute, so this falls back to reporting just the
 * newest commit rather than guessing at a range.
 */
async function fetchNewCommitSubjects(
  repoName: string,
  lastSeenSha: string | undefined,
  doFetch: typeof fetch,
): Promise<CommitFetchResult> {
  try {
    const res = await doFetch(`https://api.github.com/repos/flop-labs/${repoName}/commits?per_page=10`, {
      headers: { accept: 'application/vnd.github+json' },
    });
    if (!res.ok) return { ok: false };
    const body: unknown = await res.json();
    if (!Array.isArray(body)) return { ok: false };
    const commits = body.filter(isGhCommit);
    if (commits.length === 0) return { ok: false };

    const newestSha = commits[0].sha;
    if (lastSeenSha === undefined) {
      return { ok: true, subjects: [], newestSha };
    }
    const idx = commits.findIndex((c) => c.sha === lastSeenSha);
    const newCommits = idx === -1 ? commits.slice(0, 1) : commits.slice(0, idx);
    return { ok: true, subjects: newCommits.map((c) => commitSubject(c.commit.message)), newestSha };
  } catch {
    return { ok: false };
  }
}

function formatPushFinding(repoName: string, subjects: string[]): string {
  if (subjects.length === 0) return `Repo pushed: ${repoName}`;
  const shown = subjects.slice(0, MAX_COMMITS_LISTED);
  const remainder = subjects.length - shown.length;
  const list = shown.map((s) => `"${s}"`).join('; ');
  const remainderNote = remainder > 0 ? ` (+${remainder} more)` : '';
  return `Repo pushed: ${repoName} — ${subjects.length} new commit(s): ${list}${remainderNote}`;
}

/**
 * A brand-new repo appearing under the org is the highest-value signal this
 * tool can see: FLOP Labs has a documented habit of standing up a dedicated
 * GitHub repo for each major event (the sonnet contest's referee DID was
 * pinned in one), so a new repo name is called out as such rather than
 * folded into the same wording as an ordinary push.
 *
 * `state.repos` being empty means there is no baseline yet — every repo in
 * the org would otherwise look "new" on the very first run, which is
 * exactly what a live run against an empty state produced: five false
 * "NEW REPO" findings for repos that had simply never been seen before by
 * this tool. So an empty `state.repos` silently records every repo's
 * current `pushed_at` and reports nothing; only a run that already has a
 * baseline can tell a genuinely new repo from an old one.
 */
export async function checkGitHub(state: WatchState, opts: WatchOpts = {}): Promise<Finding[]> {
  const doFetch = opts.fetchImpl ?? fetch;
  const nowMs = opts.nowMs ?? Date.now;
  const res = await doFetch(GITHUB_REPOS_URL, {
    headers: { accept: 'application/vnd.github+json' },
  });
  if (!res.ok) throw new Error(`GET org repos failed: ${res.status}`);
  const body: unknown = await res.json();
  if (!Array.isArray(body)) return [];

  const firstRun = Object.keys(state.repos).length === 0;
  const at = new Date(nowMs()).toISOString();
  const findings: Finding[] = [];
  for (const item of body) {
    if (!isGhRepo(item)) continue;
    const prior = state.repos[item.name];
    if (!firstRun) {
      if (prior === undefined) {
        const desc = item.description ? ` — ${item.description}` : '';
        findings.push({
          source: 'github',
          trust: 'official',
          summary: `NEW REPO in flop-labs: ${item.name}${desc} (a brand-new repo is the highest-value signal)`,
          detail: item.html_url,
          at,
        });
      } else if (prior !== item.pushed_at) {
        /*
         * Commits are fetched here, inline, ONLY because `pushed_at`
         * already told us this specific repo changed. Do not "simplify"
         * this into fetching every repo's commits every run — unauthenticated
         * GitHub allows 60 requests/hour, this tool sends no credentials,
         * and this workflow runs every 30 minutes. One request per org
         * (above) plus one request per repo that actually moved keeps an
         * ordinary quiet run at exactly one request and a busy run at a
         * handful; polling commits for every repo unconditionally would
         * multiply that by the org's repo count on every single run and
         * burn the rate limit for no reason.
         */
        const lastSha = state.repo_commits?.[item.name];
        const result = await fetchNewCommitSubjects(item.name, lastSha, doFetch);
        if (result.ok) {
          state.repo_commits = state.repo_commits ?? {};
          state.repo_commits[item.name] = result.newestSha;
          findings.push({
            source: 'github',
            trust: 'official',
            summary: formatPushFinding(item.name, result.subjects),
            detail: item.html_url,
            at,
          });
        } else {
          // A failed or malformed commits fetch must not lose the push
          // finding itself, and must not abort the page/room checks that
          // follow this one in `runWatch` — fall back to the plain text.
          findings.push({
            source: 'github',
            trust: 'official',
            summary: `Repo pushed: ${item.name} (commit detail unavailable)`,
            detail: item.html_url,
            at,
          });
        }
      }
    }
    state.repos[item.name] = item.pushed_at;
  }
  return findings;
}

/**
 * The first run has no baseline to compare against, so it only records
 * hashes and reports nothing — anything else would mean every fresh install
 * of this tool alerts on the entirety of flop.finance's current content.
 */
export async function checkPages(state: WatchState, opts: WatchOpts = {}): Promise<Finding[]> {
  const doFetch = opts.fetchImpl ?? fetch;
  const nowMs = opts.nowMs ?? Date.now;
  const at = new Date(nowMs()).toISOString();
  const findings: Finding[] = [];
  for (const url of PAGES) {
    const res = await doFetch(url);
    if (!res.ok) throw new Error(`GET ${url} failed: ${res.status}`);
    const html = await res.text();
    const hash = textHash(html);
    const prior = state.pages[url];
    if (prior !== undefined && prior !== hash) {
      findings.push({
        source: 'web',
        trust: 'official',
        summary: `Page content changed: ${url}`,
        detail: url,
        at,
      });
    }
    state.pages[url] = hash;
  }
  return findings;
}

function matchesKeyword(text: string): boolean {
  const lower = text.toLowerCase();
  return KEYWORDS.some((k) => lower.includes(k));
}

/**
 * Chat is rumor, never proof: there is no discoverable roster of official
 * FLOP Labs DIDs to check a poster against (the sonnet referee's DID lived
 * only in a GitHub repo, and the rules for that contest say plainly not to
 * infer the referee from who posts in a room). So every finding out of this
 * function is `unverified`, unconditionally, regardless of who sent it.
 *
 * Each room baselines independently: a room with no stored seq yet has no
 * "since" to watch forward from, so its very first `fetchRoom` call returns
 * whatever the last ~200 messages happen to be — matching those against the
 * keyword list would flag old chatter as a fresh finding. So a room with no
 * prior seq just records the highest seq it saw and reports nothing for
 * that room this run; a room that already has a baseline is checked
 * normally. This is independent per room and per source: a fresh room
 * baselining does not suppress GitHub or another, already-baselined room.
 */
export async function checkRooms(state: WatchState, opts: WatchOpts = {}): Promise<Finding[]> {
  const doFetch = opts.fetchImpl;
  const nowMs = opts.nowMs ?? Date.now;
  const at = new Date(nowMs()).toISOString();
  const findings: Finding[] = [];

  for (const room of ROOMS) {
    const since = state.rooms[room];
    const firstRunForRoom = since === undefined;
    let messages: RoomMessage[];
    try {
      messages = await fetchRoom(room, { since, fetchImpl: doFetch });
    } catch {
      // One room's failure must not cost the other rooms their check.
      continue;
    }

    let highest = since ?? 0;
    const matches: RoomMessage[] = [];
    for (const m of messages) {
      if (m.seq > highest) highest = m.seq;
      if (!firstRunForRoom && matchesKeyword(m.text)) matches.push(m);
    }
    state.rooms[room] = highest;

    if (firstRunForRoom) continue;

    const capped = matches.slice(0, MAX_CHAT_FINDINGS_PER_ROOM);
    for (const m of capped) {
      findings.push({
        source: 'chat',
        trust: 'unverified',
        summary: `Keyword match in #${room}: "${m.text.slice(0, 120)}"`,
        detail: `${room}#${m.seq}`,
        at,
      });
    }
    if (matches.length > MAX_CHAT_FINDINGS_PER_ROOM) {
      const suppressed = matches.length - MAX_CHAT_FINDINGS_PER_ROOM;
      findings.push({
        source: 'chat',
        trust: 'unverified',
        summary: `${suppressed} more keyword match(es) in #${room} suppressed (capped at ${MAX_CHAT_FINDINGS_PER_ROOM} per run)`,
        detail: room,
        at,
      });
    }
  }
  return findings;
}

/** Which sources had no baseline before this run and were only recorded, not compared. */
export type Baselined = {
  github: boolean;
  repoCount: number;
  rooms: string[];
};

/**
 * Runs all three checks and never lets one failing source cost the others
 * their turn — the same posture `confirmRoom` takes toward a degraded
 * server. State is saved exactly once, at the end, whether or not any
 * individual check failed, so a source that is down does not also roll
 * back progress the other sources made this run.
 *
 * GitHub and each room baseline independently (see the comments on
 * `checkGitHub` and `checkRooms`); this snapshots each source's state
 * before and after its check to say which ones were only just baselined,
 * so the caller can tell the user plainly why a run came back quiet.
 */
export async function runWatch(
  opts: WatchOpts = {},
): Promise<{ findings: Finding[]; state: WatchState; baselined: Baselined }> {
  const state = loadWatchState();
  const findings: Finding[] = [];
  const hadRepoBaseline = Object.keys(state.repos).length > 0;
  const roomsWithBaseline = new Set(Object.keys(state.rooms));

  try {
    findings.push(...(await checkGitHub(state, opts)));
  } catch {
    // continue: a dead GitHub API must not cost the page and room checks
  }
  try {
    findings.push(...(await checkPages(state, opts)));
  } catch {
    // continue: same reasoning as above
  }
  try {
    findings.push(...(await checkRooms(state, opts)));
  } catch {
    // continue: same reasoning as above
  }

  const nowMs = opts.nowMs ?? Date.now;
  state.last_run = new Date(nowMs()).toISOString();
  saveWatchState(state);

  const baselined: Baselined = {
    github: !hadRepoBaseline && Object.keys(state.repos).length > 0,
    repoCount: Object.keys(state.repos).length,
    rooms: Object.keys(state.rooms).filter((r) => !roomsWithBaseline.has(r)),
  };
  return { findings, state, baselined };
}
