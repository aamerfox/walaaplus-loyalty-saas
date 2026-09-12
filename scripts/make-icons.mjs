#!/usr/bin/env node
/**
 * `node scripts/make-icons.mjs` — render the PWA and browser icons from the approved brand asset.
 *
 * ## What changed, and why this script was rewritten
 *
 * It used to hand-draw a placeholder: a solid indigo tile with a white ring, written byte by byte
 * with zlib because the alternative was a native image toolchain in the build for three small
 * squares. That was the right trade while no logo existed. The approved artwork now does exist
 * (`public/brand/Zademi-Icon-1024.png`), and hand-writing a resampler for it would mean
 * re-implementing PNG decoding and a box filter — new code whose only job is to make a picture
 * slightly worse than a browser would.
 *
 * So it renders through **Playwright's Chromium**, which this repository already installs for the
 * browser tests. No new dependency, and the resampling is the same one that draws the icon on a
 * phone. The output is committed; this script runs when the artwork changes and **never in the
 * gate**.
 *
 * ## What it does NOT do
 *
 * It never modifies `public/brand/*`. Those five files are the approved masters, byte-identical to
 * what was supplied, and everything here is a derivative rendered from them.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = resolve(ROOT, "public/brand/Zademi-Icon-1024.png");

/**
 * The white the approved icon sits on.
 *
 * A maskable icon is cropped to whatever shape the launcher likes, so the corners it eats must be
 * the artwork's own ground rather than transparency — a transparent maskable icon shows the
 * launcher's default colour through the crop, which is how a brand ends up in a grey circle.
 */
const GROUND = "#FFFFFF";

/** Every derivative, and what each one is for. */
const TARGETS = [
  { file: "public/icons/card-192.png", size: 192, scale: 1, ground: null, why: "PWA icon, Android home screen" },
  { file: "public/icons/card-512.png", size: 512, scale: 1, ground: null, why: "PWA icon, splash and store listings" },
  { file: "public/icons/card-maskable-512.png", size: 512, scale: 0.78, ground: GROUND, why: "Android adaptive icon; 78% keeps the mark inside the safe circle" },
  { file: "public/icons/apple-touch-icon.png", size: 180, scale: 1, ground: GROUND, why: "iOS home screen, which composites no transparency" },
  { file: "public/icons/favicon-32.png", size: 32, scale: 1, ground: null, why: "browser tab" },
  { file: "public/icons/favicon-16.png", size: 16, scale: 1, ground: null, why: "browser tab, dense displays" },
];

/**
 * Render one square at `size`, drawing the source at `scale` of the canvas.
 *
 * `imageSmoothingQuality: "high"` matters at 32 px: the default bilinear step from 1024 px throws
 * away most of the mark's contrast, and a favicon is the one place nobody looks twice at.
 */
async function render(page, dataUrl, { size, scale, ground }) {
  return page.evaluate(
    async ({ dataUrl, size, scale, ground }) => {
      const image = new Image();
      image.src = dataUrl;
      await image.decode();

      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext("2d");
      if (ground) {
        ctx.fillStyle = ground;
        ctx.fillRect(0, 0, size, size);
      }
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      const drawn = Math.round(size * scale);
      const offset = Math.round((size - drawn) / 2);
      ctx.drawImage(image, offset, offset, drawn, drawn);

      const blob = await new Promise((done) => canvas.toBlob(done, "image/png"));
      const bytes = new Uint8Array(await blob.arrayBuffer());
      return Array.from(bytes);
    },
    { dataUrl, size, scale, ground },
  );
}

/**
 * Wrap a PNG in an ICO container.
 *
 * An `.ico` may hold a PNG verbatim (Windows Vista and later, and every browser in use), so this is
 * a 22-byte header rather than a second encoder. It exists because a browser that finds no
 * `<link rel="icon">` — a bare fetch of `/favicon.ico`, a feed reader, a crawler — still asks for
 * that exact path.
 */
function icoFromPng(png, size) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(1, 4); // one image

  const entry = Buffer.alloc(16);
  entry.writeUInt8(size >= 256 ? 0 : size, 0); // width, 0 means 256
  entry.writeUInt8(size >= 256 ? 0 : size, 1); // height
  entry.writeUInt8(0, 2); // palette colours
  entry.writeUInt8(0, 3); // reserved
  entry.writeUInt16LE(1, 4); // colour planes
  entry.writeUInt16LE(32, 6); // bits per pixel
  entry.writeUInt32LE(png.length, 8);
  entry.writeUInt32LE(header.length + entry.length, 12);

  return Buffer.concat([header, entry, png]);
}

const source = readFileSync(SOURCE);
const dataUrl = `data:image/png;base64,${source.toString("base64")}`;

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto("about:blank");

for (const target of TARGETS) {
  const bytes = Buffer.from(await render(page, dataUrl, target));
  const out = resolve(ROOT, target.file);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, bytes);
  console.log(`${target.file.padEnd(38)} ${String(target.size).padStart(4)}px  ${bytes.length} bytes  — ${target.why}`);
}

// The tab icon, at the one path browsers ask for without being told.
const favicon32 = readFileSync(resolve(ROOT, "public/icons/favicon-32.png"));
const ico = icoFromPng(favicon32, 32);
writeFileSync(resolve(ROOT, "src/app/favicon.ico"), ico);
console.log(`${"src/app/favicon.ico".padEnd(38)}   32px  ${ico.length} bytes  — /favicon.ico, asked for by path`);

await browser.close();
