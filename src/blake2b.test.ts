import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { blake2b } from './blake2b.js';

const reference = (buf: Buffer) => createHash('blake2b512').update(buf).digest();

test('64-byte digests match node:crypto across the block boundaries', () => {
  // 0, one byte, just under/at/over one block, and several blocks.
  for (const len of [0, 1, 3, 127, 128, 129, 255, 256, 257, 1000]) {
    const input = Buffer.alloc(len);
    for (let i = 0; i < len; i++) input[i] = (i * 31 + 7) & 0xff;
    assert.equal(
      blake2b(input, 64).toString('hex'),
      reference(input).toString('hex'),
      `length ${len}`,
    );
  }
});

test('RFC 7693 test vector for "abc"', () => {
  assert.equal(
    blake2b(Buffer.from('abc'), 64).toString('hex'),
    'ba80a53f981c4d0d6a2797b69f12f6e94c212f14685ac4b74b12bb6fdbffa2d1' +
      '7d87c5392aab792dc252d5de4533cc9518d38aa8dbf1925ab92386edd4009923',
  );
});

test('a 16-byte digest is its own function, not a truncated 64-byte one', () => {
  const empty = Buffer.alloc(0);
  assert.equal(blake2b(empty, 16).toString('hex'), 'cae66941d9efbd404e4d88758ea67670');
  assert.notEqual(
    blake2b(empty, 16).toString('hex'),
    reference(empty).subarray(0, 16).toString('hex'),
  );
});

test('rejects digest lengths BLAKE2b does not define', () => {
  for (const bad of [0, 65, 1.5, -1]) {
    assert.throws(() => blake2b(Buffer.alloc(0), bad), /digest length/);
  }
});
