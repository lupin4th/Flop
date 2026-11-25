import { blake2b } from './blake2b.js';
import { ss58Decode } from './ss58.js';
import type { Http } from './http.js';

// Read-only access to a Substrate chain's public JSON-RPC. Nothing here
// signs or submits anything: it looks up what an account holds.

/** twox128("System") ++ twox128("Account"), the same on every Substrate chain. */
const SYSTEM_ACCOUNT = '26aa394eea5630e07c48ae0c9558cef7b99d880ec681799c0cf30e8886371da9';

/** FLOP is written with 18 decimal places, like the chain's base unit. */
export const FLOP_DECIMALS = 18;

/** Storage key of `System.Account(accountId)` (Blake2_128Concat hasher). */
export function accountStorageKey(accountId: Buffer): string {
  if (accountId.length !== 32) {
    throw new Error(`expected a 32-byte account id, got ${accountId.length}`);
  }
  return '0x' + SYSTEM_ACCOUNT + blake2b(accountId, 16).toString('hex') + accountId.toString('hex');
}

export type AccountBalance = { nonce: number; free: bigint; reserved: bigint };

function u128le(buf: Buffer, offset: number): bigint {
  return buf.readBigUInt64LE(offset) | (buf.readBigUInt64LE(offset + 8) << 64n);
}

/**
 * `AccountInfo` is four u32 counters (nonce, consumers, providers,
 * sufficients) followed by `AccountData`, whose first two u128 fields are
 * the free and reserved balances.
 */
export function decodeAccountInfo(hex: string): AccountBalance {
  if (!/^0x([0-9a-fA-F]{2})*$/.test(hex)) throw new Error('account storage value is not hex');
  const buf = Buffer.from(hex.slice(2), 'hex');
  if (buf.length < 48) {
    throw new Error(`account storage value is ${buf.length} bytes, expected at least 48`);
  }
  return { nonce: buf.readUInt32LE(0), free: u128le(buf, 16), reserved: u128le(buf, 32) };
}

/** Renders base units as a decimal FLOP amount, truncated (never rounded up). */
export function formatFlop(units: bigint, places: number = 6): string {
  const one = 10n ** BigInt(FLOP_DECIMALS);
  const whole = units / one;
  const fraction = String(units % one).padStart(FLOP_DECIMALS, '0').slice(0, places);
  return places > 0 ? `${whole}.${fraction}` : String(whole);
}

export async function rpcCall(
  http: Http,
  rpcUrl: string,
  method: string,
  params: unknown[],
): Promise<unknown> {
  const res = await http('POST', rpcUrl, JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }));
  if (res.status !== 200) throw new Error(`${method} failed: HTTP ${res.status}`);
  let parsed: { result?: unknown; error?: { message?: unknown } };
  try {
    parsed = JSON.parse(res.body);
  } catch {
    throw new Error(`${method} returned a non-JSON body`);
  }
  if (parsed.error) throw new Error(`${method} failed: ${String(parsed.error.message)}`);
  return parsed.result;
}

/**
 * The balance at the finalized head, so a figure reported here cannot be
 * undone by a reorg. `account` is null when the chain has never seen the
 * address, which is what a zero balance looks like on Substrate.
 */
export async function fetchBalance(
  http: Http,
  rpcUrl: string,
  address: string,
): Promise<{ finalized: string; account: AccountBalance | null }> {
  const { accountId } = ss58Decode(address);
  const finalized = await rpcCall(http, rpcUrl, 'chain_getFinalizedHead', []);
  if (typeof finalized !== 'string') throw new Error('chain_getFinalizedHead returned no block hash');
  const value = await rpcCall(http, rpcUrl, 'state_getStorage', [
    accountStorageKey(accountId),
    finalized,
  ]);
  if (value === null || value === undefined) return { finalized, account: null };
  if (typeof value !== 'string') throw new Error('state_getStorage returned an unexpected value');
  return { finalized, account: decodeAccountInfo(value) };
}
