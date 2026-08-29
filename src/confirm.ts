import { fetchRoom, fetchLatestSeq, type RoomMessage } from './client.js';
import { verifyReceipt, type Receipt } from './receipts.js';
import { confirmationsPath, ensureHome } from './paths.js';
import { appendJsonLine, readJsonLines } from './jsonl.js';

/**
 * A confirmation is weaker evidence than a receipt: `seq` and `server_ts`
 * are assigned by the server, observed over an unauthenticated read API, and
 * are never signed by anyone. They record only that the server was seen
 * serving this exact message at this seq — not that the message is
 * authentic beyond what the receipt's own signature already proves.
 */
export type Confirmation = {
  v: 1;
  did: string;
  room: string;
  nonce: number;
  sig: string;
  seq: number;
  server_ts: string;
  confirmed_at: string;
};

/**
 * Whether a room message is the one a given receipt attests to. Shared by
 * `labelMessage` in archive.ts (was this message ours?) and `confirmRoom`
 * below (did the server serve the message we just signed?), so the match
 * condition lives in exactly one place rather than being written twice.
 */
export function matchesReceipt(m: RoomMessage, r: Receipt): boolean {
  return (
    r.did === m.from &&
    r.nonce === m.nonce &&
    r.sanitized_text === m.text &&
    verifyReceipt(r)
  );
}

function isConfirmation(value: unknown): value is Confirmation {
  if (typeof value !== 'object' || value === null) return false;
  const c = value as Record<string, unknown>;
  return (
    c.v === 1 &&
    typeof c.did === 'string' &&
    typeof c.room === 'string' &&
    typeof c.nonce === 'number' &&
    typeof c.sig === 'string' &&
    typeof c.seq === 'number' &&
    typeof c.server_ts === 'string' &&
    typeof c.confirmed_at === 'string'
  );
}

export function loadConfirmations(): { confirmations: Confirmation[]; malformed: number } {
  const { records, malformed } = readJsonLines(confirmationsPath(), isConfirmation);
  return { confirmations: records, malformed };
}

export function appendConfirmation(c: Confirmation): void {
  ensureHome();
  appendJsonLine(confirmationsPath(), c, { mode: 0o600 });
}

function receiptKey(x: { did: string; room: string; nonce: number; sig: string }): string {
  return `${x.did}|${x.room}|${x.nonce}|${x.sig}`;
}

/** Receipts in `room` that have no matching entry in `confirmations` yet. */
export function unconfirmedReceipts(
  room: string,
  receipts: Receipt[],
  confirmations: Confirmation[],
): Receipt[] {
  const confirmed = new Set(confirmations.map(receiptKey));
  return receipts.filter((r) => r.room === room && !confirmed.has(receiptKey(r)));
}

/**
 * Watches a room forward from its current newest seq, long-polling until
 * every unconfirmed receipt for that room is seen served by the server, or
 * the deadline passes. Starting the watermark before the caller posts is
 * what makes this safe against the room's ~10-second retention window: by
 * the time the message is posted, the watch is already ahead of it.
 */
export async function confirmRoom(
  room: string,
  receipts: Receipt[],
  opts: {
    base?: string;
    timeoutMs?: number;
    nowMs?: () => number;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<{ found: Confirmation[]; watched: number; timedOut: boolean }> {
  const nowMs = opts.nowMs ?? Date.now;
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const { base, fetchImpl } = opts;
  const deadline = nowMs() + timeoutMs;

  const { confirmations: existing } = loadConfirmations();
  const targets = unconfirmedReceipts(room, receipts, existing);
  const found: Confirmation[] = [];
  let watched = 0;

  if (targets.length === 0) {
    return { found, watched, timedOut: false };
  }

  let watermark = await fetchLatestSeq(room, { base, fetchImpl });

  while (targets.length > 0) {
    if (nowMs() >= deadline) {
      return { found, watched, timedOut: true };
    }
    const messages = await fetchRoom(room, { base, since: watermark, wait: 10, fetchImpl });
    watched += messages.length;
    for (const m of messages) {
      if (m.seq > watermark) watermark = m.seq;
      const idx = targets.findIndex((r) => matchesReceipt(m, r));
      if (idx === -1) continue;
      const r = targets[idx];
      const confirmation: Confirmation = {
        v: 1,
        did: r.did,
        room: r.room,
        nonce: r.nonce,
        sig: r.sig,
        seq: m.seq,
        server_ts: m.ts,
        confirmed_at: new Date(nowMs()).toISOString(),
      };
      appendConfirmation(confirmation);
      found.push(confirmation);
      targets.splice(idx, 1);
    }
  }

  return { found, watched, timedOut: false };
}
