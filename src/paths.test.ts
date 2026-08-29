import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { attestHome, keyPath, receiptsPath, archiveDir, ensureHome } from './paths.js';

test('defaults to ~/.technocore-attest', () => {
  delete process.env.TECHNOCORE_ATTEST_HOME;
  assert.equal(attestHome(), join(homedir(), '.technocore-attest'));
});

test('TECHNOCORE_ATTEST_HOME overrides the default', () => {
  process.env.TECHNOCORE_ATTEST_HOME = '/tmp/x';
  assert.equal(attestHome(), '/tmp/x');
  assert.equal(keyPath(), join('/tmp/x', 'key.json'));
  assert.equal(receiptsPath(), join('/tmp/x', 'receipts.jsonl'));
  assert.equal(archiveDir('lobby'), join('/tmp/x', 'archive', 'lobby'));
  delete process.env.TECHNOCORE_ATTEST_HOME;
});

test('ensureHome creates the directory with mode 0700', () => {
  const base = mkdtempSync(join(tmpdir(), 'attest-'));
  process.env.TECHNOCORE_ATTEST_HOME = join(base, 'home');
  ensureHome();
  assert.equal(statSync(attestHome()).mode & 0o777, 0o700);
  delete process.env.TECHNOCORE_ATTEST_HOME;
});

test('rejects a room name that would escape the archive directory', () => {
  process.env.TECHNOCORE_ATTEST_HOME = '/tmp/x';
  assert.throws(() => archiveDir('../escape'), /room name/);
  assert.throws(() => archiveDir('a/b'), /room name/);
  delete process.env.TECHNOCORE_ATTEST_HOME;
});
