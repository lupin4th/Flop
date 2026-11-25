#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { loadIdentity, readStoredDid } from './keystore.js';
import { createReceipt, appendReceipt, loadReceipts } from './receipts.js';
import { appendJsonLine } from './jsonl.js';
import { ensureHome, faucetStatePath, faucetLogPath } from './paths.js';
import { readPassphraseFile } from './passphrase.js';
import { httpsRequest, type Http } from './http.js';
import { fetchBalance, formatFlop } from './chain.js';
import { ss58FromDid, ss58Decode } from './ss58.js';
import { runClaim, TESTNET, EXIT, type FaucetState } from './faucet.js';

// The unattended agent. It is a separate program from `technocore-attest`
// on purpose: that CLI never sends anything and always asks for the
// passphrase at the keyboard, and both of those promises would be false
// here. Running this file is the explicit opt-in to a program that reads
// the passphrase from a file and posts on its owner's behalf.

const USAGE = `Usage:
  agent claim [--dry-run] [--force]   request the daily FLOP testnet faucet grant
  agent balance [<address>]           show an account's testnet balance (read-only)

\`claim\` signs with the local key, using the passphrase file in the attest
home (mode 600), and posts one request to the public faucet room. It acts at
most once per 23 hours unless --force is given. Set TECHNOCORE_DID to refuse
to sign with any key but that one. --dry-run runs every check and shows what
would be sent, without sending.`;

type Out = (line: string) => void;

function loadState(): FaucetState {
  if (!existsSync(faucetStatePath())) return {};
  try {
    const parsed = JSON.parse(readFileSync(faucetStatePath(), 'utf8')) as unknown;
    return typeof parsed === 'object' && parsed !== null ? (parsed as FaucetState) : {};
  } catch {
    // An unreadable state file must not turn into "no attempt was ever made".
    throw new Error(`${faucetStatePath()} is unreadable; fix or remove it before claiming`);
  }
}

function saveState(state: FaucetState): void {
  ensureHome();
  const tmp = `${faucetStatePath()}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 1) + '\n', { mode: 0o600 });
  renameSync(tmp, faucetStatePath());
}

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function cmdClaim(
  out: Out,
  flags: { dryRun: boolean; force: boolean },
  http: Http = httpsRequest,
  sleep: (ms: number) => Promise<void> = realSleep,
): Promise<number> {
  const log = (event: string, data: Record<string, unknown>): void => {
    const ts = new Date().toISOString();
    out(`[${ts}] ${event} ${JSON.stringify(data)}`);
    if (!flags.dryRun) {
      ensureHome();
      appendJsonLine(faucetLogPath(), { ts, event, ...data }, { mode: 0o600 });
    }
  };
  try {
    const { code } = await runClaim(
      {
        http,
        sleep,
        now: () => Date.now(),
        log,
        loadState,
        saveState,
        loadIdentity: () => loadIdentity(readPassphraseFile()),
        signChatRequest: (privateKey, did, room, text) => {
          const receipt = createReceipt(privateKey, did, room, text, TESTNET.chatBase, loadReceipts());
          appendReceipt(receipt);
          return receipt.url;
        },
      },
      { dryRun: flags.dryRun, force: flags.force, expectedDid: process.env.TECHNOCORE_DID },
    );
    return code;
  } catch (err) {
    log('error', { message: err instanceof Error ? err.message : String(err) });
    return EXIT.error;
  }
}

export async function cmdBalance(
  out: Out,
  addressArg: string | undefined,
  http: Http = httpsRequest,
): Promise<number> {
  let address = addressArg;
  if (address === undefined) {
    const did = process.env.TECHNOCORE_DID ?? readStoredDid();
    if (!did) {
      out('No address given and no local identity found.');
      return EXIT.error;
    }
    address = ss58FromDid(did);
  }
  try {
    ss58Decode(address);
  } catch (err) {
    out(`Not a valid address: ${err instanceof Error ? err.message : String(err)}`);
    return EXIT.error;
  }
  const { finalized, account } = await fetchBalance(http, TESTNET.rpcUrl, address);
  if (account === null) {
    out(`${address}: no account on chain yet (balance 0)`);
    return EXIT.ok;
  }
  out(
    `${address}: free ${formatFlop(account.free)} FLOP, reserved ${formatFlop(account.reserved)} FLOP, ` +
      `nonce ${account.nonce} (finalized block ${finalized.slice(0, 14)}…)`,
  );
  return EXIT.ok;
}

export async function run(
  argv: string[],
  out: Out,
  http: Http = httpsRequest,
  sleep: (ms: number) => Promise<void> = realSleep,
): Promise<number> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case 'claim': {
      const known = new Set(['--dry-run', '--force']);
      const unknown = rest.filter((a) => !known.has(a));
      if (unknown.length > 0) {
        out(`Unknown option: ${unknown.join(' ')}`);
        out(USAGE);
        return EXIT.error;
      }
      return cmdClaim(out, { dryRun: rest.includes('--dry-run'), force: rest.includes('--force') }, http, sleep);
    }
    case 'balance':
      if (rest.length > 1) {
        out(USAGE);
        return EXIT.error;
      }
      return cmdBalance(out, rest[0], http);
    default:
      out(USAGE);
      return EXIT.error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run(process.argv.slice(2), (s) => console.log(s))
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(String(err instanceof Error ? err.message : err));
      process.exit(EXIT.error);
    });
}
