// Crockford base32, as used by ULIDs: sortable by creation time, URL and filename safe.
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A ULID: 10 characters of millisecond time followed by 16 random characters. */
export function ulid(now = Date.now()): string {
  let time = "";
  let t = now;
  for (let i = 0; i < 10; i++) {
    time = ALPHABET.charAt(t % 32) + time;
    t = Math.floor(t / 32);
  }
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  let random = "";
  for (const byte of bytes) random += ALPHABET.charAt(byte % 32);
  return time + random;
}

export function projectId(): string {
  return `prj_${ulid()}`;
}
