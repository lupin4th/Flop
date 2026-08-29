import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateIdentity, saveIdentity, loadIdentity, identityExists } from './keystore.js';
import { signPayload, verifyPayload } from './verify.js';
import { keyPath } from './paths.js';

function isolate() {
  process.env.TECHNOCORE_ATTEST_HOME = mkdtempSync(join(tmpdir(), 'attest-'));
}

test('generated identity yields a did:key that matches its private key', () => {
  isolate();
  const { did, privateKey } = generateIdentity();
  assert.match(did, /^did:key:z6Mk/);
  const sig = signPayload(privateKey, 'lobby', 1, 'hi');
  assert.equal(verifyPayload(did, 'lobby', 1, 'hi', sig), true);
});

test('save then load round-trips a usable signing key', () => {
  isolate();
  const { did, privateKey } = generateIdentity();
  saveIdentity(privateKey, did, 'correct horse');
  const loaded = loadIdentity('correct horse');
  assert.equal(loaded.did, did);
  const sig = signPayload(loaded.privateKey, 'lobby', 42, 'hi');
  assert.equal(verifyPayload(did, 'lobby', 42, 'hi', sig), true);
});

test('a wrong passphrase fails to decrypt', () => {
  isolate();
  const { did, privateKey } = generateIdentity();
  saveIdentity(privateKey, did, 'right');
  assert.throws(() => loadIdentity('wrong'), /passphrase/);
});

test('the key file never contains raw private key material', () => {
  isolate();
  const { did, privateKey } = generateIdentity();
  const pkcs8 = privateKey.export({ type: 'pkcs8', format: 'der' }) as Buffer;
  saveIdentity(privateKey, did, 'pw');
  const raw = readFileSync(keyPath());
  assert.equal(raw.includes(pkcs8), false);
  assert.equal(raw.includes(pkcs8.subarray(16)), false);
});

test('the key file is written with mode 0600', () => {
  isolate();
  const { did, privateKey } = generateIdentity();
  saveIdentity(privateKey, did, 'pw');
  assert.equal(statSync(keyPath()).mode & 0o777, 0o600);
});

test('identityExists reflects whether a key file is present', () => {
  isolate();
  assert.equal(identityExists(), false);
  const { did, privateKey } = generateIdentity();
  saveIdentity(privateKey, did, 'pw');
  assert.equal(identityExists(), true);
});

test('saveIdentity throws when given a did from a different key', () => {
  isolate();
  const { did: did1, privateKey: key1 } = generateIdentity();
  const { did: did2 } = generateIdentity();
  assert.throws(() => saveIdentity(key1, did2, 'pw'), /does not match/);
});

test('loadIdentity throws when the stored did is edited to a different identity', () => {
  isolate();
  const { did, privateKey } = generateIdentity();
  const { did: wrongDid } = generateIdentity();
  saveIdentity(privateKey, did, 'pw');
  const raw = readFileSync(keyPath(), 'utf8');
  const edited = raw.replace(`"did": "${did}"`, `"did": "${wrongDid}"`);
  writeFileSync(keyPath(), edited, { mode: 0o600 });
  assert.throws(() => loadIdentity('pw'), /inconsistent/);
});

test('KDF parameters from file are used and validated on load', () => {
  isolate();
  const { did, privateKey } = generateIdentity();
  saveIdentity(privateKey, did, 'pw');
  const loaded = loadIdentity('pw');
  assert.equal(loaded.did, did);
  const sig = signPayload(loaded.privateKey, 'lobby', 1, 'hi');
  assert.equal(verifyPayload(did, 'lobby', 1, 'hi', sig), true);
});

test('loadIdentity throws on N=0 in KDF parameters', () => {
  isolate();
  const { did, privateKey } = generateIdentity();
  saveIdentity(privateKey, did, 'pw');
  const raw = readFileSync(keyPath(), 'utf8');
  const edited = raw.replace('"N": 32768', '"N": 0');
  writeFileSync(keyPath(), edited, { mode: 0o600 });
  assert.throws(() => loadIdentity('pw'), /KDF parameters/);
});

test('loadIdentity throws on N=2^25 in KDF parameters', () => {
  isolate();
  const { did, privateKey } = generateIdentity();
  saveIdentity(privateKey, did, 'pw');
  const raw = readFileSync(keyPath(), 'utf8');
  const edited = raw.replace('"N": 32768', `"N": ${1 << 25}`);
  writeFileSync(keyPath(), edited, { mode: 0o600 });
  assert.throws(() => loadIdentity('pw'), /KDF parameters/);
});
