import { appendFileSync, readFileSync, existsSync } from 'node:fs';
import type { KeyObject } from 'node:crypto';
import { sanitize } from './sanitize.js';
import { signPayload, verifyPayload } from './verify.js';
import { receiptsPath, ensureHome } from './paths.js';

export type Receipt = {
  v: 1;
  did: string;
  room: string;
  nonce: number;
  sanitized_text: string;
  sig: string;
  url: string;
  local_ts: string;
};

/**
 * The server requires a nonce strictly greater than the last one this key used
 * in this room. A millisecond clock collides when two messages are signed in
 * the same millisecond, so the last known nonce wins when it is not behind.
 */
export function nextNonce(room: string, receipts: Receipt[]): number {
  const last = receipts
    .filter((r) => r.room === room)
    .reduce((max, r) => (r.nonce > max ? r.nonce : max), 0);
  return Math.max(Date.now(), last + 1);
}

export function buildPostUrl(
  base: string,
  did: string,
  sig: string,
  nonce: number,
  room: string,
  sanitizedText: string,
): string {
  const seg = encodeURIComponent;
  return `${base}/r/${seg(room)}/say-signed/${seg(did)}/${seg(sig)}/${nonce}/${seg(sanitizedText)}`;
}

/** Server-side single-line message cap. */
export const MAX_TEXT_CHARS = 4096;

/**
 * The GET write lane is bounded by the edge URL byte budget of roughly 16 KB.
 * A CJK character costs 9 bytes URL-encoded and an emoji 12, so a Korean
 * message can blow the budget long before it reaches the character cap.
 * Failing here beats getting a rejection from the edge with no explanation.
 */
export const MAX_URL_BYTES = 16_000;

export function createReceipt(
  privateKey: KeyObject,
  did: string,
  room: string,
  text: string,
  base: string,
  receipts: Receipt[],
): Receipt {
  const sanitized_text = sanitize(text);
  if (sanitized_text.length > MAX_TEXT_CHARS) {
    throw new Error(
      `message is ${sanitized_text.length} characters; the server cap is ${MAX_TEXT_CHARS}`,
    );
  }
  const nonce = nextNonce(room, receipts);
  const sig = signPayload(privateKey, room, nonce, sanitized_text);
  const url = buildPostUrl(base, did, sig, nonce, room, sanitized_text);
  const bytes = Buffer.byteLength(url, 'utf8');
  if (bytes > MAX_URL_BYTES) {
    throw new Error(
      `post URL is ${bytes} bytes, over the ~${MAX_URL_BYTES} byte URL budget; shorten the message`,
    );
  }
  return {
    v: 1,
    did,
    room,
    nonce,
    sanitized_text,
    sig,
    url,
    local_ts: new Date().toISOString(),
  };
}

export function appendReceipt(r: Receipt): void {
  ensureHome();
  appendFileSync(receiptsPath(), JSON.stringify(r) + '\n', { mode: 0o600 });
}

function isReceipt(value: unknown): value is Receipt {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    r.v === 1 &&
    typeof r.did === 'string' &&
    typeof r.room === 'string' &&
    typeof r.nonce === 'number' &&
    typeof r.sanitized_text === 'string' &&
    typeof r.sig === 'string' &&
    typeof r.url === 'string' &&
    typeof r.local_ts === 'string'
  );
}

export function readReceiptLog(): { receipts: Receipt[]; malformed: number } {
  if (!existsSync(receiptsPath())) return { receipts: [], malformed: 0 };
  const receipts: Receipt[] = [];
  let malformed = 0;
  for (const line of readFileSync(receiptsPath(), 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      malformed++;
      continue;
    }
    if (isReceipt(parsed)) receipts.push(parsed);
    else malformed++;
  }
  return { receipts, malformed };
}

export function loadReceipts(): Receipt[] {
  return readReceiptLog().receipts;
}

export function verifyReceipt(r: Receipt): boolean {
  return verifyPayload(r.did, r.room, r.nonce, r.sanitized_text, r.sig);
}
