import { sign as cryptoSign, type KeyObject } from 'node:crypto';
import { parseExportBody, DEFAULT_BASE, type ExportedMessage } from './client.js';
import { verifyPayload } from './verify.js';
import { ss58FromDid } from './ss58.js';
import type { Http } from './http.js';

// The FLOP testnet agent faucet, following the procedure the official faucet
// bot publishes in its own signed replies:
//
//   1. post `!faucet request <address> <nonce>` in the faucet room, signed
//      with the did:key that controls the address
//   2. the bot replies with an unsigned challenge string
//   3. sign those exact bytes and POST {address, nonce, signature} privately
//
// Unlike the rest of this repository, this module sends things. It is only
// ever reached from the separate `agent` entry point, never from the
// `technocore-attest` CLI, whose promise not to send anything still holds.
//
// Everything it trusts is pinned below. If the faucet, the chain or the bot
// stops matching what is pinned, the run stops before anything is signed:
// a testnet faucet is exactly the kind of thing that gets impersonated.

export type FaucetNetwork = {
  /** Genesis hash of the chain a grant must land on. */
  genesis: string;
  /** The faucet bot's did:key; only replies it signed are believed. */
  botDid: string;
  room: string;
  faucetBase: string;
  claimPath: string;
  rpcUrl: string;
  chatBase: string;
};

/** As published at https://faucet.flop.network/chain and /limits on 2026-11-25. */
export const TESTNET: FaucetNetwork = {
  genesis: '0x918abd58fb16306b30ef3886514cfaebffecb4de43e82b6f8ec4795c43cfd800',
  botDid: 'did:key:z6MktjwdcBkwC6xo9wi4KY4ckWvn1GQHdQ1qzkaZtWqHAoxs',
  room: 'flop-testnet-faucet',
  faucetBase: 'https://faucet.flop.network',
  claimPath: '/v1/testnet/agent-claims',
  rpcUrl: 'https://testnet.flop.network/',
  chatBase: DEFAULT_BASE,
};

/** Exit codes, so a scheduler can tell "nothing to do" from "needs a look". */
export const EXIT = {
  ok: 0,
  error: 1,
  chainMismatch: 3,
  faucetNotReady: 4,
  identityMismatch: 5,
  chatRefused: 6,
  noChallenge: 7,
  claimUnknown: 8,
  claimNotAccepted: 9,
} as const;

export function faucetRequestText(address: string, nonce: string): string {
  return `!faucet request ${address} ${nonce}`;
}

export function faucetChallenge(genesis: string, address: string, nonce: string): string {
  return `flop-faucet-agent/v1|${genesis}|${address}|${nonce}`;
}

/** Ed25519 over the challenge's UTF-8 bytes, as 0x-prefixed hex. */
export function signChallenge(privateKey: KeyObject, challenge: string): string {
  return '0x' + cryptoSign(null, Buffer.from(challenge, 'utf8'), privateKey).toString('hex');
}

export type FaucetState = {
  lastNonce?: string;
  lastAttemptMs?: number;
  lastOutcome?: string;
  lastStatus?: number;
  lastReason?: string | null;
};

/**
 * The faucet grants once per 24 hours, and a request costs one of a handful
 * of daily challenges. Once a request has been posted, nothing is posted
 * again for 23 hours — whatever the outcome — unless a person overrides it.
 * That makes "retry a refusal in a loop" impossible by construction, however
 * the scheduler around this is configured.
 */
export const MIN_ATTEMPT_GAP_MS = 23 * 3600 * 1000;

export function attemptedRecently(state: FaucetState, nowMs: number): boolean {
  return (
    typeof state.lastAttemptMs === 'number' &&
    nowMs - state.lastAttemptMs < MIN_ATTEMPT_GAP_MS
  );
}

/** Strictly greater than the last nonce used, even if the clock stepped back. */
export function nextFaucetNonce(state: FaucetState, nowMs: number): string {
  const last = /^\d+$/.test(state.lastNonce ?? '') ? Number(state.lastNonce) : 0;
  return String(Math.max(nowMs, last + 1));
}

export type BotReply =
  | { kind: 'challenge'; text: string }
  | { kind: 'other'; text: string }
  | { kind: 'none' };

/** How far a server timestamp may trail our clock and still count as "after we asked". */
const CLOCK_SLACK_MS = 10_000;

/**
 * Looks through a room export for the bot's answer to our request.
 *
 * Room contents are anonymous, untrusted input, and anyone can post a line
 * that looks like a challenge. A message counts only if the pinned bot DID
 * signed it. Even then the challenge is never taken from the message: we
 * already know the one string we are willing to sign, and merely check that
 * the bot quoted exactly that. A genuine reply about our address that is
 * not the challenge (a refusal, a cooldown notice) is reported as `other`.
 */
export function findBotReply(
  messages: ExportedMessage[],
  net: FaucetNetwork,
  address: string,
  challenge: string,
  sinceMs: number,
): BotReply {
  let other: BotReply = { kind: 'none' };
  for (const m of messages) {
    if (m.from !== net.botDid || !m.text.includes(address)) continue;
    if (m.nonce === undefined || m.sig === undefined) continue;
    if (!verifyPayload(net.botDid, net.room, m.nonce, m.text, m.sig)) continue;
    if (m.text.includes(`"${challenge}"`)) return { kind: 'challenge', text: m.text };
    const at = Date.parse(m.ts);
    if (Number.isFinite(at) && at >= sinceMs - CLOCK_SLACK_MS) other = { kind: 'other', text: m.text };
  }
  return other;
}

export type ClaimOutcome = 'accepted' | 'refused' | 'unknown';

/**
 * A 5xx or a timeout status means the faucet may or may not have paid, so
 * it is `unknown`: check the balance, do not ask again.
 */
export function classifyClaimStatus(status: number): ClaimOutcome {
  if (status >= 200 && status < 300) return 'accepted';
  if (status >= 500 || status === 408) return 'unknown';
  return 'refused';
}

export type ClaimDeps = {
  http: Http;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  /** Receives events for the operator's log. Never given a signature or a signed URL. */
  log: (event: string, data: Record<string, unknown>) => void;
  loadState: () => FaucetState;
  saveState: (state: FaucetState) => void;
  /** Unlocks the key. Called only after every pinned check has passed. */
  loadIdentity: () => { did: string; privateKey: KeyObject };
  /** Signs the chat request, keeps its receipt, and returns the URL that posts it. */
  signChatRequest: (privateKey: KeyObject, did: string, room: string, text: string) => string;
};

export type ClaimOptions = {
  /** Run every check and show what would be sent, without sending or writing anything. */
  dryRun?: boolean;
  /** Ignore the 23-hour gap. For a person at the keyboard, never for a scheduler. */
  force?: boolean;
  /** If set, the unlocked key must be this DID or nothing is signed. */
  expectedDid?: string;
  network?: FaucetNetwork;
  pollIntervalMs?: number;
  maxPolls?: number;
};

export type ClaimResult = { code: number; outcome: string };

function parseJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function header(headers: Record<string, string | string[] | undefined>, name: string): string | null {
  const v = headers[name];
  if (v === undefined) return null;
  return Array.isArray(v) ? v.join(', ') : v;
}

/** Null when everything matches the pinned network; otherwise why it does not. */
async function preflight(
  deps: ClaimDeps,
  net: FaucetNetwork,
): Promise<ClaimResult | null> {
  const fail = (code: number, outcome: string, data: Record<string, unknown>): ClaimResult => {
    deps.log(outcome, data);
    return { code, outcome };
  };

  const chain = parseJson((await deps.http('GET', `${net.faucetBase}/chain`)).body);
  if (chain?.network !== 'testnet' || chain?.genesisHash !== net.genesis) {
    return fail(EXIT.chainMismatch, 'abort_faucet_chain_mismatch', {
      network: chain?.network ?? null,
      genesis: chain?.genesisHash ?? null,
    });
  }
  if (chain.technocoreBot?.did !== net.botDid || chain.technocoreBot?.room !== net.room) {
    return fail(EXIT.chainMismatch, 'abort_bot_identity_changed', {
      bot: chain.technocoreBot ?? null,
    });
  }

  // The faucet's word alone is not enough: ask the chain itself for block 0.
  // The public RPC is rate-limited, hence the few patient retries.
  let block0: unknown;
  for (let attempt = 0; attempt < 3 && typeof block0 !== 'string'; attempt++) {
    if (attempt > 0) await deps.sleep(6000);
    const res = await deps.http(
      'POST',
      net.rpcUrl,
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'chain_getBlockHash', params: [0] }),
    );
    block0 = res.status === 200 ? parseJson(res.body)?.result : undefined;
  }
  if (block0 !== net.genesis) {
    return fail(EXIT.chainMismatch, 'abort_rpc_genesis_unverified', { block0: block0 ?? null });
  }

  const limits = parseJson((await deps.http('GET', `${net.faucetBase}/limits`)).body);
  const agent = limits?.faucet?.agent;
  if (limits?.network !== 'testnet' || limits?.faucet?.status !== 'open') {
    return fail(EXIT.faucetNotReady, 'abort_faucet_not_open', {
      network: limits?.network ?? null,
      status: limits?.faucet?.status ?? null,
    });
  }
  if (agent?.claimPath !== net.claimPath) {
    return fail(EXIT.faucetNotReady, 'abort_claim_path_changed', {
      claimPath: agent?.claimPath ?? null,
    });
  }
  deps.log('preflight_ok', {
    faucet: limits.faucet.status,
    agentGrantFlop: agent.grantFlop ?? null,
    cooldownSeconds: agent.cooldownSeconds ?? null,
    rolloverRequiresSpend: agent.rolloverRequiresSpend ?? null,
  });
  return null;
}

async function waitForBotReply(
  deps: ClaimDeps,
  net: FaucetNetwork,
  address: string,
  challenge: string,
  sinceMs: number,
  pollIntervalMs: number,
  maxPolls: number,
): Promise<BotReply> {
  let other: BotReply = { kind: 'none' };
  let pollsSinceOther = 0;
  for (let i = 0; i < maxPolls; i++) {
    await deps.sleep(pollIntervalMs);
    let body: string;
    try {
      const res = await deps.http('GET', `${net.chatBase}/r/${net.room}/export`);
      if (res.status !== 200) continue;
      body = res.body;
    } catch {
      continue;
    }
    const reply = findBotReply(parseExportBody(body), net, address, challenge, sinceMs);
    if (reply.kind === 'challenge') return reply;
    if (reply.kind === 'other') other = reply;
    // A non-challenge reply is usually final, but give the challenge one
    // more poll to appear in case the bot sent a notice ahead of it.
    if (other.kind === 'other' && ++pollsSinceOther >= 2) return other;
  }
  return other;
}

/**
 * One faucet claim, start to finish. Makes at most one chat post and at most
 * one claim POST per call, and never repeats either.
 */
export async function runClaim(deps: ClaimDeps, opts: ClaimOptions = {}): Promise<ClaimResult> {
  const net = opts.network ?? TESTNET;
  const dryRun = opts.dryRun ?? false;
  const done = (code: number, outcome: string, data: Record<string, unknown> = {}): ClaimResult => {
    deps.log(outcome, data);
    return { code, outcome };
  };

  const state = deps.loadState();
  if (!dryRun && !opts.force && attemptedRecently(state, deps.now())) {
    return done(EXIT.ok, 'skip_recent_attempt', {
      lastAttempt: new Date(state.lastAttemptMs!).toISOString(),
      lastOutcome: state.lastOutcome ?? null,
    });
  }

  const mismatch = await preflight(deps, net);
  if (mismatch) return mismatch;

  const { did, privateKey } = deps.loadIdentity();
  if (opts.expectedDid !== undefined && did !== opts.expectedDid) {
    return done(EXIT.identityMismatch, 'abort_identity_mismatch', { did, expected: opts.expectedDid });
  }
  const address = ss58FromDid(did);
  const nonce = nextFaucetNonce(state, deps.now());
  const text = faucetRequestText(address, nonce);
  const challenge = faucetChallenge(net.genesis, address, nonce);

  if (dryRun) {
    return done(EXIT.ok, 'dry_run', {
      did,
      address,
      wouldPost: text,
      wouldSign: challenge,
      claimUrl: net.faucetBase + net.claimPath,
    });
  }

  const save = (extra: FaucetState): void =>
    deps.saveState({ ...state, lastNonce: nonce, lastAttemptMs: deps.now(), ...extra });
  // Recorded before anything is sent: if the process dies mid-way, the next
  // run still knows a request may be out there and stays quiet.
  save({ lastOutcome: 'started' });

  // 1. The signed chat request.
  const postUrl = deps.signChatRequest(privateKey, did, net.room, text);
  const sentAt = deps.now();
  let postStatus: number;
  try {
    postStatus = (await deps.http('GET', postUrl)).status;
  } catch (err) {
    save({ lastOutcome: 'chat_unknown' });
    return done(EXIT.chatRefused, 'chat_request_unknown', { error: errorText(err) });
  }
  deps.log('chat_request_sent', { status: postStatus, text });
  if (postStatus < 200 || postStatus >= 300) {
    save({ lastOutcome: 'chat_refused', lastStatus: postStatus });
    return { code: EXIT.chatRefused, outcome: 'chat_refused' };
  }

  // 2. The bot's signed reply must quote exactly the challenge we expect.
  const reply = await waitForBotReply(
    deps, net, address, challenge, sentAt,
    opts.pollIntervalMs ?? 5000, opts.maxPolls ?? 24,
  );
  if (reply.kind !== 'challenge') {
    save({ lastOutcome: 'no_challenge' });
    return done(EXIT.noChallenge, 'abort_no_matching_challenge', {
      reply: reply.kind,
      text: reply.kind === 'other' ? reply.text.slice(0, 400) : null,
    });
  }
  deps.log('challenge_received', { text: reply.text.slice(0, 160) });

  // 3. Sign the challenge and claim, privately. The signature goes to the
  //    faucet and nowhere else: not the room, not the log, not the state.
  const signature = signChallenge(privateKey, challenge);
  let res;
  try {
    res = await deps.http(
      'POST',
      net.faucetBase + net.claimPath,
      JSON.stringify({ address, nonce, signature }),
    );
  } catch (err) {
    save({ lastOutcome: 'unknown' });
    return done(EXIT.claimUnknown, 'claim_outcome_unknown', {
      error: errorText(err),
      note: 'check the balance before asking again',
    });
  }
  // Should a response ever echo the signature back, it still stays out of the log.
  const responseText = res.body.split(signature).join('[signature]');
  const parsed = parseJson(responseText);
  const outcome = classifyClaimStatus(res.status);
  save({
    lastOutcome: outcome,
    lastStatus: res.status,
    lastReason: typeof parsed?.reason === 'string' ? parsed.reason : null,
  });
  deps.log('claim_response', {
    outcome,
    status: res.status,
    retryAfter: header(res.headers, 'retry-after'),
    refusal: header(res.headers, 'x-flop-refusal-reason'),
    body: parsed ?? responseText.slice(0, 600),
  });
  return { code: outcome === 'accepted' ? EXIT.ok : EXIT.claimNotAccepted, outcome };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
