#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { fileURLToPath } from 'node:url';
import { resolve, join, dirname } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import {
  generateIdentity, saveIdentity, loadIdentity, identityExists, readStoredDid,
} from './keystore.js';
import {
  createReceipt, appendReceipt, loadReceipts, readReceiptLog, verifyReceipt,
} from './receipts.js';
import { archiveRoom, loadArchive, type ArchivedMessage } from './archive.js';
import { buildReport } from './report.js';
import { DEFAULT_BASE, fetchLatestSeq } from './client.js';
import { assertSafeRoom } from './room.js';
import { confirmRoom, loadConfirmations, unconfirmedReceipts } from './confirm.js';
import { runWatch } from './watch.js';
import { captureSelfEvidence, verifySelfEvidence } from './evidence.js';
import { decodeDidKey, encodeDidKey } from './didkey.js';

/**
 * Rooms captured by `mine` even if the user has never signed anything there
 * yet — the three rooms this project already cares about (see watch.ts).
 * `cmdMine` adds every room the user actually has a receipt for on top of
 * this, so the command follows the user's real footprint rather than a list
 * that goes stale.
 */
const DEFAULT_MINE_ROOMS = ['technocore', 'flop_labs', 'technocore-genesis'];

export type Io = {
  out: (s: string) => void;
  prompt: (question: string) => Promise<string>;
};

const USAGE = `Usage:
  technocore-attest keygen                 create and encrypt a local Ed25519 identity
  technocore-attest sign <room> <text>     sign a message and print its post URL
  technocore-attest receipts verify        re-verify every stored receipt offline
  technocore-attest archive <room>         snapshot a room before its ring buffer drops it
  technocore-attest confirm <room>         watch a room and confirm the server served your unconfirmed messages
  technocore-attest report                 summarise receipts and archives
  technocore-attest watch                  one-shot check of GitHub, flop.finance and chat for a testnet/faucet announcement
  technocore-attest mine [--did <did>] [--out <path>]
                                            capture and commit self-checking evidence of your own presence

This tool never sends a message for you. \`sign\` prints a URL; opening it is your call.
Never paste a private key, seed phrase or API key into a public room.`;

async function cmdKeygen(io: Io): Promise<number> {
  if (identityExists()) {
    io.out('An identity already exists. Refusing to overwrite it.');
    return 1;
  }
  const a = await io.prompt('Passphrase for the new key: ');
  const b = await io.prompt('Repeat the passphrase: ');
  if (a !== b) {
    io.out('The two entries did not match. Nothing was written.');
    return 1;
  }
  if (a.length === 0) {
    io.out('An empty passphrase is not allowed. Nothing was written.');
    return 1;
  }
  const { did, privateKey } = generateIdentity();
  saveIdentity(privateKey, did, a);
  io.out(`Created ${did}`);
  io.out('The encrypted key is the only copy. Back it up; it cannot be recovered.');
  return 0;
}

async function cmdSign(io: Io, room: string, text: string): Promise<number> {
  try {
    assertSafeRoom(room);
  } catch (err) {
    io.out(err instanceof Error ? err.message : String(err));
    return 1;
  }
  if (!identityExists()) {
    io.out('No identity yet. Run `technocore-attest keygen` first.');
    return 1;
  }
  const pass = await io.prompt('Passphrase: ');
  const { did, privateKey } = loadIdentity(pass);
  const receipt = createReceipt(privateKey, did, room, text, DEFAULT_BASE, loadReceipts());
  appendReceipt(receipt);
  io.out(`Signed as ${did}`);
  io.out(`Nonce ${receipt.nonce}`);
  io.out('');
  io.out(receipt.url);
  io.out('');
  io.out('This URL has NOT been sent. Open it yourself to post the message.');
  io.out('The receipt is saved, so this message stays provable after the room drops it.');
  return 0;
}

function cmdReceiptsVerify(io: Io): number {
  const { receipts, malformed } = readReceiptLog();
  const ok = receipts.filter(verifyReceipt).length;
  io.out(`${receipts.length} receipt(s): ${ok} verified, ${receipts.length - ok} FAILED`);
  if (malformed > 0) {
    io.out(
      `WARNING: ${malformed} line(s) in the receipt log could not be read and were skipped. Those receipts are lost; the file may have been truncated by an interrupted write.`,
    );
    return 1;
  }
  return receipts.length === ok ? 0 : 1;
}

async function cmdArchive(io: Io, room: string): Promise<number> {
  const { path, written } = await archiveRoom(room);
  io.out(`Archived ${written} new message(s) to ${path}`);
  return 0;
}

async function cmdConfirm(io: Io, room: string): Promise<number> {
  try {
    assertSafeRoom(room);
  } catch (err) {
    io.out(err instanceof Error ? err.message : String(err));
    return 1;
  }
  const receipts = loadReceipts();
  const { confirmations } = loadConfirmations();
  const targets = unconfirmedReceipts(room, receipts, confirmations);
  if (targets.length === 0) {
    io.out(`No unconfirmed receipts for ${room}.`);
    return 0;
  }
  const watermark = await fetchLatestSeq(room, { base: DEFAULT_BASE });
  io.out(`Watching ${room} from seq ${watermark}.`);
  io.out('Open your post URL now.');
  const { found, timedOut, errors } = await confirmRoom(room, receipts, { base: DEFAULT_BASE });
  for (const c of found) {
    io.out(`Confirmed nonce ${c.nonce} at seq ${c.seq}`);
  }
  if (errors > 0) {
    io.out(`${errors} poll(s) failed during the watch (server errors); the watch continued.`);
  }
  if (timedOut) {
    const { confirmations: after } = loadConfirmations();
    const stillUnconfirmed = unconfirmedReceipts(room, receipts, after);
    io.out(`Timed out waiting for the server. Still unconfirmed (${stillUnconfirmed.length}):`);
    for (const r of stillUnconfirmed) {
      io.out(`  nonce ${r.nonce}`);
    }
    return 1;
  }
  return 0;
}

async function cmdWatch(io: Io): Promise<number> {
  const { findings, baselined } = await runWatch();
  const baselineParts: string[] = [];
  if (baselined.github) baselineParts.push(`github (${baselined.repoCount} repos)`);
  if (baselined.rooms.length > 0) baselineParts.push(`rooms (${baselined.rooms.length} rooms)`);
  if (baselineParts.length > 0) {
    io.out(`Baselined ${baselineParts.join(', ')} — no comparison possible on first run.`);
  }
  if (findings.length === 0) {
    io.out('No changes detected on GitHub, flop.finance or the watched rooms.');
    return 0;
  }
  const official = findings.filter((f) => f.trust === 'official');
  const unverified = findings.filter((f) => f.trust === 'unverified');
  if (official.length > 0) {
    io.out('## Official (GitHub / flop.finance)');
    for (const f of official) {
      io.out(`- ${f.summary} (${f.detail})`);
    }
  }
  if (unverified.length > 0) {
    if (official.length > 0) io.out('');
    io.out('## Unverified chat chatter — unconfirmed by any official source, proves nothing on its own');
    for (const f of unverified) {
      io.out(`- ${f.summary} (${f.detail})`);
    }
  }
  return 10;
}

/**
 * Resolves the DID `mine` should use, in order:
 *   1. `--did` on the command line (explicitDid, whatever its value — even
 *      an empty string counts as "supplied", so it fails validation loudly
 *      rather than silently falling through to the next source)
 *   2. the `TECHNOCORE_DID` environment variable, by the same rule
 *   3. the local keystore (`readStoredDid`), for interactive use
 * `mine` never needs the passphrase or the private key — only this public
 * value — which is what lets a CI runner with no key file on it run `mine`
 * at all.
 */
function resolveMineDid(explicitDid: string | undefined): string | undefined {
  if (explicitDid !== undefined) return explicitDid;
  const envDid = process.env.TECHNOCORE_DID;
  if (envDid !== undefined) return envDid;
  return readStoredDid();
}

/**
 * Reads only: the DID either comes straight from the key file's plaintext
 * `did` field (see `readStoredDid`) or is handed to us explicitly via
 * `--did`/`TECHNOCORE_DID` — either way nothing here decrypts the private
 * key, prompts for a passphrase, or signs anything. `captureSelfEvidence` in
 * turn only reads `/export`. Nothing this command touches can post to
 * technocore.
 */
async function cmdMine(io: Io, outPath?: string, explicitDid?: string): Promise<number> {
  const did = resolveMineDid(explicitDid);
  if (!did) {
    io.out(
      'No identity found. Run `technocore-attest keygen` first, or pass the public DID explicitly with `--did <did>` or the TECHNOCORE_DID environment variable — `mine` only needs the public DID, never the passphrase or the private key.',
    );
    return 1;
  }
  try {
    const raw = decodeDidKey(did);
    if (encodeDidKey(raw) !== did) {
      throw new Error('does not round-trip through its own encoding');
    }
  } catch (err) {
    io.out(`Malformed DID ${JSON.stringify(did)}: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  const receipts = loadReceipts();
  const rooms = [...new Set([...DEFAULT_MINE_ROOMS, ...receipts.map((r) => r.room)])];
  const evidence = await captureSelfEvidence(did, rooms, { base: DEFAULT_BASE });

  const path = outPath ?? join('evidence', `${new Date().toISOString().slice(0, 10)}.json`);
  const dir = dirname(path);
  if (dir && dir !== '.') mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(evidence, null, 2) + '\n');

  const failedRooms = evidence.rooms.filter((r) => r.message_count === -1).map((r) => r.room);
  const ownMessages = evidence.rooms.reduce((sum, r) => sum + r.mine.length, 0);
  const { checked, valid, invalid } = verifySelfEvidence(evidence);

  io.out(
    `${evidence.rooms.length} room(s) captured, ${ownMessages} own message(s) found, ${valid}/${checked} signature(s) valid.`,
  );
  if (failedRooms.length > 0) {
    io.out(`Could not reach: ${failedRooms.join(', ')} (recorded, not fatal to the others).`);
  }
  io.out(`Wrote ${path}`);

  if (invalid.length > 0) {
    io.out(`FAILED verification for: ${invalid.join(', ')} — the captured artifact is corrupt.`);
    return 1;
  }
  return 0;
}

function cmdReport(io: Io): number {
  const { receipts, malformed } = readReceiptLog();
  const { confirmations } = loadConfirmations();
  const rooms = [...new Set(receipts.map((r) => r.room))];
  const archives: Record<string, ArchivedMessage[]> = {};
  for (const room of rooms) {
    const rows = loadArchive(room);
    if (rows.length) archives[room] = rows;
  }
  io.out(buildReport(receipts, archives, malformed, confirmations));
  return 0;
}

export async function run(argv: string[], io: Io): Promise<number> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case 'keygen':
      return cmdKeygen(io);
    case 'sign':
      if (rest.length < 2) {
        io.out(USAGE);
        return 1;
      }
      return cmdSign(io, rest[0], rest.slice(1).join(' '));
    case 'receipts':
      if (rest[0] !== 'verify') {
        io.out(USAGE);
        return 1;
      }
      return cmdReceiptsVerify(io);
    case 'archive':
      if (rest.length < 1) {
        io.out(USAGE);
        return 1;
      }
      return cmdArchive(io, rest[0]);
    case 'confirm':
      if (rest.length < 1) {
        io.out(USAGE);
        return 1;
      }
      return cmdConfirm(io, rest[0]);
    case 'report':
      return cmdReport(io);
    case 'watch':
      return cmdWatch(io);
    case 'mine': {
      const outIdx = rest.indexOf('--out');
      const out = outIdx !== -1 ? rest[outIdx + 1] : undefined;
      const didIdx = rest.indexOf('--did');
      const did = didIdx !== -1 ? (rest[didIdx + 1] ?? '') : undefined;
      return cmdMine(io, out, did);
    }
    default:
      io.out(USAGE);
      return 1;
  }
}

// Passphrases are read interactively so they never land in shell history
// or the process table.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const rl = createInterface({ input: stdin, output: stdout });
  run(process.argv.slice(2), {
    out: (s) => console.log(s),
    prompt: (q) => rl.question(q),
  })
    .then((code) => {
      rl.close();
      process.exit(code);
    })
    .catch((err) => {
      rl.close();
      console.error(String(err instanceof Error ? err.message : err));
      process.exit(1);
    });
}
