import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readPassphraseFile } from './passphrase.js';
import { passphrasePath } from './paths.js';

function tempFile(content: string, mode: number): string {
  const path = join(mkdtempSync(join(tmpdir(), 'attest-pass-')), 'passphrase');
  writeFileSync(path, content);
  chmodSync(path, mode);
  return path;
}

test('reads an owner-only file and drops one trailing newline', () => {
  assert.equal(readPassphraseFile(tempFile('correct horse\n', 0o600)), 'correct horse');
  assert.equal(readPassphraseFile(tempFile('correct horse\r\n', 0o400)), 'correct horse');
});

test('keeps inner and leading whitespace, which may be part of the passphrase', () => {
  assert.equal(readPassphraseFile(tempFile('  two  words \n', 0o600)), '  two  words ');
});

test('refuses a file that group or others can read', () => {
  for (const mode of [0o644, 0o640, 0o604]) {
    assert.throws(() => readPassphraseFile(tempFile('secret\n', mode)), /readable by others/);
  }
});

test('refuses an empty file and a missing one', () => {
  assert.throws(() => readPassphraseFile(tempFile('\n', 0o600)), /is empty/);
  assert.throws(() => readPassphraseFile('/nonexistent/passphrase'), /no passphrase file/);
});

test('an error never repeats the passphrase', () => {
  const path = tempFile('hunter2-do-not-print\n', 0o644);
  assert.throws(
    () => readPassphraseFile(path),
    (err: Error) => !err.message.includes('hunter2-do-not-print'),
  );
});

test('defaults to the passphrase file in the attest home', () => {
  const home = mkdtempSync(join(tmpdir(), 'attest-'));
  process.env.TECHNOCORE_ATTEST_HOME = home;
  assert.equal(passphrasePath(), join(home, 'passphrase'));
  writeFileSync(passphrasePath(), 'from home\n', { mode: 0o600 });
  assert.equal(readPassphraseFile(), 'from home');
});
