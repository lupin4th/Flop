import { assertSafeRoom } from './room.js';

export const DEFAULT_BASE = 'https://technocore.chat';

// Each invocation makes exactly one request, well inside the 120/min read
// budget. There is nothing to pace, so there is no pacing code.

export type RoomMessage = {
  seq: number;
  ts: string;
  from: string;
  text: string;
  /**
   * The exact decimal digits of the nonce, always as a string. Some agents
   * mint nonces from a nanosecond clock (e.g. `1789348196321255900`), well
   * past `Number.MAX_SAFE_INTEGER` — a plain JS number would have already
   * been rounded by `JSON.parse` before we ever saw it. Keeping this as text
   * end to end is what lets `matchesReceipt`/`labelMessage` and the signing
   * payload reconstruct the exact bytes the server signed over.
   */
  nonce?: string;
};

type RawMessageShape = {
  seq: number;
  ts: string;
  from: string;
  text: string;
  nonce?: number | string;
};

function isRawMessageShape(m: unknown): m is RawMessageShape {
  if (typeof m !== 'object' || m === null) return false;
  const c = m as Record<string, unknown>;
  return (
    typeof c.seq === 'number' &&
    typeof c.ts === 'string' &&
    typeof c.from === 'string' &&
    typeof c.text === 'string' &&
    (c.nonce === undefined || typeof c.nonce === 'number' || typeof c.nonce === 'string')
  );
}

/**
 * Message bodies, nicknames and room topics are anonymous, unauthenticated
 * input. They are carried as data and are never interpreted as instructions.
 *
 * `rawNonceTexts`, when given, is the ordered list of nonce digit strings
 * recovered straight from the response's raw text — before `JSON.parse` had
 * a chance to round any of them. It is used only when its length matches the
 * number of shaped messages that carry a nonce; a mismatch means the raw
 * text couldn't be paired up with confidence, so this falls back to the
 * (possibly already-rounded) parsed value rather than risk mispairing a
 * nonce onto the wrong message.
 */
export function parseRoomResponse(body: unknown, rawNonceTexts?: string[]): RoomMessage[] {
  if (typeof body !== 'object' || body === null) return [];
  const messages = (body as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return [];
  const shaped = messages.filter(isRawMessageShape);

  const nonceIndexes: number[] = [];
  shaped.forEach((m, i) => {
    if (m.nonce !== undefined) nonceIndexes.push(i);
  });
  const useRaw = rawNonceTexts !== undefined && rawNonceTexts.length === nonceIndexes.length;

  return shaped.map((m, i) => {
    const out: RoomMessage = { seq: m.seq, ts: m.ts, from: m.from, text: m.text };
    if (m.nonce !== undefined) {
      const pos = nonceIndexes.indexOf(i);
      out.nonce = useRaw ? rawNonceTexts![pos] : String(m.nonce);
    }
    return out;
  });
}

/** The server's documented long-poll wait range, in seconds. */
const MIN_WAIT = 0;
const MAX_WAIT = 10;

export async function fetchRoom(
  room: string,
  opts: {
    base?: string;
    limit?: number;
    since?: number;
    wait?: number;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<RoomMessage[]> {
  assertSafeRoom(room);
  const base = opts.base ?? DEFAULT_BASE;
  const doFetch = opts.fetchImpl ?? fetch;
  const url = new URL(`${base}/r/${room}`);
  url.searchParams.set('format', 'json');
  url.searchParams.set('limit', String(opts.limit ?? 200));
  if (opts.since !== undefined) url.searchParams.set('since', String(opts.since));
  if (opts.wait !== undefined) {
    const clamped = Math.min(MAX_WAIT, Math.max(MIN_WAIT, opts.wait));
    url.searchParams.set('wait', String(clamped));
  }
  const res = await doFetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`GET ${url.pathname} failed: ${res.status}`);
  // Read the raw text rather than `res.json()`. A nonce minted from a
  // nanosecond clock can exceed Number.MAX_SAFE_INTEGER, and `res.json()`
  // would silently round it via JSON.parse before our code ever sees it.
  // The raw text still has the exact digits, recovered below by regex.
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`GET ${url.pathname} returned a non-JSON body`);
  }
  const rawNonceTexts = [...text.matchAll(/"nonce"\s*:\s*(\d+)/g)].map((m) => m[1]);
  return parseRoomResponse(body, rawNonceTexts);
}

/**
 * The newest seq currently in the room, without pulling the full 200-message
 * window. Used to establish a watermark before long-polling forward from it.
 */
export async function fetchLatestSeq(
  room: string,
  opts: { base?: string; fetchImpl?: typeof fetch } = {},
): Promise<number> {
  const messages = await fetchRoom(room, { ...opts, limit: 1 });
  return messages.reduce((max, m) => (m.seq > max ? m.seq : max), 0);
}
