/**
 * PNG helpers for embedding textures without an image library.
 *
 * Blockbench stores embedded textures as data URLs plus their pixel size, so
 * embedding only needs the size from the PNG header (the IHDR chunk). Images
 * the server draws itself, such as UV templates, go through the encoder here.
 *
 * @module
 */

import { deflateSync } from "node:zlib";

export { type IPngSize, pngSize } from "@/lib/png";

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const RGBA_8_BIT = [8, 6, 0, 0, 0];

/** Encodes PNG bytes as a data URL. */
export function pngDataUrl(bytes: Uint8Array): string {
  return `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`;
}

/**
 * Decodes a PNG data URL.
 *
 * @throws Error when the URL is not a base64 PNG data URL.
 */
export function decodePngDataUrl(url: string): Uint8Array {
  const match = /^data:image\/png;base64,(.+)$/s.exec(url);
  if (!match?.[1]) throw new Error("Expected a base64 PNG data URL (data:image/png;base64,...).");
  return new Uint8Array(Buffer.from(match[1], "base64"));
}

function chunk(type: string, data: Uint8Array): Buffer {
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(Bun.hash.crc32(body), body.length + 4);
  return out;
}

/**
 * Encodes tightly packed RGBA8 pixels (top row first) as a PNG.
 *
 * @throws Error when the pixel count does not match the size.
 */
export function encodeRgbaPng(rgba: Uint8Array, width: number, height: number): Uint8Array {
  if (rgba.length !== width * height * 4) throw new Error(`Expected ${width * height * 4} RGBA bytes for ${width}x${height}, got ${rgba.length}.`);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set(RGBA_8_BIT, 8);
  const rowBytes = width * 4;
  const raw = Buffer.alloc((rowBytes + 1) * height);
  for (let y = 0; y < height; y++) raw.set(rgba.subarray(y * rowBytes, (y + 1) * rowBytes), y * (rowBytes + 1) + 1);
  return Buffer.concat([Buffer.from(SIGNATURE), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", new Uint8Array(0))]);
}
