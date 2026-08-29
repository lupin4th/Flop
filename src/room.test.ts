import test from 'node:test';
import assert from 'node:assert/strict';
import { isSafeRoom, assertSafeRoom } from './room.js';

test('isSafeRoom accepts legitimate room names', () => {
  assert.equal(isSafeRoom('lobby'), true);
  assert.equal(isSafeRoom('room.v2'), true);
  assert.equal(isSafeRoom('p-_.'), true);
  assert.equal(isSafeRoom('a_b-c.d'), true);
});

test('isSafeRoom rejects dot names', () => {
  assert.equal(isSafeRoom('.'), false);
  assert.equal(isSafeRoom('..'), false);
});

test('isSafeRoom rejects empty string', () => {
  assert.equal(isSafeRoom(''), false);
});

test('isSafeRoom rejects names with path separators', () => {
  assert.equal(isSafeRoom('a/b'), false);
});

test('isSafeRoom rejects names with spaces', () => {
  assert.equal(isSafeRoom('a b'), false);
});

test('isSafeRoom rejects names with path traversal', () => {
  assert.equal(isSafeRoom('../escape'), false);
});

test('isSafeRoom rejects names over 64 characters', () => {
  assert.equal(isSafeRoom('a'.repeat(65)), false);
});

test('assertSafeRoom throws for invalid room names', () => {
  assert.throws(() => assertSafeRoom('.'), /unsafe room name/);
  assert.throws(() => assertSafeRoom('..'), /unsafe room name/);
  assert.throws(() => assertSafeRoom(''), /unsafe room name/);
  assert.throws(() => assertSafeRoom('a/b'), /unsafe room name/);
  assert.throws(() => assertSafeRoom('a b'), /unsafe room name/);
  assert.throws(() => assertSafeRoom('../escape'), /unsafe room name/);
  assert.throws(() => assertSafeRoom('a'.repeat(65)), /unsafe room name/);
});

test('assertSafeRoom does not throw for valid room names', () => {
  assert.doesNotThrow(() => assertSafeRoom('lobby'));
  assert.doesNotThrow(() => assertSafeRoom('room.v2'));
  assert.doesNotThrow(() => assertSafeRoom('p-_.'));
  assert.doesNotThrow(() => assertSafeRoom('a_b-c.d'));
});
