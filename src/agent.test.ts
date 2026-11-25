import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from './agent.js';
import { TESTNET, EXIT, faucetChallenge } from './faucet.js';
import { generateIdentity, saveIdentity } from './keystore.js';
import { ss58FromDid } from './ss58.js';
import { passphrasePath, faucetStatePath, faucetLogPath, receiptsPath } from './paths.js';
import type { Http, HttpResponse } from './http.js';

const ALICE_SS58 = '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY';
const noSleep = async () => {};

/** A fresh attest home holding an encrypted key and its passphrase file. */
function home(passphraseMode = 0o600) {
  process.env.TECHNOCORE_ATTEST_HOME = mkdtempSync(join(tmpdir(), 'attest-agent-'));
  delete process.env.TECHNOCORE_DID;
  const me = generateIdentity();
  saveIdentity(me.privateKey, me.did, 'file passphrase');
  writeFileSync(passphrasePath(), 'file passphrase\n', { mode: passphraseMode });
  return me;
}

const json = (body: unknown, status = 200): HttpResponse => ({ status, headers: {}, body: JSON.stringify(body) });

/**
 * Stands in for the real testnet endpoints. The pinned bot DID cannot be
 * imitated (that is the point of pinning it), so this fake never produces a
 * challenge the agent would accept: the full signing flow is covered in
 * faucet.test.ts, and here we check the wiring around it.
 */
function fakeNetwork() {
  const sent: { method: string; url: string }[] = [];
  const http: Http = async (method, url, body) => {
    sent.push({ method, url });
    if (url === `${TESTNET.faucetBase}/chain`) {
      return json({ network: 'testnet', genesisHash: TESTNET.genesis, technocoreBot: { did: TESTNET.botDid, room: TESTNET.room } });
    }
    if (url === TESTNET.rpcUrl) {
      const method = (JSON.parse(body ?? '{}') as { method: string }).method;
      if (method === 'chain_getBlockHash') return json({ result: TESTNET.genesis });
      if (method === 'chain_getFinalizedHead') return json({ result: '0x' + 'fe'.repeat(32) });
      return json({ result: null });
    }
    if (url === `${TESTNET.faucetBase}/limits`) {
      return json({ network: 'testnet', faucet: { status: 'open', agent: { grantFlop: 10, claimPath: TESTNET.claimPath } } });
    }
    if (url.includes('/say-signed/')) return { status: 200, headers: {}, body: 'room transcript' };
    if (url.endsWith('/export')) return { status: 200, headers: {}, body: '' };
    throw new Error(`unexpected request: ${method} ${url}`);
  };
  return { http, sent };
}

test('no arguments or an unknown command prints usage', async () => {
  const lines: string[] = [];
  assert.equal(await run([], (s) => lines.push(s)), EXIT.error);
  assert.match(lines.join('\n'), /agent claim \[--dry-run\] \[--force\]/);
  assert.equal(await run(['claim', '--yolo'], (s) => lines.push(s)), EXIT.error);
  assert.match(lines.join('\n'), /Unknown option: --yolo/);
});

test('claim --dry-run unlocks the key from the passphrase file and sends nothing', async () => {
  const me = home();
  const { http, sent } = fakeNetwork();
  const lines: string[] = [];
  const code = await run(['claim', '--dry-run'], (s) => lines.push(s), http, noSleep);
  assert.equal(code, EXIT.ok);
  const address = ss58FromDid(me.did);
  assert.match(lines.at(-1)!, /dry_run/);
  assert.equal(lines.at(-1)!.includes(`!faucet request ${address} `), true);
  assert.equal(lines.at(-1)!.includes(faucetChallenge(TESTNET.genesis, address, '').slice(0, -1)), true);
  assert.equal(sent.some((r) => r.url.includes('/say-signed/') || r.url.includes(TESTNET.claimPath)), false);
  for (const path of [faucetStatePath(), faucetLogPath(), receiptsPath()]) {
    assert.equal(existsSync(path), false, `${path} must not be written by a dry run`);
  }
  assert.equal(lines.join('\n').includes('file passphrase'), false);
});

test('claim refuses a passphrase file others can read, before sending anything', async () => {
  home(0o644);
  const { http, sent } = fakeNetwork();
  const lines: string[] = [];
  const code = await run(['claim'], (s) => lines.push(s), http, noSleep);
  assert.equal(code, EXIT.error);
  assert.match(lines.at(-1)!, /readable by others/);
  assert.equal(sent.some((r) => r.url.includes('/say-signed/')), false);
  assert.equal(existsSync(faucetStatePath()), false);
});

test('claim refuses to sign with a key other than TECHNOCORE_DID', async () => {
  home();
  process.env.TECHNOCORE_DID = generateIdentity().did;
  const { http, sent } = fakeNetwork();
  try {
    const code = await run(['claim'], () => {}, http, noSleep);
    assert.equal(code, EXIT.identityMismatch);
    assert.equal(sent.some((r) => r.url.includes('/say-signed/')), false);
  } finally {
    delete process.env.TECHNOCORE_DID;
  }
});

test('a real run keeps private, owner-only records and then stays quiet', async () => {
  const me = home();
  const { http, sent } = fakeNetwork();
  const lines: string[] = [];
  // The fake room never answers, so the run ends at "no challenge".
  const code = await run(['claim'], (s) => lines.push(s), http, noSleep);
  assert.equal(code, EXIT.noChallenge);
  assert.equal(sent.filter((r) => r.url.includes('/say-signed/')).length, 1);
  assert.equal(sent.some((r) => r.url.includes(TESTNET.claimPath)), false);

  const state = JSON.parse(readFileSync(faucetStatePath(), 'utf8')) as { lastOutcome: string; lastNonce: string };
  assert.equal(state.lastOutcome, 'no_challenge');
  assert.match(state.lastNonce, /^\d{13}$/);
  for (const path of [faucetStatePath(), faucetLogPath(), receiptsPath()]) {
    assert.equal(statSync(path).mode & 0o777, 0o600, `${path} must be owner-only`);
  }
  // The receipt proves what was posted; the operator log does not repeat the signed URL.
  const receipt = JSON.parse(readFileSync(receiptsPath(), 'utf8').trim()) as { did: string; room: string; sanitized_text: string; sig: string };
  assert.equal(receipt.did, me.did);
  assert.equal(receipt.room, TESTNET.room);
  assert.equal(receipt.sanitized_text, `!faucet request ${ss58FromDid(me.did)} ${state.lastNonce}`);
  const logText = readFileSync(faucetLogPath(), 'utf8');
  assert.equal(logText.includes(receipt.sig), false);
  assert.equal(logText.includes('say-signed'), false);
  assert.equal(logText.includes('file passphrase'), false);

  // A second run inside the gap makes no request at all.
  const before = sent.length;
  assert.equal(await run(['claim'], (s) => lines.push(s), http, noSleep), EXIT.ok);
  assert.equal(sent.length, before);
  assert.match(lines.at(-1)!, /skip_recent_attempt/);
});

test('an unreadable state file stops the run instead of being treated as a clean slate', async () => {
  home();
  writeFileSync(faucetStatePath(), '{ truncated', { mode: 0o600 });
  const { http, sent } = fakeNetwork();
  const lines: string[] = [];
  assert.equal(await run(['claim'], (s) => lines.push(s), http, noSleep), EXIT.error);
  assert.match(lines.at(-1)!, /unreadable/);
  assert.equal(sent.length, 0);
});

test('balance reads the address derived from the local key', async () => {
  const me = home();
  const { http } = fakeNetwork();
  const lines: string[] = [];
  assert.equal(await run(['balance'], (s) => lines.push(s), http), EXIT.ok);
  assert.equal(lines[0], `${ss58FromDid(me.did)}: no account on chain yet (balance 0)`);
});

test('balance prints free and reserved FLOP for an explicit address', async () => {
  home();
  const u = (hex: string, bytes: number) => hex.padEnd(bytes * 2, '0');
  // nonce 3, then 10 FLOP free (0x8ac7230489e80000, little-endian), nothing reserved.
  const info = '0x' + u('03', 4) + u('', 12) + u('0000e8890423c78a', 16) + u('', 16) + u('', 32);
  const http: Http = async (_m, _url, body) =>
    (JSON.parse(body ?? '{}') as { method: string }).method === 'chain_getFinalizedHead'
      ? json({ result: '0x' + 'fe'.repeat(32) })
      : json({ result: info });
  const lines: string[] = [];
  assert.equal(await run(['balance', ALICE_SS58], (s) => lines.push(s), http), EXIT.ok);
  assert.match(lines[0], new RegExp(`^${ALICE_SS58}: free 10\\.000000 FLOP, reserved 0\\.000000 FLOP, nonce 3 `));
});

test('balance rejects a mistyped address without a request', async () => {
  home();
  let called = false;
  const http: Http = async () => { called = true; return json({}); };
  const lines: string[] = [];
  assert.equal(await run(['balance', ALICE_SS58.slice(0, -1) + 'X'], (s) => lines.push(s), http), EXIT.error);
  assert.match(lines[0], /Not a valid address/);
  assert.equal(called, false);
});
