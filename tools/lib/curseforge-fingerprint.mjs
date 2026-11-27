// CurseForge uses MurmurHash2 with seed 1, omitting these four byte values.
// https://github.com/packwiz/packwiz/blob/main/curseforge/murmur2/hash.go
const included = new Uint8Array(256).fill(1);
for (const byte of [9, 10, 13, 32]) included[byte] = 0;
const multiplier = 0x5bd1e995;

export function normalizedLength(bytes) {
  let size = 0;
  for (let i = 0; i < bytes.length; i++) size += included[bytes[i]];
  return size;
}

export class CurseForgeFingerprint {
  constructor(size) {
    this.hash = size ^ 1;
    this.word = 0;
    this.shift = 0;
  }

  update(bytes) {
    let { hash, word, shift } = this;
    for (let i = 0; i < bytes.length; i++) {
      const byte = bytes[i];
      if (!included[byte]) continue;
      word |= byte << shift;
      shift += 8;
      if (shift === 32) {
        const mixed = Math.imul(word, multiplier);
        hash = Math.imul(hash, multiplier) ^ Math.imul(mixed ^ (mixed >>> 24), multiplier);
        word = 0;
        shift = 0;
      }
    }
    this.hash = hash;
    this.word = word;
    this.shift = shift;
  }

  digest() {
    let hash = this.hash;
    if (this.shift) hash = Math.imul(hash ^ this.word, multiplier);
    hash = Math.imul(hash ^ (hash >>> 13), multiplier);
    return (hash ^ (hash >>> 15)) >>> 0;
  }
}
