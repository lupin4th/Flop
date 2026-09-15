import { createHash } from 'node:crypto';
import { exportRoomWithBody, type ExportedMessage } from './client.js';
import { verifyPayload } from './verify.js';

// This module never imports keystore.js: capturing self-evidence reads the
// server's export and filters by a DID string the caller already has. It
// has no path to the private key and cannot sign anything.

export type RoomCapture = {
  room: string;
  first_seq: number;
  last_seq: number;
  /** Total messages in the room's export, not just ours. -1 means the room
   * failed to fetch or parse; `mine` is then empty rather than partial. */
  message_count: number;
  /** sha256 of the exact export response body this capture read. */
  export_sha256: string;
  mine: ExportedMessage[];
};

export type SelfEvidence = {
  v: 1;
  did: string;
  captured_at: string;
  rooms: RoomCapture[];
};

function emptyCapture(room: string): RoomCapture {
  return { room, first_seq: 0, last_seq: 0, message_count: -1, export_sha256: '', mine: [] };
}

async function captureRoom(
  room: string,
  did: string,
  opts: { base?: string; fetchImpl?: typeof fetch },
): Promise<RoomCapture> {
  // A dead or misbehaving room must cost only that room's capture, never the
  // others — the same posture confirmRoom and runWatch take toward a
  // degraded server, applied here to a whole room's export instead of one
  // poll.
  let body: string;
  let messages: ExportedMessage[];
  try {
    ({ body, messages } = await exportRoomWithBody(room, opts));
  } catch {
    return emptyCapture(room);
  }

  if (messages.length === 0) {
    return { room, first_seq: 0, last_seq: 0, message_count: 0, export_sha256: hash(body), mine: [] };
  }

  let first_seq = messages[0].seq;
  let last_seq = messages[0].seq;
  for (const m of messages) {
    if (m.seq < first_seq) first_seq = m.seq;
    if (m.seq > last_seq) last_seq = m.seq;
  }

  return {
    room,
    first_seq,
    last_seq,
    message_count: messages.length,
    export_sha256: hash(body),
    mine: messages.filter((m) => m.from === did),
  };
}

function hash(body: string): string {
  return createHash('sha256').update(body).digest('hex');
}

/**
 * Captures durable, self-checking evidence of our own presence across
 * `rooms`: for each room, the full export is read once, hashed, and reduced
 * to only the messages `from` our own DID (everyone else's messages are
 * dropped — this is what keeps a season of captures small enough to commit).
 * One room's failure is recorded, not fatal to the rest (see `captureRoom`).
 */
export async function captureSelfEvidence(
  did: string,
  rooms: string[],
  opts: { base?: string; fetchImpl?: typeof fetch; nowMs?: () => number } = {},
): Promise<SelfEvidence> {
  const nowMs = opts.nowMs ?? Date.now;
  const captured: RoomCapture[] = [];
  for (const room of rooms) {
    captured.push(await captureRoom(room, did, opts));
  }
  return {
    v: 1,
    did,
    captured_at: new Date(nowMs()).toISOString(),
    rooms: captured,
  };
}

/**
 * Re-checks every stored message's signature offline. This is what makes a
 * captured evidence file self-checking rather than merely self-reported: a
 * verifier does not need to trust this tool, only run this function over the
 * committed JSON.
 */
export function verifySelfEvidence(
  e: SelfEvidence,
): { checked: number; valid: number; invalid: string[] } {
  let checked = 0;
  let valid = 0;
  const invalid: string[] = [];
  for (const room of e.rooms) {
    for (const m of room.mine) {
      checked++;
      const ok =
        m.nonce !== undefined &&
        m.sig !== undefined &&
        verifyPayload(m.from, room.room, m.nonce, m.text, m.sig);
      if (ok) {
        valid++;
      } else {
        invalid.push(`${room.room}#${m.seq}`);
      }
    }
  }
  return { checked, valid, invalid };
}
