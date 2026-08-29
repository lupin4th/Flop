import {
  appendFileSync,
  readFileSync,
  existsSync,
  statSync,
  openSync,
  readSync,
  closeSync,
} from 'node:fs';

/**
 * Append-only JSONL with the two properties this project needs: a partial
 * write costs one record rather than two, and one unreadable line costs only
 * that line. Both live here rather than in each caller, because an invariant
 * kept in two places gets fixed in one.
 */

/**
 * An interrupted write can leave a file that does not end in a newline. If
 * the next append just wrote its record onto the end, it would merge onto
 * that fragment and both would be lost. So: check the last byte, and if it
 * is not already a newline, close off the fragment first.
 *
 * These files grow without bound, so this only ever reads the final byte,
 * never the whole file.
 */
function ensureTrailingNewline(path: string): void {
  if (!existsSync(path)) return;
  const { size } = statSync(path);
  if (size === 0) return;
  const fd = openSync(path, 'r');
  try {
    const tail = Buffer.alloc(1);
    readSync(fd, tail, 0, 1, size - 1);
    if (tail[0] !== 0x0a) appendFileSync(path, '\n');
  } finally {
    closeSync(fd);
  }
}

/** Appends one record, first closing off any fragment left by a partial write. */
export function appendJsonLine(path: string, value: unknown, opts?: { mode?: number }): void {
  ensureTrailingNewline(path);
  appendFileSync(path, JSON.stringify(value) + '\n', opts?.mode !== undefined ? { mode: opts.mode } : undefined);
}

/**
 * Reads a JSONL file, returning records that parse AND satisfy `isValid`.
 * Never throws on content. `malformed` counts lines that failed either check.
 */
export function readJsonLines<T>(
  path: string,
  isValid: (value: unknown) => value is T,
): { records: T[]; malformed: number } {
  if (!existsSync(path)) return { records: [], malformed: 0 };
  const records: T[] = [];
  let malformed = 0;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      malformed++;
      continue;
    }
    if (isValid(parsed)) records.push(parsed);
    else malformed++;
  }
  return { records, malformed };
}
