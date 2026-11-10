import { describe, expect, test } from "bun:test";
import type { IBBModel } from "../document/schema";
import { applyOperations, operationSchema } from "../edit/operations";
import { coverFaces } from "../texture/coverage";
import { emptyModel } from "../tools/edit";
import { runModelTextureGates, runTextureGates, type ITextureImage, type TextureGateId } from "./texture";

const ONE_PIXEL_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const WIDTH = 32;
const HEIGHT = 16;

type Rgba = [number, number, number, number];

function model(operations: unknown[]): IBBModel {
  const texture = { op: "add_texture", name: "skin.png", source: ONE_PIXEL_PNG, width: WIDTH, height: HEIGHT };
  return applyOperations(emptyModel("bedrock", "gates", true, { width: WIDTH, height: HEIGHT }), operationSchema.array().parse([texture, ...operations])).doc;
}

/** A 4×6×2 box-UV cube: north covers [2, 2, 4, 6], up [2, 0, 4, 2]. */
const arm = (name: string, uvOffset: [number, number] = [0, 0]) => ({ op: "add_cube", name, from: [0, 0, 0], to: [4, 6, 2], uv_offset: uvOffset, texture: 0 });

/** Paints every pixel with `colorOf(x, y)`. */
function image(colorOf: (x: number, y: number) => Rgba): ITextureImage {
  const data = new Uint8Array(WIDTH * HEIGHT * 4);
  for (let y = 0; y < HEIGHT; y++) for (let x = 0; x < WIDTH; x++) data.set(colorOf(x, y), (y * WIDTH + x) * 4);
  return { width: WIDTH, height: HEIGHT, data };
}

const CLEAR: Rgba = [0, 0, 0, 0];
const insideCross = (x: number, y: number): boolean => (y < 2 && x >= 2 && x < 10) || (y >= 2 && y < 8 && x < 12);
/** Twelve colors varying inside every face of the cube's cross, nothing elsewhere. */
const shaded = (x: number, y: number): Rgba => (insideCross(x, y) ? [(x % 4) * 60, (y % 3) * 80, 100, 255] : CLEAR);

function messages(doc: IBBModel, pixels: ITextureImage | { unavailable: string }, gate: TextureGateId): string[] {
  const [result] = runTextureGates(coverFaces(doc, 0), pixels, undefined, [gate]);
  return result?.violations.map((violation) => violation.message) ?? [];
}

describe("texture gates", () => {
  test("a fully shaded cube passes every gate", () => {
    const results = runTextureGates(coverFaces(model([arm("arm")]), 0), image(shaded));
    expect(results.map((result) => result.id)).toEqual(["uv_bounds", "uv_overlap", "unpainted_faces", "flat_faces", "stray_pixels", "color_count"]);
    expect(results.flatMap((result) => result.violations)).toEqual([]);
    expect(results.every((result) => result.ran)).toBe(true);
  });

  test("uv_bounds names faces past the texture", () => {
    expect(messages(model([arm("far", [28, 0])]), image(shaded), "uv_bounds")).toEqual([expect.stringContaining('"far" has faces reaching past the 32x16 texture')]);
  });

  test("uv_overlap flags partial overlaps and accepts identical rectangles", () => {
    expect(messages(model([arm("left"), arm("right")]), image(shaded), "uv_overlap")).toEqual([]);
    const shifted = messages(model([arm("a"), arm("b", [1, 0])]), image(shaded), "uv_overlap");
    expect(shifted).toHaveLength(1);
    expect(shifted[0]).toContain('"a" and "b" have faces sharing texture pixels');
  });

  test("unpainted_faces lists transparent faces", () => {
    const northCleared = image((x, y) => (x >= 2 && x < 6 && y >= 2 && y < 8 ? CLEAR : shaded(x, y)));
    expect(messages(model([arm("arm")]), northCleared, "unpainted_faces")).toEqual(['"arm" has fully transparent faces: north.']);
  });

  test("flat_faces lists faces of one color and ignores small ones", () => {
    const flat = image((x, y) => (insideCross(x, y) ? [200, 50, 50, 255] : CLEAR));
    expect(messages(model([arm("arm")]), flat, "flat_faces")).toEqual(['"arm" has faces filled with one flat color: north, south.']);
  });

  test("stray_pixels counts paint outside faces", () => {
    const withStray = image((x, y) => (x === 20 && y === 12 ? [255, 0, 0, 255] : shaded(x, y)));
    expect(messages(model([arm("arm")]), withStray, "stray_pixels")).toEqual(["1 painted pixels lie outside every face, within [20, 12, 1, 1]."]);
  });

  test("color_count flags textures over the limit", () => {
    const [result] = runTextureGates(coverFaces(model([arm("arm")]), 0), image(shaded), { maxColors: 8, minFacePixels: 16, densityTolerance: 2, stretchTolerance: 1.5 }, ["color_count"]);
    expect(result?.violations[0]?.message).toBe("The texture has 12 colors; the limit is 8.");
  });

  test("pixel gates are skipped when the image is missing or has another size", () => {
    const doc = model([arm("arm")]);
    const missing = runTextureGates(coverFaces(doc, 0), { unavailable: "not embedded" });
    expect(missing.filter((result) => !result.ran).map((result) => result.id)).toEqual(["unpainted_faces", "flat_faces", "stray_pixels", "color_count"]);
    expect(missing.find((result) => result.id === "flat_faces")?.skipped_reason).toBe("not embedded");
    const wrongSize = runTextureGates(coverFaces(doc, 0), { width: 1, height: 1, data: new Uint8Array(4) }, undefined, ["flat_faces"]);
    expect(wrongSize[0]?.skipped_reason).toContain("1x1");
  });
});

describe("model texture gates", () => {
  const violationsOf = (doc: IBBModel, gate: TextureGateId): string[] => runModelTextureGates(doc, undefined, [gate]).flatMap((result) => result.violations.map((violation) => violation.message));

  test("untextured_faces reports elements without a texture", () => {
    expect(violationsOf(model([arm("arm")]), "untextured_faces")).toEqual([]);
    const bare = model([{ op: "add_cube", name: "bare", from: [0, 0, 0], to: [4, 6, 2] }]);
    expect(violationsOf(bare, "untextured_faces")).toEqual([expect.stringContaining('"bare" has faces without a texture')]);
    const noTextures = applyOperations(emptyModel("bedrock", "empty", true, { width: 16, height: 16 }), operationSchema.array().parse([{ op: "add_cube", name: "c", from: [0, 0, 0], to: [1, 1, 1] }])).doc;
    expect(violationsOf(noTextures, "untextured_faces")).toEqual(["The model has no textures."]);
  });

  test("texel_density flags stretched faces and uneven density", () => {
    expect(violationsOf(model([arm("arm")]), "texel_density")).toEqual([]);
    const stretched = model([{ op: "add_cube", name: "wide", from: [0, 0, 0], to: [4, 4, 4], box_uv: false, texture: 0, faces: { north: { uv: [0, 0, 16, 4] } } }]);
    expect(violationsOf(stretched, "texel_density").some((message) => message.startsWith('"wide" stretches the texture on: north'))).toBe(true);
  });
});
