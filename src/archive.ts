import { appendFileSync, readFileSync, existsSync, mkdirSync, readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { archiveDir, ensureHome } from './paths.js';
import { fetchRoom, type RoomMessage } from './client.js';
import { loadReceipts, verifyReceipt, type Receipt } from './receipts.js';

/**
 * The server discards the signature after checking it, so a reader cannot
 * re-verify anyone else's message offline. Saying "verified" about someone
 * else's message would overstate what this tool can prove.
 */
export type Trust = 'self_verified' | 'server_attested' | 'unsigned';

export type ArchivedMessage = RoomMessage & { trust: Trust };

export function labelMessage(m: RoomMessage, receipts: Receipt[]): Trust {
  if (!m.from.startsWith('did:key:')) return 'unsigned';
  const mine = receipts.find(
    (r) =>
      r.did === m.from &&
      r.nonce === m.nonce &&
      r.sanitized_text === m.text &&
      verifyReceipt(r),
  );
  return mine ? 'self_verified' : 'server_attested';
}

function dayFile(room: string): string {
  const day = new Date().toISOString().slice(0, 10);
  return join(archiveDir(room), `${day}.jsonl`);
}

function seenSeqs(room: string): Set<number> {
  return new Set(loadArchive(room).map((m) => m.seq));
}

function ensureNewlineBeforeAppend(path: string): void {
  if (existsSync(path)) {
    const { size } = statSync(path);
    if (size > 0) {
      const fd = openSync(path, 'r');
      try {
        const tail = Buffer.alloc(1);
        readSync(fd, tail, 0, 1, size - 1);
        if (tail[0] !== 0x0a) appendFileSync(path, '\n');
      } finally {
        closeSync(fd);
      }
    }
  }
}

export async function archiveRoom(
  room: string,
  opts: { base?: string; limit?: number; fetchImpl?: typeof fetch } = {},
): Promise<{ path: string; written: number }> {
  const messages = await fetchRoom(room, opts);
  const receipts = loadReceipts();
  ensureHome();
  mkdirSync(archiveDir(room), { recursive: true, mode: 0o700 });
  const seen = seenSeqs(room);
  const path = dayFile(room);
  let written = 0;
  for (const m of messages) {
    if (seen.has(m.seq)) continue;
    ensureNewlineBeforeAppend(path);
    const row: ArchivedMessage = { ...m, trust: labelMessage(m, receipts) };
    appendFileSync(path, JSON.stringify(row) + '\n');
    written++;
  }
  return { path, written };
}

function isArchivedMessage(value: unknown): value is ArchivedMessage {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.seq === 'number' &&
    typeof obj.trust === 'string' &&
    (obj.trust === 'self_verified' || obj.trust === 'server_attested' || obj.trust === 'unsigned')
  );
}

export function loadArchive(room: string): ArchivedMessage[] {
  const dir = archiveDir(room);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .sort()
    .flatMap((f) => {
      const messages: ArchivedMessage[] = [];
      for (const line of readFileSync(join(dir, f), 'utf8').split('\n')) {
        if (line.trim() === '') continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        if (isArchivedMessage(parsed)) messages.push(parsed);
      }
      return messages;
    });
}
