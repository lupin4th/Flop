import test from 'node:test';
import assert from 'node:assert/strict';
import { verify as cryptoVerify, type KeyObject } from 'node:crypto';
import {
  TESTNET, EXIT, MIN_ATTEMPT_GAP_MS,
  faucetRequestText, faucetChallenge, signChallenge,
  attemptedRecently, nextFaucetNonce, findBotReply, classifyClaimStatus, runClaim,
  type FaucetNetwork, type FaucetState, type ClaimDeps, type ClaimOptions,
} from './faucet.js';
import { generateIdentity } from './keystore.js';
import { signPayload, publicKeyFromDid } from './verify.js';
import { buildPostUrl } from './receipts.js';
import { ss58FromDid } from './ss58.js';
import type { ExportedMessage } from './client.js';
import type { HttpResponse } from './http.js';

const T0 = 1_800_000_000_000;

type Sent = { method: string; url: string; body?: string };

/**
 * A complete fake of everything `runClaim` talks to: the faucet, the chain
 * RPC, the chat room and the real bot's signing key. Each test bends one
 * piece of it and checks what the agent sends as a result.
 */
function world(tweak: Partial<{
  chain: unknown;
  limits: unknown;
  block0: unknown;
  rpcStatus: number;
  chatStatus: number;
  claim: HttpResponse | Error | ((body: string) => HttpResponse);
  /** What appears in the room after our request is posted. */
  botReplies: (ctx: { net: FaucetNetwork; address: string; nonce: string; bot: Identity; at: string }) => object[];
  state: FaucetState;
}> = {}) {
  const bot = generateIdentity();
  const me = generateIdentity();
  const net: FaucetNetwork = { ...TESTNET, botDid: bot.did, genesis: '0x' + 'ab'.repeat(32) };
  const address = ss58FromDid(me.did);

  const sent: Sent[] = [];
  const logs: { event: string; data: Record<string, unknown> }[] = [];
  const saved: FaucetState[] = [];
  const signedUrls: string[] = [];
  let identityLoads = 0;
  let clock = T0;
  let exportBody = '';
  let botNonce = 5000;

  const json = (body: unknown, status = 200): HttpResponse => ({ status, headers: {}, body: JSON.stringify(body) });

  const deps: ClaimDeps = {
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    log: (event, data) => logs.push({ event, data }),
    loadState: () => tweak.state ?? {},
    saveState: (s) => saved.push(s),
    loadIdentity: () => { identityLoads++; return me; },
    signChatRequest: (privateKey, did, room, text) => {
      const nonce = clock;
      const url = buildPostUrl(net.chatBase, did, signPayload(privateKey, room, nonce, text), nonce, room, text);
      signedUrls.push(url);
      return url;
    },
    http: async (method, url, body) => {
      sent.push({ method, url, body });
      if (url === `${net.faucetBase}/chain`) {
        return json(tweak.chain ?? {
          network: 'testnet', genesisHash: net.genesis,
          technocoreBot: { did: net.botDid, room: net.room },
        });
      }
      if (url === net.rpcUrl) {
        return json({ result: 'block0' in tweak ? tweak.block0 : net.genesis }, tweak.rpcStatus ?? 200);
      }
      if (url === `${net.faucetBase}/limits`) {
        return json(tweak.limits ?? {
          network: 'testnet',
          faucet: { status: 'open', agent: { grantFlop: 10, claimPath: net.claimPath, cooldownSeconds: 86400, rolloverRequiresSpend: true } },
        });
      }
      if (url.startsWith(`${net.chatBase}/r/${net.room}/say-signed/`)) {
        const status = tweak.chatStatus ?? 200;
        if (status === 200) {
          const nonce = decodeURIComponent(url).split(' ').pop()!;
          const make = tweak.botReplies ?? (({ net, address, nonce, bot, at }) => [
            botLine(bot, net, at, `request #1: [FLOP TESTNET] Unsigned challenge: "${faucetChallenge(net.genesis, address, nonce)}". Sign those exact UTF-8 bytes.`, botNonce++),
          ]);
          exportBody = make({ net, address, nonce, bot, at: new Date(clock + 3000).toISOString() })
            .map((l) => JSON.stringify(l)).join('\n');
        }
        return { status, headers: {}, body: 'untrusted room transcript' };
      }
      if (url === `${net.chatBase}/r/${net.room}/export`) {
        return { status: 200, headers: {}, body: exportBody };
      }
      if (url === net.faucetBase + net.claimPath) {
        if (tweak.claim instanceof Error) throw tweak.claim;
        if (typeof tweak.claim === 'function') return tweak.claim(body ?? '');
        return tweak.claim ?? json({ success: true, amount: 10, txHash: '0xabc', status: 'included' });
      }
      throw new Error(`unexpected request: ${method} ${url}`);
    },
  };

  const run = (opts: ClaimOptions = {}) =>
    runClaim(deps, { network: net, pollIntervalMs: 5000, maxPolls: 4, ...opts });
  const chatPosts = () => sent.filter((r) => r.url.includes('/say-signed/'));
  const claimPosts = () => sent.filter((r) => r.url === net.faucetBase + net.claimPath);
  return { run, net, me, bot, address, sent, logs, saved, signedUrls, chatPosts, claimPosts, identityLoads: () => identityLoads };
}

type Identity = { did: string; privateKey: KeyObject };

function botLine(signer: Identity, net: FaucetNetwork, ts: string, text: string, nonce: number, from = signer.did) {
  return { seq: nonce, ts, from, text, nonce, sig: signPayload(signer.privateKey, net.room, nonce, text) };
}

// ---- pure pieces -----------------------------------------------------------

test('request text and challenge follow the format the bot publishes', () => {
  assert.equal(faucetRequestText('5Abc', '1795586121818'), '!faucet request 5Abc 1795586121818');
  assert.equal(
    faucetChallenge('0x918a', '5Abc', '1795586121818'),
    'flop-faucet-agent/v1|0x918a|5Abc|1795586121818',
  );
});

test('signChallenge is a 0x-hex Ed25519 signature over the exact UTF-8 bytes', () => {
  const { did, privateKey } = generateIdentity();
  const sig = signChallenge(privateKey, 'flop-faucet-agent/v1|0x00|5Abc|1');
  assert.match(sig, /^0x[0-9a-f]{128}$/);
  const raw = Buffer.from(sig.slice(2), 'hex');
  assert.equal(cryptoVerify(null, Buffer.from('flop-faucet-agent/v1|0x00|5Abc|1'), publicKeyFromDid(did), raw), true);
  assert.equal(cryptoVerify(null, Buffer.from('flop-faucet-agent/v1|0x00|5Abc|2'), publicKeyFromDid(did), raw), false);
});

test('an attempt blocks the next one for 23 hours, whatever its outcome', () => {
  for (const lastOutcome of ['accepted', 'refused', 'unknown', 'started', 'no_challenge']) {
    assert.equal(attemptedRecently({ lastAttemptMs: T0, lastOutcome }, T0 + MIN_ATTEMPT_GAP_MS - 1), true);
    assert.equal(attemptedRecently({ lastAttemptMs: T0, lastOutcome }, T0 + MIN_ATTEMPT_GAP_MS), false);
  }
  assert.equal(attemptedRecently({}, T0), false);
});

test('the faucet nonce never goes backwards, even if the clock does', () => {
  assert.equal(nextFaucetNonce({}, T0), String(T0));
  assert.equal(nextFaucetNonce({ lastNonce: String(T0 + 50) }, T0), String(T0 + 51));
  assert.equal(nextFaucetNonce({ lastNonce: 'garbage' }, T0), String(T0));
});

test('claim statuses: 2xx accepted, 5xx and 408 unknown, the rest refused', () => {
  assert.equal(classifyClaimStatus(200), 'accepted');
  assert.equal(classifyClaimStatus(429), 'refused');
  assert.equal(classifyClaimStatus(403), 'refused');
  assert.equal(classifyClaimStatus(503), 'unknown');
  assert.equal(classifyClaimStatus(408), 'unknown');
});

test('findBotReply believes only what the pinned bot signed', () => {
  const bot = generateIdentity();
  const stranger = generateIdentity();
  const net: FaucetNetwork = { ...TESTNET, botDid: bot.did };
  const address = '5Abc';
  const challenge = faucetChallenge(net.genesis, address, '7');
  const at = new Date(T0).toISOString();
  const text = `Unsigned challenge: "${challenge}".`;
  const find = (lines: object[]) => findBotReply(lines as ExportedMessage[], net, address, challenge, T0);
  const nonced = (l: ReturnType<typeof botLine>) => ({ ...l, nonce: String(l.nonce) });

  assert.equal(find([nonced(botLine(bot, net, at, text, 1))]).kind, 'challenge');
  // Right words, wrong author.
  assert.equal(find([nonced(botLine(stranger, net, at, text, 1))]).kind, 'none');
  // Claims to be the bot, but the signature is a stranger's.
  assert.equal(find([nonced(botLine(stranger, net, at, text, 1, bot.did))]).kind, 'none');
  // The bot's signature, lifted onto different text.
  const real = nonced(botLine(bot, net, at, text, 1));
  assert.equal(find([{ ...real, text: text.replace('|7"', '|8"') }]).kind, 'none');
  // No signature at all.
  const { sig: _dropped, ...unsigned } = real;
  assert.equal(find([unsigned]).kind, 'none');
});

test('findBotReply separates the expected challenge from other genuine replies', () => {
  const bot = generateIdentity();
  const net: FaucetNetwork = { ...TESTNET, botDid: bot.did };
  const address = '5Abc';
  const challenge = faucetChallenge(net.genesis, address, '7');
  const line = (ts: number, text: string, nonce: number) =>
    ({ ...botLine(bot, net, new Date(ts).toISOString(), text, nonce), nonce: String(nonce) }) as ExportedMessage;

  // A challenge for some other nonce is not ours to sign.
  const stale = line(T0 - 86_400_000, `Unsigned challenge: "${faucetChallenge(net.genesis, address, '6')}".`, 1);
  assert.equal(findBotReply([stale], net, address, challenge, T0).kind, 'none');
  // A fresh refusal about our address is reported, not mistaken for silence.
  const refusal = line(T0 + 4000, `request #2: ${address} is in cooldown`, 2);
  assert.deepEqual(findBotReply([stale, refusal], net, address, challenge, T0), { kind: 'other', text: refusal.text });
  // The challenge wins even when a notice precedes it.
  const good = line(T0 + 5000, `Unsigned challenge: "${challenge}".`, 3);
  assert.equal(findBotReply([refusal, good], net, address, challenge, T0).kind, 'challenge');
  // Replies about someone else's address are ignored.
  const theirs = line(T0 + 4000, 'request #3: 5Other is in cooldown', 4);
  assert.equal(findBotReply([theirs], net, address, challenge, T0).kind, 'none');
});

// ---- the whole flow --------------------------------------------------------

test('happy path: one chat post, one private claim, signature valid for the challenge', async () => {
  const w = world();
  const result = await w.run();
  assert.deepEqual(result, { code: EXIT.ok, outcome: 'accepted' });
  assert.equal(w.chatPosts().length, 1);
  assert.equal(w.claimPosts().length, 1);

  const claim = JSON.parse(w.claimPosts()[0].body!) as { address: string; nonce: string; signature: string };
  assert.equal(claim.address, w.address);
  assert.equal(typeof claim.nonce, 'string');
  assert.equal(claim.nonce, String(T0));
  const challenge = faucetChallenge(w.net.genesis, w.address, claim.nonce);
  assert.equal(
    cryptoVerify(null, Buffer.from(challenge), publicKeyFromDid(w.me.did), Buffer.from(claim.signature.slice(2), 'hex')),
    true,
  );
  assert.equal(decodeURIComponent(w.chatPosts()[0].url).endsWith(`!faucet request ${w.address} ${claim.nonce}`), true);

  const last = w.saved.at(-1)!;
  assert.equal(last.lastOutcome, 'accepted');
  assert.equal(last.lastNonce, claim.nonce);
  assert.equal(last.lastStatus, 200);
});

test('state is marked started before anything is sent', async () => {
  const w = world();
  await w.run();
  assert.equal(w.saved[0].lastOutcome, 'started');
});

test('neither the log nor the saved state ever holds a signature or a signed URL', async () => {
  const accepted = world();
  // Worst case: the faucet echoes the signature back in its refusal.
  const echoing = world({
    claim: (body) => ({
      status: 400,
      headers: {},
      body: `bad signature ${(JSON.parse(body) as { signature: string }).signature}`,
    }),
  });
  for (const w of [accepted, echoing]) {
    await w.run();
    const signature = (JSON.parse(w.claimPosts()[0].body!) as { signature: string }).signature;
    const written = JSON.stringify(w.logs) + JSON.stringify(w.saved);
    assert.equal(written.includes(signature), false, 'claim signature leaked');
    assert.equal(written.includes(signature.slice(2)), false, 'claim signature leaked');
    assert.equal(w.signedUrls.length, 1);
    assert.equal(written.includes(w.signedUrls[0]), false, 'signed URL leaked');
    assert.equal(written.includes('say-signed'), false);
    assert.equal(written.includes('untrusted room transcript'), false, 'room text must not be logged');
  }
  assert.match(JSON.stringify(echoing.logs), /bad signature \[signature\]/);
});

test('dry run checks everything but sends and writes nothing', async () => {
  const w = world();
  const result = await w.run({ dryRun: true });
  assert.deepEqual(result, { code: EXIT.ok, outcome: 'dry_run' });
  assert.equal(w.chatPosts().length, 0);
  assert.equal(w.claimPosts().length, 0);
  assert.equal(w.saved.length, 0);
  assert.equal(w.signedUrls.length, 0);
  const shown = w.logs.at(-1)!.data;
  assert.equal(shown.address, w.address);
  assert.equal(shown.wouldSign, faucetChallenge(w.net.genesis, w.address, String(T0)));
});

test('a recent attempt is skipped without a single request', async () => {
  const w = world({ state: { lastAttemptMs: T0 - 3600_000, lastOutcome: 'refused', lastNonce: '1' } });
  const result = await w.run();
  assert.deepEqual(result, { code: EXIT.ok, outcome: 'skip_recent_attempt' });
  assert.equal(w.sent.length, 0);
  assert.equal(w.identityLoads(), 0);
});

test('--force overrides the gap, and an old attempt does not block', async () => {
  const forced = world({ state: { lastAttemptMs: T0 - 3600_000, lastOutcome: 'accepted' } });
  assert.equal((await forced.run({ force: true })).outcome, 'accepted');
  const old = world({ state: { lastAttemptMs: T0 - MIN_ATTEMPT_GAP_MS, lastOutcome: 'accepted' } });
  assert.equal((await old.run()).outcome, 'accepted');
});

const stopsBeforeSigning = async (w: ReturnType<typeof world>, code: number, outcome: string) => {
  const result = await w.run();
  assert.deepEqual(result, { code, outcome });
  assert.equal(w.identityLoads(), 0, 'the key must not be unlocked');
  assert.equal(w.chatPosts().length, 0);
  assert.equal(w.claimPosts().length, 0);
  assert.equal(w.saved.length, 0, 'a failed preflight is not an attempt');
};

test('stops before unlocking the key when the faucet reports another chain', async () => {
  await stopsBeforeSigning(
    world({ chain: { network: 'testnet', genesisHash: '0x' + 'cd'.repeat(32), technocoreBot: {} } }),
    EXIT.chainMismatch, 'abort_faucet_chain_mismatch',
  );
  await stopsBeforeSigning(
    world({ chain: { network: 'devnet', genesisHash: '0x' + 'ab'.repeat(32), technocoreBot: {} } }),
    EXIT.chainMismatch, 'abort_faucet_chain_mismatch',
  );
  await stopsBeforeSigning(world({ chain: 'not an object' }), EXIT.chainMismatch, 'abort_faucet_chain_mismatch');
});

test('stops when the faucet names a different bot or room', async () => {
  const impostor = generateIdentity();
  const w = world();
  const swapped = world({
    chain: { network: 'testnet', genesisHash: '0x' + 'ab'.repeat(32), technocoreBot: { did: impostor.did, room: w.net.room } },
  });
  await stopsBeforeSigning(swapped, EXIT.chainMismatch, 'abort_bot_identity_changed');
});

test('stops when the chain itself does not confirm the genesis hash', async () => {
  await stopsBeforeSigning(world({ block0: '0x' + '00'.repeat(32) }), EXIT.chainMismatch, 'abort_rpc_genesis_unverified');
  // A rate-limited RPC proves nothing, so it is treated the same way.
  const limited = world({ rpcStatus: 429 });
  await stopsBeforeSigning(limited, EXIT.chainMismatch, 'abort_rpc_genesis_unverified');
  assert.equal(limited.sent.filter((r) => r.url === limited.net.rpcUrl).length, 3, 'three tries, then give up');
});

test('stops when the faucet is closed or has moved its claim endpoint', async () => {
  await stopsBeforeSigning(
    world({ limits: { network: 'testnet', faucet: { status: 'paused', agent: { claimPath: TESTNET.claimPath } } } }),
    EXIT.faucetNotReady, 'abort_faucet_not_open',
  );
  await stopsBeforeSigning(
    world({ limits: { network: 'testnet', faucet: { status: 'open', agent: { claimPath: '/v2/elsewhere' } } } }),
    EXIT.faucetNotReady, 'abort_claim_path_changed',
  );
  await stopsBeforeSigning(
    world({ limits: { network: 'testnet', faucet: { status: 'open', agent: { claimPath: null } } } }),
    EXIT.faucetNotReady, 'abort_claim_path_changed',
  );
});

test('stops when the unlocked key is not the expected DID', async () => {
  const w = world();
  const result = await w.run({ expectedDid: generateIdentity().did });
  assert.deepEqual(result, { code: EXIT.identityMismatch, outcome: 'abort_identity_mismatch' });
  assert.equal(w.chatPosts().length, 0);
  assert.equal(w.saved.length, 0);
  // And proceeds when it is.
  const ok = world();
  assert.equal((await ok.run({ expectedDid: ok.me.did })).outcome, 'accepted');
});

test('a refused chat post ends the run without a claim', async () => {
  const w = world({ chatStatus: 429 });
  const result = await w.run();
  assert.deepEqual(result, { code: EXIT.chatRefused, outcome: 'chat_refused' });
  assert.equal(w.claimPosts().length, 0);
  assert.equal(w.saved.at(-1)!.lastOutcome, 'chat_refused');
});

test('a forged challenge in the room is not signed', async () => {
  const stranger = generateIdentity();
  const w = world({
    botReplies: ({ net, address, nonce, bot, at }) => [
      // Sent by a stranger while claiming the bot's DID.
      botLine(stranger, net, at, `Unsigned challenge: "${faucetChallenge(net.genesis, address, nonce)}".`, 1, bot.did),
    ],
  });
  const result = await w.run();
  assert.deepEqual(result, { code: EXIT.noChallenge, outcome: 'abort_no_matching_challenge' });
  assert.equal(w.claimPosts().length, 0);
  assert.equal(w.saved.at(-1)!.lastOutcome, 'no_challenge');
});

test('a genuine bot challenge for a different chain or nonce is not signed', async () => {
  const w = world({
    botReplies: ({ net, address, nonce, bot, at }) => [
      botLine(bot, net, at, `Unsigned challenge: "${faucetChallenge('0x' + 'ee'.repeat(32), address, nonce)}".`, 1),
      botLine(bot, net, at, `Unsigned challenge: "${faucetChallenge(net.genesis, address, String(Number(nonce) + 1))}".`, 2),
    ],
  });
  const result = await w.run();
  assert.equal(result.outcome, 'abort_no_matching_challenge');
  assert.equal(w.claimPosts().length, 0);
});

test('a genuine refusal from the bot is reported and ends the run early', async () => {
  const w = world({
    botReplies: ({ net, address, bot, at }) => [botLine(bot, net, at, `request #9: ${address} cooldown active`, 1)],
  });
  const result = await w.run({ maxPolls: 24 });
  assert.equal(result.code, EXIT.noChallenge);
  const logged = w.logs.at(-1)!.data;
  assert.equal(logged.reply, 'other');
  assert.match(String(logged.text), /cooldown active/);
  const polls = w.sent.filter((r) => r.url.endsWith('/export')).length;
  assert.equal(polls, 2, 'one extra poll after the refusal, not the full two minutes');
});

test('silence from the bot ends after the poll budget, with no claim', async () => {
  const w = world({ botReplies: () => [] });
  const result = await w.run({ maxPolls: 3 });
  assert.equal(result.outcome, 'abort_no_matching_challenge');
  assert.equal(w.sent.filter((r) => r.url.endsWith('/export')).length, 3);
  assert.equal(w.claimPosts().length, 0);
});

test('a faucet refusal is recorded and not retried', async () => {
  const w = world({
    claim: { status: 429, headers: { 'retry-after': '3600', 'x-flop-refusal-reason': 'spend_required' }, body: JSON.stringify({ success: false, reason: 'spend_required' }) },
  });
  const result = await w.run();
  assert.deepEqual(result, { code: EXIT.claimNotAccepted, outcome: 'refused' });
  assert.equal(w.claimPosts().length, 1);
  const last = w.saved.at(-1)!;
  assert.equal(last.lastOutcome, 'refused');
  assert.equal(last.lastReason, 'spend_required');
  const logged = w.logs.at(-1)!.data;
  assert.equal(logged.retryAfter, '3600');
  assert.equal(logged.refusal, 'spend_required');
});

test('a server error or a dropped connection leaves the outcome unknown', async () => {
  const fivexx = world({ claim: { status: 503, headers: {}, body: 'upstream' } });
  assert.deepEqual(await fivexx.run(), { code: EXIT.claimNotAccepted, outcome: 'unknown' });
  assert.equal(fivexx.saved.at(-1)!.lastOutcome, 'unknown');

  const dropped = world({ claim: new Error('socket hang up') });
  assert.deepEqual(await dropped.run(), { code: EXIT.claimUnknown, outcome: 'claim_outcome_unknown' });
  assert.equal(dropped.saved.at(-1)!.lastOutcome, 'unknown');
  assert.equal(dropped.claimPosts().length, 1, 'never retried');
});
