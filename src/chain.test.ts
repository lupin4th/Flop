import test from 'node:test';
import assert from 'node:assert/strict';
import {
  accountStorageKey, decodeAccountInfo, formatFlop, rpcCall, fetchBalance,
} from './chain.js';
import type { Http, HttpResponse } from './http.js';

const ALICE_ID = Buffer.from(
  'd43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d',
  'hex',
);
const ALICE_SS58 = '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY';
// The System.Account key for Alice, as documented across the Substrate ecosystem.
const ALICE_KEY =
  '0x26aa394eea5630e07c48ae0c9558cef7b99d880ec681799c0cf30e8886371da9' +
  'de1e86a9a8c739864cf3cc5ec2bea59f' +
  'd43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d';

function u128(v: bigint): string {
  const b = Buffer.alloc(16);
  b.writeBigUInt64LE(v & ((1n << 64n) - 1n), 0);
  b.writeBigUInt64LE(v >> 64n, 8);
  return b.toString('hex');
}

function u32(v: number): string {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(v, 0);
  return b.toString('hex');
}

/** nonce, consumers, providers, sufficients, free, reserved, frozen, flags */
function accountInfo(nonce: number, free: bigint, reserved: bigint): string {
  return '0x' + u32(nonce) + u32(0) + u32(1) + u32(0) + u128(free) + u128(reserved) + u128(0n) + u128(1n << 127n);
}

const ok = (body: unknown): HttpResponse => ({ status: 200, headers: {}, body: JSON.stringify(body) });

test('builds the well-known System.Account storage key for Alice', () => {
  assert.equal(accountStorageKey(ALICE_ID), ALICE_KEY);
});

test('decodes nonce, free and reserved from an AccountInfo value', () => {
  const tenFlop = 10n * 10n ** 18n;
  const info = decodeAccountInfo(accountInfo(7, tenFlop, 3n));
  assert.deepEqual(info, { nonce: 7, free: tenFlop, reserved: 3n });
});

test('decodes a balance that needs the upper 64 bits', () => {
  const big = (1n << 100n) + 12345n;
  assert.equal(decodeAccountInfo(accountInfo(0, big, 0n)).free, big);
});

test('refuses a truncated or non-hex storage value', () => {
  assert.throws(() => decodeAccountInfo('0x00'), /expected at least 48/);
  assert.throws(() => decodeAccountInfo('nonsense'), /not hex/);
});

test('formats base units as FLOP, truncating rather than rounding up', () => {
  assert.equal(formatFlop(10n * 10n ** 18n), '10.000000');
  assert.equal(formatFlop(1_999_999_999_999_999_999n), '1.999999');
  assert.equal(formatFlop(0n), '0.000000');
  assert.equal(formatFlop(5n * 10n ** 17n, 2), '0.50');
});

test('rpcCall surfaces HTTP and JSON-RPC errors instead of returning them', async () => {
  const limited: Http = async () => ({ status: 429, headers: {}, body: '' });
  await assert.rejects(rpcCall(limited, 'https://rpc.example/', 'm', []), /HTTP 429/);
  const failing: Http = async () => ok({ error: { message: 'boom' } });
  await assert.rejects(rpcCall(failing, 'https://rpc.example/', 'm', []), /boom/);
});

test('fetchBalance reads the account at the finalized head', async () => {
  const calls: { method: string; params: unknown[] }[] = [];
  const http: Http = async (_m, _url, body) => {
    const req = JSON.parse(body ?? '{}') as { method: string; params: unknown[] };
    calls.push(req);
    if (req.method === 'chain_getFinalizedHead') return ok({ result: '0xfeed' });
    return ok({ result: accountInfo(2, 10n ** 19n, 0n) });
  };
  const { finalized, account } = await fetchBalance(http, 'https://rpc.example/', ALICE_SS58);
  assert.equal(finalized, '0xfeed');
  assert.equal(account?.free, 10n ** 19n);
  assert.deepEqual(calls[1], { jsonrpc: '2.0', id: 1, method: 'state_getStorage', params: [ALICE_KEY, '0xfeed'] });
});

test('fetchBalance reports an unknown account as null, not as an error', async () => {
  const http: Http = async (_m, _url, body) =>
    JSON.parse(body ?? '{}').method === 'chain_getFinalizedHead'
      ? ok({ result: '0xfeed' })
      : ok({ result: null });
  const { account } = await fetchBalance(http, 'https://rpc.example/', ALICE_SS58);
  assert.equal(account, null);
});
