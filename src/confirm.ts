import { fetchRoom, fetchLatestSeq, type RoomMessage } from './client.js';
import { verifyReceipt, type Receipt } from './receipts.js';
import { confirmationsPath, ensureHome } from './paths.js';
import { appendJsonLine, readJsonLines } from './jsonl.js';
import { assertSafeRoom } from './room.js';

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

const DEFAULT_MIN_INTERVAL_MS = 1000;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Watches a room forward from its current newest seq, long-polling until
 * every unconfirmed receipt for that room is seen served by the server, or
 * the deadline passes. Starting the watermark before the caller posts is
 * what makes this safe against the room's ~10-second retention window: by
 * the time the message is posted, the watch is already ahead of it.
 *
 * The server is not assumed to be well-behaved: `technocore.chat` has been
 * observed answering with a 503, and separately with a 200 and a non-JSON
 * body. Neither is treated as fatal — each failed round is counted and the
 * loop keeps going until the deadline, so a transient blip does not cost
 * the user the confirmation window they are relying on this command for.
 *
 * `minIntervalMs` bounds the request rate against a server that answers
 * instantly (exactly the case when it is degraded and erroring): a poll
 * round that returns faster than `minIntervalMs` is padded out with a
 * `sleep` before the next one, so a broken `wait=` on the server side can
 * never turn this into a hot loop against the 120-request/minute budget.
 */
export async function confirmRoom(
  room: string,
  receipts: Receipt[],
  opts: {
    base?: string;
    timeoutMs?: number;
    minIntervalMs?: number;
    nowMs?: () => number;
    sleep?: (ms: number) => Promise<void>;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<{ found: Confirmation[]; watched: number; timedOut: boolean; errors: number }> {
  // An unsafe room name is not a transient condition — it must never be
  // retried, so it is validated up front, outside any try/catch below.
  assertSafeRoom(room);

  const nowMs = opts.nowMs ?? Date.now;
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const minIntervalMs = opts.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
  const sleep = opts.sleep ?? defaultSleep;
  const { base, fetchImpl } = opts;
  const deadline = nowMs() + timeoutMs;

  const { confirmations: existing } = loadConfirmations();
  const targets = unconfirmedReceipts(room, receipts, existing);
  const found: Confirmation[] = [];
  let watched = 0;
  let errors = 0;

  if (targets.length === 0) {
    return { found, watched, timedOut: false, errors };
  }

  const pace = async (roundStart: number): Promise<void> => {
    const elapsed = nowMs() - roundStart;
    if (elapsed < minIntervalMs) await sleep(minIntervalMs - elapsed);
  };

  let watermark = 0;
  let haveWatermark = false;
  while (!haveWatermark) {
    if (nowMs() >= deadline) {
      return { found, watched, timedOut: true, errors };
    }
    const roundStart = nowMs();
    try {
      watermark = await fetchLatestSeq(room, { base, fetchImpl });
      haveWatermark = true;
    } catch {
      errors++;
    }
    await pace(roundStart);
  }

  while (targets.length > 0) {
    if (nowMs() >= deadline) {
      return { found, watched, timedOut: true, errors };
    }
    const roundStart = nowMs();
    let messages: RoomMessage[];
    try {
      messages = await fetchRoom(room, { base, since: watermark, wait: 10, fetchImpl });
    } catch {
      errors++;
      await pace(roundStart);
      continue;
    }
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
    await pace(roundStart);
  }

  return { found, watched, timedOut: false, errors };
}
