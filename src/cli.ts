#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { generateIdentity, saveIdentity, loadIdentity, identityExists } from './keystore.js';
import {
  createReceipt, appendReceipt, loadReceipts, readReceiptLog, verifyReceipt,
} from './receipts.js';
import { archiveRoom, loadArchive, type ArchivedMessage } from './archive.js';
import { buildReport } from './report.js';
import { DEFAULT_BASE, fetchLatestSeq } from './client.js';
import { assertSafeRoom } from './room.js';
import { confirmRoom, loadConfirmations, unconfirmedReceipts } from './confirm.js';

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
