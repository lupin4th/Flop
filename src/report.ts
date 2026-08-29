import { verifyReceipt, type Receipt } from './receipts.js';
import type { ArchivedMessage, Trust } from './archive.js';

const TRUST_ORDER: Trust[] = ['self_verified', 'server_attested', 'unsigned'];

/**
 * Archived message bodies are untrusted third-party input, so the report
 * counts them and never reproduces them.
 */
export function buildReport(
  receipts: Receipt[],
  archives: Record<string, ArchivedMessage[]>,
  malformed = 0,
): string {
  const lines: string[] = ['# technocore-attest report', ''];

  const verified = receipts.filter(verifyReceipt);
  const failed = receipts.length - verified.length;
  lines.push('## Receipts', '');
  lines.push(
    `${receipts.length} receipt(s): ${verified.length} verified, ${failed} FAILED`,
    '',
  );

  if (malformed > 0) {
    lines.push(
      `WARNING: ${malformed} line(s) in the receipt log could not be read and were skipped. Those receipts are lost; the file may have been truncated by an interrupted write.`,
      '',
    );
  }

  const dids = [...new Set(receipts.map((r) => r.did))];
  for (const did of dids) {
    const mine = receipts.filter((r) => r.did === did);
    const rooms = [...new Set(mine.map((r) => r.room))].sort();
    lines.push(`- ${did}: ${mine.length} message(s) across ${rooms.join(', ')}`);
  }
  if (dids.length) lines.push('');

  const rooms = Object.keys(archives).sort();
  if (rooms.length) {
    lines.push('## Archive', '');
    for (const room of rooms) {
      const msgs = archives[room];
      const counts = TRUST_ORDER.map(
        (t) => `${t}: ${msgs.filter((m) => m.trust === t).length}`,
      ).join(', ');
      lines.push(`- ${room}: ${msgs.length} message(s) — ${counts}`);
    }
    lines.push('');
  }

  lines.push(
    '`server_attested` means the server accepted the signature at write time.',
    'The signature is not exposed to readers, so it cannot be re-verified here.',
  );
  return lines.join('\n');
}
