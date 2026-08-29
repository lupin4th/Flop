import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';

/** Room names come from the network, so they never reach the filesystem raw. */
const SAFE_ROOM = /^[A-Za-z0-9._-]{1,64}$/;

export function attestHome(): string {
  return process.env.TECHNOCORE_ATTEST_HOME ?? join(homedir(), '.technocore-attest');
}

export function keyPath(): string {
  return join(attestHome(), 'key.json');
}

export function receiptsPath(): string {
  return join(attestHome(), 'receipts.jsonl');
}

export function archiveDir(room: string): string {
  if (!SAFE_ROOM.test(room)) {
    throw new Error(`unsafe room name: ${JSON.stringify(room)}`);
  }
  if (room === '.' || room === '..') {
    throw new Error(`unsafe room name: ${JSON.stringify(room)}`);
  }
  const root = resolve(join(attestHome(), 'archive'));
  const dir = resolve(join(root, room));
  if (dir !== root && !dir.startsWith(root + sep)) {
    throw new Error(`unsafe room name: ${JSON.stringify(room)}`);
  }
  return dir;
}

export function ensureHome(): void {
  mkdirSync(attestHome(), { recursive: true, mode: 0o700 });
}
