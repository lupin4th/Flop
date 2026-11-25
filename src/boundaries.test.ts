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
  for (const mod of ['didkey', 'verify', 'sanitize', 'room', 'ss58', 'blake2b']) {
    const src = readFileSync(new URL(`../src/${mod}.ts`, import.meta.url), 'utf8');
    assert.equal(/node:fs/.test(src), false, `${mod}.ts must not use node:fs`);
    assert.equal(/fetch\s*\(/.test(src), false, `${mod}.ts must not call fetch`);
  }
});

test('the technocore-attest CLI cannot send, or read a passphrase from disk', () => {
  // `cli.ts` promises that it never posts anything and always asks for the
  // passphrase at the keyboard. The unattended agent breaks both on purpose,
  // so it lives in its own entry point and the CLI must not reach into it.
  const src = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
  for (const mod of ['agent', 'faucet', 'passphrase', 'http']) {
    assert.equal(
      new RegExp(`from\\s+['"]\\./${mod}\\.js['"]`).test(src),
      false,
      `cli.ts must not import ${mod}.js`,
    );
  }
});

test('only the agent entry point reads the passphrase file', () => {
  for (const mod of ['keystore', 'receipts', 'faucet', 'chain', 'http', 'client', 'cli']) {
    const src = readFileSync(new URL(`../src/${mod}.ts`, import.meta.url), 'utf8');
    assert.equal(/passphrase\.js/.test(src), false, `${mod}.ts must not import passphrase.js`);
    assert.equal(/passphrasePath/.test(src), false, `${mod}.ts must not touch the passphrase file`);
  }
});
