import { readFileSync, statSync } from 'node:fs';
import { passphrasePath } from './paths.js';

/**
 * Reads the passphrase for unattended signing from a file the owner wrote.
 *
 * An interactive prompt is the default everywhere else in this tool. A file
 * exists only so a scheduled job can sign with nobody at the keyboard, and
 * it is the weakest link in that setup: anyone who can read it can unlock
 * the key beside it. So it is refused outright unless it is private to its
 * owner, and its contents are never echoed, logged or put in an error.
 */
export function readPassphraseFile(path: string = passphrasePath()): string {
  let mode: number;
  try {
    mode = statSync(path).mode & 0o777;
  } catch {
    throw new Error(`no passphrase file at ${path}`);
  }
  if (mode & 0o077) {
    throw new Error(
      `passphrase file ${path} is readable by others (mode ${mode.toString(8)}); run chmod 600 on it`,
    );
  }
  const passphrase = readFileSync(path, 'utf8').replace(/\r?\n$/, '');
  if (passphrase.length === 0) throw new Error(`passphrase file ${path} is empty`);
  return passphrase;
}
