import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, appendFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendJsonLine, readJsonLines } from './jsonl.js';

function tempPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'jsonl-')), 'log.jsonl');
}

type Rec = { id: number };
function isRec(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null && typeof (value as Record<string, unknown>).id === 'number';
}

test('appendJsonLine creates a missing file and writes one line', () => {
  const path = tempPath();
  assert.equal(existsSync(path), false);
  appendJsonLine(path, { id: 1 });
  const content = readFileSync(path, 'utf8');
  assert.equal(content, '{"id":1}\n');
});

test('appendJsonLine on a file already ending in a newline does not insert a blank line', () => {
  const path = tempPath();
  appendJsonLine(path, { id: 1 });
  appendJsonLine(path, { id: 2 });
  const lines = readFileSync(path, 'utf8').split('\n').filter((l) => l.trim() !== '');
  assert.equal(lines.length, 2);
  assert.deepEqual(JSON.parse(lines[0]), { id: 1 });
  assert.deepEqual(JSON.parse(lines[1]), { id: 2 });
});

test('appendJsonLine after a newline-less fragment puts the fragment and the new record on separate lines, both later readable except the fragment', () => {
  const path = tempPath();
  appendJsonLine(path, { id: 1 });
  // Simulate an interrupted write: a fragment with no trailing newline.
  appendFileSync(path, '{"id":2');
  appendJsonLine(path, { id: 3 });

  const content = readFileSync(path, 'utf8');
  const lines = content.split('\n').filter((l) => l.trim() !== '');
  assert.equal(lines.length, 3);
  // No line contains two records merged together.
  for (const line of lines) {
    const count = (line.match(/\{"id":/g) || []).length;
    assert.equal(count, 1);
  }

  const { records, malformed } = readJsonLines(path, isRec);
  assert.deepEqual(records, [{ id: 1 }, { id: 3 }]);
  assert.equal(malformed, 1);
});

test('readJsonLines on a missing file returns empty records and zero malformed', () => {
  const path = tempPath();
  const result = readJsonLines(path, isRec);
  assert.deepEqual(result, { records: [], malformed: 0 });
});

test('readJsonLines skips truncated lines, wrong-shape lines, and blank lines, keeping valid records', () => {
  const path = tempPath();
  appendJsonLine(path, { id: 1 });
  appendFileSync(path, '{"id":2\n'); // truncated JSON
  appendFileSync(path, '{"nope":"shape"}\n'); // valid JSON, wrong shape
  appendFileSync(path, '\n   \n'); // blank lines
  appendJsonLine(path, { id: 4 });

  const { records, malformed } = readJsonLines(path, isRec);
  assert.deepEqual(records, [{ id: 1 }, { id: 4 }]);
  assert.equal(malformed, 2);
});
