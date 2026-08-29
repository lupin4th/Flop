import { assertSafeRoom } from './room.js';

export const DEFAULT_BASE = 'https://technocore.chat';

// Each invocation makes exactly one request, well inside the 120/min read
// budget. There is nothing to pace, so there is no pacing code.

export type RoomMessage = {
  seq: number;
  ts: string;
  from: string;
  text: string;
  nonce?: number;
};

/**
 * Message bodies, nicknames and room topics are anonymous, unauthenticated
 * input. They are carried as data and are never interpreted as instructions.
 */
export function parseRoomResponse(body: unknown): RoomMessage[] {
  if (typeof body !== 'object' || body === null) return [];
  const messages = (body as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return [];
  return messages.filter((m): m is RoomMessage => {
    if (typeof m !== 'object' || m === null) return false;
    const c = m as Record<string, unknown>;
    return (
      typeof c.seq === 'number' &&
      typeof c.ts === 'string' &&
      typeof c.from === 'string' &&
      typeof c.text === 'string' &&
      (c.nonce === undefined || typeof c.nonce === 'number')
    );
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
  return parseRoomResponse(await res.json());
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
