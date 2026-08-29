import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('keystore does not import the network client, directly or otherwise', () => {
  // The private key must have no code path to the network. This is a
  // structural guarantee, not a convention, so it is asserted here.
  for (const mod of ['keystore', 'didkey', 'verify', 'sanitize', 'room', 'jsonl']) {
    const src = readFileSync(new URL(`../src/${mod}.ts`, import.meta.url), 'utf8');
    assert.equal(
      /from\s+['"]\.\/client\.js['"]/.test(src),
      false,
      `${mod}.ts must not import client.js`,
    );
  }
});

test('pure modules touch neither the filesystem nor the network', () => {
  for (const mod of ['didkey', 'verify', 'sanitize', 'room']) {
    const src = readFileSync(new URL(`../src/${mod}.ts`, import.meta.url), 'utf8');
    assert.equal(/node:fs/.test(src), false, `${mod}.ts must not use node:fs`);
    assert.equal(/fetch\s*\(/.test(src), false, `${mod}.ts must not call fetch`);
  }
});
