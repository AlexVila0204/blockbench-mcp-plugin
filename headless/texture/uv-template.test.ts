import { describe, expect, test } from "bun:test";
import { encodeRgbaPng, pngSize } from "../document/png";
import type { IBBModel } from "../document/schema";
import { applyOperations, operationSchema } from "../edit/operations";
import { emptyModel } from "../tools/edit";
import { buildUvTemplate } from "./uv-template";

const ONE_PIXEL_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function model(operations: unknown[], boxUv = true): IBBModel {
  return applyOperations(emptyModel("bedrock", "template", boxUv, { width: 32, height: 16 }), operationSchema.array().parse(operations)).doc;
}

/** A 4×6×2 cube: its box-UV cross is 12×8 with 88 covered pixels. */
const arm = (name: string, uvOffset: [number, number]) => ({ op: "add_cube", name, from: [0, 0, 0], to: [4, 6, 2], uv_offset: uvOffset });

const alphaAt = (rgba: Uint8Array, width: number, x: number, y: number): number => rgba[(y * width + x) * 4 + 3] ?? 0;
const colorAt = (rgba: Uint8Array, width: number, x: number, y: number): number[] => [...rgba.subarray((y * width + x) * 4, (y * width + x) * 4 + 3)];
const coveredPixels = (rgba: Uint8Array): number => rgba.filter((_, index) => index % 4 === 3 && rgba[index] === 255).length;

describe("buildUvTemplate", () => {
  test("draws a box-UV cube at native size with one rectangle per face", () => {
    const template = buildUvTemplate(model([arm("arm", [0, 0])]), { scale: 1 });
    expect([template.width, template.height]).toEqual([32, 16]);
    expect(coveredPixels(template.rgba)).toBe(88);
    expect(template.overlaps).toEqual([]);
    expect(template.outside).toEqual([]);
    expect(template.elements).toHaveLength(1);
    expect(template.elements[0]?.faces).toEqual({
      north: { rect: [2, 2, 4, 6] },
      east: { rect: [0, 2, 2, 6] },
      south: { rect: [8, 2, 4, 6] },
      west: { rect: [6, 2, 2, 6] },
      up: { rect: [2, 0, 4, 2], flip: "xy" },
      down: { rect: [6, 0, 4, 2], flip: "x" },
    });
    expect(alphaAt(template.rgba, 32, 0, 0)).toBe(0);
    expect(alphaAt(template.rgba, 32, 2, 0)).toBe(255);
  });

  test("gives faces different lightness and elements different hues", () => {
    const template = buildUvTemplate(model([arm("left", [0, 0]), arm("right", [16, 0])]), { scale: 1 });
    const up = colorAt(template.rgba, 32, 2, 0);
    const north = colorAt(template.rgba, 32, 2, 2);
    const otherNorth = colorAt(template.rgba, 32, 18, 2);
    expect(up).not.toEqual(north);
    expect(north).not.toEqual(otherNorth);
    expect(template.elements[0]?.color).not.toBe(template.elements[1]?.color);
  });

  test("outlines faces when scaled up", () => {
    const template = buildUvTemplate(model([arm("arm", [0, 0])]), { scale: 4 });
    expect([template.width, template.height]).toEqual([128, 64]);
    const corner = colorAt(template.rgba, 128, 8, 8);
    const center = colorAt(template.rgba, 128, 14, 14);
    expect(corner).not.toEqual(center);
    expect(Math.max(...corner)).toBeLessThan(Math.max(...center));
  });

  test("reports faces that share pixels and faces past the texture", () => {
    const stacked = buildUvTemplate(model([arm("a", [0, 0]), arm("b", [0, 0])]), { scale: 1 });
    expect(stacked.overlaps).toContainEqual(["a.north", "b.north"]);
    expect(stacked.overlaps).toHaveLength(6);

    const offTexture = buildUvTemplate(model([arm("far", [28, 0])]), { scale: 1 });
    expect(offTexture.outside).toEqual(["far"]);
  });

  test("reports the faces of one per-face-UV cube stacked at the origin", () => {
    const template = buildUvTemplate(model([{ op: "add_cube", name: "block", from: [0, 0, 0], to: [4, 4, 4] }], false), { scale: 1 });
    expect(template.overlaps.length).toBeGreaterThan(0);
    expect(template.overlaps.every(([a, b]) => a.startsWith("block.") && b.startsWith("block."))).toBe(true);
  });

  test("keeps only the faces of the chosen texture, at that texture's size", () => {
    const doc = model([
      { op: "add_texture", name: "skin.png", source: ONE_PIXEL_PNG, width: 64, height: 32 },
      { op: "add_cube", name: "textured", from: [0, 0, 0], to: [4, 6, 2], uv_offset: [0, 0], texture: 0 },
      arm("bare", [16, 0]),
    ]);
    const template = buildUvTemplate(doc, { texture: 0, scale: 1 });
    expect(template.elements.map((element) => element.name)).toEqual(["textured"]);
    expect([template.width, template.height]).toEqual([64, 32]);
    expect(template.elements[0]?.faces.north).toEqual({ rect: [4, 4, 8, 12] });
  });

  test("draws mesh faces as polygons", () => {
    const doc = applyOperations(
      emptyModel("free", "mesh", false, { width: 16, height: 16 }),
      operationSchema.array().parse([
        {
          op: "add_mesh",
          name: "tri",
          vertices: [[0, 0, 0], [8, 0, 0], [0, 8, 0]],
          faces: [{ vertices: [0, 1, 2], uv: [[0, 0], [8, 0], [0, 8]] }],
        },
      ]),
    ).doc;
    const template = buildUvTemplate(doc, { scale: 1 });
    expect(template.elements[0]?.type).toBe("mesh");
    expect(Object.values(template.elements[0]?.faces ?? {})[0]).toEqual({ rect: [0, 0, 8, 8] });
    expect(alphaAt(template.rgba, 16, 1, 1)).toBe(255);
    expect(alphaAt(template.rgba, 16, 7, 7)).toBe(0);
  });

  test("refuses a model without faces", () => {
    expect(() => buildUvTemplate(model([]), { scale: 1 })).toThrow("no faces");
  });
});

describe("encodeRgbaPng", () => {
  test("writes a PNG of the given size", () => {
    const png = encodeRgbaPng(new Uint8Array(3 * 2 * 4), 3, 2);
    expect(pngSize(png)).toEqual({ width: 3, height: 2 });
    expect(() => encodeRgbaPng(new Uint8Array(4), 3, 2)).toThrow("RGBA bytes");
  });
});
