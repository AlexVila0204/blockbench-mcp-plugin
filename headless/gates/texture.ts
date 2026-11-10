/**
 * Texture gates: UV layout and painted-pixel checks.
 *
 * Geometry gates cannot tell whether a model is textured well. These read the
 * UV layout and the texture's pixels, and catch what otherwise only shows in a
 * render: faces sharing pixels, faces left blank, paint no face shows, stretched
 * faces.
 *
 * @module
 */

import { CUBE_FACES, isCube, isMesh, type CubeFaceName, type IBBModel, type ICube } from "../document/schema";
import { elementName, faceLabel, reachesOutside, UNCOVERED, type IFaceCoverage, type IFaceOutline } from "../texture/coverage";
import { gateResult, skippedGate, type IGateResult, type IGateViolation } from "./types";

/** Decoded texture pixels: tightly packed RGBA8, top row first. */
export interface ITextureImage {
  width: number;
  height: number;
  data: Uint8Array;
}

/** Gates that run once per texture. */
export const TEXTURE_GATE_IDS = ["uv_bounds", "uv_overlap", "unpainted_faces", "flat_faces", "stray_pixels", "color_count"] as const;

/** Gates that run once per model. */
export const MODEL_TEXTURE_GATE_IDS = ["untextured_faces", "texel_density"] as const;

export type TextureGateId = (typeof TEXTURE_GATE_IDS)[number] | (typeof MODEL_TEXTURE_GATE_IDS)[number];

export interface ITextureGateOptions {
  /** More distinct colors than this is flagged. */
  maxColors: number;
  /** Faces smaller than this many pixels are not checked for flat color. */
  minFacePixels: number;
  /** How far a face's texel density may be from the model's median, as a ratio. */
  densityTolerance: number;
  /** How far a face's horizontal and vertical texel density may differ, as a ratio. */
  stretchTolerance: number;
}

export const DEFAULT_TEXTURE_OPTIONS: ITextureGateOptions = { maxColors: 64, minFacePixels: 16, densityTolerance: 2, stretchTolerance: 1.5 };

const LABELS: Record<TextureGateId, string> = {
  uv_bounds: "Faces inside the texture",
  uv_overlap: "Faces do not share pixels",
  unpainted_faces: "Faces are painted",
  flat_faces: "Faces have more than one color",
  stray_pixels: "No paint outside faces",
  color_count: "Limited palette",
  untextured_faces: "Faces have a texture",
  texel_density: "Even texel density",
};

const EPSILON = 0.0001;

/** Groups items into one violation per key, listing the grouped details in the message. */
function violationsBy<T>(items: readonly T[], keyOf: (item: T) => string, detailOf: (item: T) => string, message: (key: string, details: string) => string): IGateViolation[] {
  return [...Map.groupBy(items, keyOf)].map(([key, group]) => ({ message: message(key, group.map(detailOf).join(", ")), targets: key.split("\n") }));
}

function uvBoundsGate(coverage: IFaceCoverage): IGateViolation[] {
  const outside = coverage.outlines.filter((outline) => reachesOutside(coverage, outline));
  return violationsBy(
    outside,
    (outline) => elementName(coverage, outline),
    (outline) => outline.face,
    (name, faces) => `"${name}" has faces reaching past the ${coverage.width}x${coverage.height} texture: ${faces}.`,
  );
}

const sameRect = (a: IFaceOutline, b: IFaceOutline): boolean => a.region.rect.every((value, index) => value === b.region.rect[index]);

/** Faces with the same rectangle share their pixels on purpose (mirrored limbs, repeated parts). */
function uvOverlapGate(coverage: IFaceCoverage): IGateViolation[] {
  const pairs = coverage.overlaps.flatMap(([a, b]) => {
    const first = coverage.outlines[a];
    const second = coverage.outlines[b];
    return first && second && !sameRect(first, second) ? [{ first, second }] : [];
  });
  return violationsBy(
    pairs,
    ({ first, second }) => [...new Set([elementName(coverage, first), elementName(coverage, second)])].join("\n"),
    ({ first, second }) => `${first.face}/${second.face}`,
    (names, faces) => `${names.split("\n").map((name) => `"${name}"`).join(" and ")} have faces sharing texture pixels: ${faces}.`,
  );
}

/** Pixel indexes each outline owns. */
function pixelsByOutline(coverage: IFaceCoverage): number[][] {
  const pixels: number[][] = coverage.outlines.map(() => []);
  coverage.owner.forEach((id, pixel) => pixels[id]?.push(pixel));
  return pixels;
}

const colorAt = (image: ITextureImage, pixel: number): number =>
  (((image.data[pixel * 4] ?? 0) << 24) | ((image.data[pixel * 4 + 1] ?? 0) << 16) | ((image.data[pixel * 4 + 2] ?? 0) << 8) | (image.data[pixel * 4 + 3] ?? 0)) >>> 0;

const isTransparent = (image: ITextureImage, pixel: number): boolean => (image.data[pixel * 4 + 3] ?? 0) === 0;

function facesWhere(coverage: IFaceCoverage, test: (pixels: readonly number[]) => boolean, message: (name: string, faces: string) => string): IGateViolation[] {
  const pixels = pixelsByOutline(coverage);
  const matching = coverage.outlines.filter((_, id) => test(pixels[id] ?? []));
  return violationsBy(matching, (outline) => elementName(coverage, outline), (outline) => outline.face, message);
}

function unpaintedGate(coverage: IFaceCoverage, image: ITextureImage): IGateViolation[] {
  return facesWhere(
    coverage,
    (pixels) => pixels.length > 0 && pixels.every((pixel) => isTransparent(image, pixel)),
    (name, faces) => `"${name}" has fully transparent faces: ${faces}.`,
  );
}

function flatFacesGate(coverage: IFaceCoverage, image: ITextureImage, options: ITextureGateOptions): IGateViolation[] {
  return facesWhere(
    coverage,
    (pixels) => {
      const first = pixels[0];
      if (first === undefined || pixels.length < options.minFacePixels || isTransparent(image, first)) return false;
      return pixels.every((pixel) => colorAt(image, pixel) === colorAt(image, first));
    },
    (name, faces) => `"${name}" has faces filled with one flat color: ${faces}.`,
  );
}

function strayPixelsGate(coverage: IFaceCoverage, image: ITextureImage): IGateViolation[] {
  const stray = [...coverage.owner.keys()].filter((pixel) => coverage.owner[pixel] === UNCOVERED && !isTransparent(image, pixel));
  if (stray.length === 0) return [];
  const box = stray.reduce(
    (bounds, pixel) => {
      const x = pixel % coverage.width;
      const y = Math.floor(pixel / coverage.width);
      return { minX: Math.min(bounds.minX, x), minY: Math.min(bounds.minY, y), maxX: Math.max(bounds.maxX, x), maxY: Math.max(bounds.maxY, y) };
    },
    { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity },
  );
  const rect = [box.minX, box.minY, box.maxX - box.minX + 1, box.maxY - box.minY + 1];
  return [{ message: `${stray.length} painted pixels lie outside every face, within [${rect.join(", ")}].`, targets: [] }];
}

/** Distinct colors among the pixels that are not fully transparent. */
export function countColors(image: ITextureImage): number {
  const colors = new Set<number>();
  for (let pixel = 0; pixel < image.width * image.height; pixel++) {
    if (!isTransparent(image, pixel)) colors.add(colorAt(image, pixel));
  }
  return colors.size;
}

function colorCountGate(image: ITextureImage, options: ITextureGateOptions): IGateViolation[] {
  const colors = countColors(image);
  return colors > options.maxColors ? [{ message: `The texture has ${colors} colors; the limit is ${options.maxColors}.`, targets: [] }] : [];
}

/**
 * Runs the per-texture gates.
 *
 * @param coverage - The faces using the texture, from `coverFaces(doc, textureIndex)`.
 * @param image - The texture's pixels, or why they are not available.
 */
export function runTextureGates(
  coverage: IFaceCoverage,
  image: ITextureImage | { unavailable: string },
  options: ITextureGateOptions = DEFAULT_TEXTURE_OPTIONS,
  gates: readonly TextureGateId[] = TEXTURE_GATE_IDS,
): IGateResult[] {
  const pixelGate = (id: TextureGateId, run: (pixels: ITextureImage) => IGateViolation[]): IGateResult => {
    if ("unavailable" in image) return skippedGate(id, LABELS[id], "warning", image.unavailable);
    const fits = image.width === coverage.width && image.height === coverage.height;
    if (!fits) return skippedGate(id, LABELS[id], "warning", `The image is ${image.width}x${image.height} but the texture entry says ${coverage.width}x${coverage.height}.`);
    return gateResult(id, LABELS[id], "warning", run(image));
  };
  const all: Record<(typeof TEXTURE_GATE_IDS)[number], () => IGateResult> = {
    uv_bounds: () => gateResult("uv_bounds", LABELS.uv_bounds, "error", uvBoundsGate(coverage)),
    uv_overlap: () => gateResult("uv_overlap", LABELS.uv_overlap, "warning", uvOverlapGate(coverage)),
    unpainted_faces: () => pixelGate("unpainted_faces", (pixels) => unpaintedGate(coverage, pixels)),
    flat_faces: () => pixelGate("flat_faces", (pixels) => flatFacesGate(coverage, pixels, options)),
    stray_pixels: () => pixelGate("stray_pixels", (pixels) => strayPixelsGate(coverage, pixels)),
    color_count: () => pixelGate("color_count", (pixels) => colorCountGate(pixels, options)),
  };
  return TEXTURE_GATE_IDS.filter((id) => gates.includes(id)).map((id) => all[id]());
}

function hasTexture(doc: IBBModel, face: { texture?: string | number | null }): boolean {
  if (typeof face.texture === "number") return face.texture >= 0 && face.texture < doc.textures.length;
  return doc.textures.some((texture) => texture.uuid === face.texture);
}

function untexturedGate(doc: IBBModel): IGateViolation[] {
  if (doc.textures.length === 0) return [{ message: "The model has no textures.", targets: [] }];
  return doc.elements
    .filter((element) => isCube(element) || isMesh(element))
    .flatMap((element) => {
      const faces: [string, { texture?: string | number | null }][] = Object.entries(element.faces);
      const missing = faces.filter(([, face]) => face.texture !== null && !hasTexture(doc, face)).map(([name]) => name);
      return missing.length > 0 ? [{ message: `"${element.name}" has faces without a texture: ${missing.join(", ")}.`, targets: [element.name] }] : [];
    });
}

/** Which cube axes run along a face's width and height. */
const FACE_AXES: Record<CubeFaceName, readonly [0 | 1 | 2, 0 | 1 | 2]> = { north: [0, 1], south: [0, 1], east: [2, 1], west: [2, 1], up: [0, 2], down: [0, 2] };

interface IFaceDensity {
  cube: string;
  face: CubeFaceName;
  /** UV units per model unit along the face's width and height. */
  across: number;
  down: number;
}

function cubeDensities(cube: ICube): IFaceDensity[] {
  return CUBE_FACES.flatMap((name) => {
    const face = cube.faces[name];
    if (!face || face.texture === null) return [];
    const [widthAxis, heightAxis] = FACE_AXES[name];
    const sideways = Math.abs(face.rotation ?? 0) % 180 === 90;
    const size = [Math.abs(cube.to[widthAxis] - cube.from[widthAxis]), Math.abs(cube.to[heightAxis] - cube.from[heightAxis])] as const;
    const [width, height] = sideways ? [size[1], size[0]] : size;
    const uv = [Math.abs(face.uv[2] - face.uv[0]), Math.abs(face.uv[3] - face.uv[1])] as const;
    if (width < EPSILON || height < EPSILON || uv[0] < EPSILON || uv[1] < EPSILON) return [];
    return [{ cube: cube.name, face: name, across: uv[0] / width, down: uv[1] / height }];
  });
}

const ratio = (a: number, b: number): number => Math.max(a, b) / Math.min(a, b);
const overall = (density: IFaceDensity): number => Math.sqrt(density.across * density.down);

function median(values: readonly number[]): number {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 1;
}

function texelDensityGate(doc: IBBModel, options: ITextureGateOptions): IGateViolation[] {
  const densities = doc.elements.filter(isCube).flatMap(cubeDensities);
  const typical = median(densities.map(overall));
  const stretched = densities.filter((density) => ratio(density.across, density.down) > options.stretchTolerance);
  const uneven = densities.filter((density) => ratio(overall(density), typical) > options.densityTolerance);
  const byCube = (items: readonly IFaceDensity[], message: (name: string, faces: string) => string): IGateViolation[] =>
    violationsBy(items, (density) => density.cube, (density) => density.face, message);
  return [
    ...byCube(stretched, (name, faces) => `"${name}" stretches the texture on: ${faces}.`),
    ...byCube(uneven, (name, faces) => `"${name}" has a texel density far from the rest of the model (${typical.toFixed(2)} per unit) on: ${faces}.`),
  ];
}

/** Runs the gates that look at the whole model. */
export function runModelTextureGates(doc: IBBModel, options: ITextureGateOptions = DEFAULT_TEXTURE_OPTIONS, gates: readonly TextureGateId[] = MODEL_TEXTURE_GATE_IDS): IGateResult[] {
  const all: Record<(typeof MODEL_TEXTURE_GATE_IDS)[number], () => IGateResult> = {
    untextured_faces: () => gateResult("untextured_faces", LABELS.untextured_faces, "warning", untexturedGate(doc)),
    texel_density: () => gateResult("texel_density", LABELS.texel_density, "warning", texelDensityGate(doc, options)),
  };
  return MODEL_TEXTURE_GATE_IDS.filter((id) => gates.includes(id)).map((id) => all[id]());
}
