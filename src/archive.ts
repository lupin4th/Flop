import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { archiveDir, ensureHome } from './paths.js';
import { fetchRoom, type RoomMessage } from './client.js';
import { loadReceipts, type Receipt } from './receipts.js';
import { appendJsonLine, readJsonLines } from './jsonl.js';
import { matchesReceipt } from './confirm.js';

/**
 * The server discards the signature after checking it, so a reader cannot
 * re-verify anyone else's message offline. Saying "verified" about someone
 * else's message would overstate what this tool can prove.
 */
export type Trust = 'self_verified' | 'server_attested' | 'unsigned';

export type ArchivedMessage = RoomMessage & { trust: Trust };

export function labelMessage(m: RoomMessage, receipts: Receipt[]): Trust {
  if (!m.from.startsWith('did:key:')) return 'unsigned';
  const mine = receipts.find((r) => matchesReceipt(m, r));
  return mine ? 'self_verified' : 'server_attested';
}

function dayFile(room: string): string {
  const day = new Date().toISOString().slice(0, 10);
  return join(archiveDir(room), `${day}.jsonl`);
}

function seenSeqs(room: string): Set<number> {
  return new Set(loadArchive(room).map((m) => m.seq));
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
    const row: ArchivedMessage = { ...m, trust: labelMessage(m, receipts) };
    appendJsonLine(path, row);
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
    .flatMap((f) => readJsonLines(join(dir, f), isArchivedMessage).records);
}
