import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { assertSafeRoom } from './room.js';

export function attestHome(): string {
  return process.env.TECHNOCORE_ATTEST_HOME ?? join(homedir(), '.technocore-attest');
}

export function keyPath(): string {
  return join(attestHome(), 'key.json');
}

export function receiptsPath(): string {
  return join(attestHome(), 'receipts.jsonl');
}

export function confirmationsPath(): string {
  return join(attestHome(), 'confirmations.jsonl');
}

export function watchStatePath(): string {
  return join(attestHome(), 'watch-state.json');
}

/**
 * Unattended signing only: a file holding the key's passphrase, written by
 * the owner and readable by the owner alone. See passphrase.ts.
 */
export function passphrasePath(): string {
  return join(attestHome(), 'passphrase');
}

export function faucetStatePath(): string {
  return join(attestHome(), 'faucet-state.json');
}

export function faucetLogPath(): string {
  return join(attestHome(), 'faucet-claims.jsonl');
}

export function archiveDir(room: string): string {
  assertSafeRoom(room);
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
