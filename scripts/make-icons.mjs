#!/usr/bin/env node
/**
 * `node scripts/make-icons.mjs` — generate the customer-card PWA icons.
 *
 * Written by hand with zlib rather than pulled from an image library, because the alternative is a
 * build-time dependency on a native image toolchain for three small squares. The output is
 * committed, so this script runs when the artwork changes and never in the gate.
 *
 * The mark is deliberately plain: a solid indigo tile with a white ring and centre, which reads at
 * 48px on a home screen and survives a circular Android mask. It is placeholder artwork — a real
 * icon is a design task, and the manifest points at these files by name so replacing them needs no
 * code change.
 */
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const BRAND = [79, 70, 229]; // #4f46e5, the theme colour the manifest declares
const WHITE = [255, 255, 255];

/** CRC-32, as PNG chunks require. */
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/**
 * @param {number} size square edge in pixels
 * @param {{ safeRatio: number }} opts safeRatio shrinks the mark for maskable icons, whose outer
 *   edge may be cropped to a circle by the launcher.
 */
function renderPng(size, { safeRatio }) {
  const centre = (size - 1) / 2;
  const outer = (size / 2) * safeRatio;
  const ringOuter = outer * 0.82;
  const ringInner = outer * 0.58;
  const dot = outer * 0.3;

  // One filter byte (0 = none) per scanline, then RGB triples.
  const raw = Buffer.alloc(size * (1 + size * 3));
  let p = 0;
  for (let y = 0; y < size; y++) {
    raw[p++] = 0;
    for (let x = 0; x < size; x++) {
      const distance = Math.hypot(x - centre, y - centre);
      const inRing = distance <= ringOuter && distance >= ringInner;
      const inDot = distance <= dot;
      const [r, g, b] = inRing || inDot ? WHITE : BRAND;
      raw[p++] = r;
      raw[p++] = g;
      raw[p++] = b;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour RGB
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const outputs = [
  ["public/icons/card-192.png", 192, 0.92],
  ["public/icons/card-512.png", 512, 0.92],
  // Maskable: the launcher may crop to a circle, so the mark sits inside the 80% safe zone.
  ["public/icons/card-maskable-512.png", 512, 0.72],
];

for (const [file, size, safeRatio] of outputs) {
  const path = resolve(process.cwd(), file);
  mkdirSync(dirname(path), { recursive: true });
  const png = renderPng(size, { safeRatio });
  writeFileSync(path, png);
  process.stdout.write(`wrote ${file} (${size}x${size}, ${png.length} bytes)\n`);
}
