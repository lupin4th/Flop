/**
 * Room names arrive from the chat server's listings and from user input, so
 * they are validated once, here, and both the filesystem and URL paths use
 * this same guard. The dot names are excluded explicitly: `.` and `..` match
 * the character class but traverse.
 */
const SAFE_ROOM = /^[A-Za-z0-9._-]{1,64}$/;

export function isSafeRoom(room: string): boolean {
  return SAFE_ROOM.test(room) && room !== '.' && room !== '..';
}

export function assertSafeRoom(room: string): void {
  if (!isSafeRoom(room)) {
    throw new Error(`unsafe room name: ${JSON.stringify(room)}`);
  }
}
