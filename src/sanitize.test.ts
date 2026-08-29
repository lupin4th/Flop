import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitize } from './sanitize.js';

test('sweeps each targeted unicode category to a single space', () => {
  assert.equal(sanitize('a\nb'), 'a b');              // Cc
  assert.equal(sanitize('a\u{200D}b'), 'a b');          // Cf (ZWJ)
  assert.equal(sanitize('a\u{E000}b'), 'a b');          // Co (private use)
  assert.equal(sanitize('a\u{2028}b'), 'a b');          // Zl
  assert.equal(sanitize('a\u{2029}b'), 'a b');          // Zp
  assert.equal(sanitize('a\uD800b'), 'a b');          // Cs (lone surrogate)
});

test('preserves surrogate pairs and non-latin text', () => {
  assert.equal(sanitize('hi \u{1F600}'), 'hi \u{1F600}');   // emoji survives
  assert.equal(sanitize('한글'), '한글');   // hangul survives
});

test('does not apply unicode normalization', () => {
  const nfc = '가'.normalize('NFC');           // 가 (precomposed)
  const nfd = '가'.normalize('NFD');     // 가 (decomposed)
  assert.notEqual(sanitize(nfc), sanitize(nfd));
});

test('replaces each swept char with exactly one space, preserving length', () => {
  assert.equal(sanitize('a\n\n\nb'), 'a   b');
});
