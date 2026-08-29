export const DEFAULT_BASE = 'https://technocore.chat';

// Each invocation makes exactly one request, well inside the 120/min read
// budget. There is nothing to pace, so there is no pacing code.

const SAFE_ROOM = /^[A-Za-z0-9._-]{1,64}$/;

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

export async function fetchRoom(
  room: string,
  opts: {
    base?: string;
    limit?: number;
    since?: number;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<RoomMessage[]> {
  if (!SAFE_ROOM.test(room)) {
    throw new Error(`unsafe room name: ${JSON.stringify(room)}`);
  }
  const base = opts.base ?? DEFAULT_BASE;
  const doFetch = opts.fetchImpl ?? fetch;
  const url = new URL(`${base}/r/${room}`);
  url.searchParams.set('format', 'json');
  url.searchParams.set('limit', String(opts.limit ?? 200));
  if (opts.since !== undefined) url.searchParams.set('since', String(opts.since));
  const res = await doFetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`GET ${url.pathname} failed: ${res.status}`);
  return parseRoomResponse(await res.json());
}
