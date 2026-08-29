const ALPHABET =
  '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const ED25519_MULTICODEC = Buffer.from([0xed, 0x01]);
const PREFIX = 'did:key:';

export function base58Decode(s: string): Buffer {
  const bytes: number[] = [0];
  for (const ch of s) {
    const v = ALPHABET.indexOf(ch);
    if (v < 0) throw new Error(`invalid base58 character: ${ch}`);
    let carry = v;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (let i = 0; i < s.length && s[i] === '1'; i++) bytes.push(0);
  return Buffer.from(bytes.reverse());
}

export function base58Encode(buf: Buffer): string {
  const digits: number[] = [0];
  for (const byte of buf) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i] << 8;
      digits[i] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = '';
  for (let i = 0; i < buf.length && buf[i] === 0; i++) out += '1';
  return out + digits.reverse().map((d) => ALPHABET[d]).join('');
}

export function decodeDidKey(did: string): Buffer {
  if (!did.startsWith(PREFIX)) {
    throw new Error(`not a did:key identifier: ${did}`);
  }
  const mb = did.slice(PREFIX.length);
  if (mb[0] !== 'z') {
    throw new Error(`unsupported multibase prefix: ${mb[0]}`);
  }
  const raw = base58Decode(mb.slice(1));
  if (raw.length !== 34) {
    throw new Error(`expected 34 bytes, got ${raw.length}`);
  }
  if (!raw.subarray(0, 2).equals(ED25519_MULTICODEC)) {
    throw new Error(
      `expected ed25519-pub multicodec, got 0x${raw.subarray(0, 2).toString('hex')}`,
    );
  }
  return raw.subarray(2);
}

export function encodeDidKey(publicKey: Buffer): string {
  if (publicKey.length !== 32) {
    throw new Error(`expected a 32-byte key, got ${publicKey.length}`);
  }
  return (
    PREFIX + 'z' + base58Encode(Buffer.concat([ED25519_MULTICODEC, publicKey]))
  );
}
