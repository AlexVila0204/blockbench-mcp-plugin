/**
 * UV template: a picture of where every face sits on the texture.
 *
 * An agent that paints a texture outside Blockbench cannot see the UV editor,
 * so it needs the layout as an image plus the face rectangles as numbers. Each
 * element gets its own hue and each face its own lightness, which also tells
 * the faces of one cube apart at native size, where there is no room for labels.
 *
 * @module
 */

import type { CubeFaceName, IBBModel } from "../document/schema";
import { coverFaces, elementName, faceLabel, isCubeFaceName, reachesOutside, UNCOVERED, type IFaceCoverage, type IUvFaceRegion } from "./coverage";

export type { IUvFaceRegion, PixelRect } from "./coverage";

/** The faces of one element. */
export interface IUvElementRegions {
  name: string;
  uuid: string;
  type: "cube" | "mesh";
  /** Base color of the element in the image, `#rrggbb`. */
  color: string;
  faces: Record<string, IUvFaceRegion>;
}

/** A rendered template with its legend. */
export interface IUvTemplate {
  /** Image size in pixels, already multiplied by `scale`. */
  width: number;
  height: number;
  scale: number;
  /** RGBA8, top row first; pixels no face covers are transparent. */
  rgba: Uint8Array;
  elements: IUvElementRegions[];
  /** Pairs of `element.face` that share texture pixels. */
  overlaps: [string, string][];
  /** Elements with a face reaching past the texture. */
  outside: string[];
}

export interface IUvTemplateOptions {
  /** Only faces using this texture index; all enabled faces when absent. */
  texture?: number;
  /** Image pixels per texture pixel. */
  scale: number;
}

const FACE_LIGHTNESS: Record<CubeFaceName, number> = { up: 0.74, north: 0.64, east: 0.58, south: 0.52, west: 0.46, down: 0.38 };
const MESH_LIGHTNESS = [0.7, 0.58, 0.46] as const;
const SATURATION = 0.55;
const LEGEND_LIGHTNESS = 0.58;
const BORDER_DARKENING = 0.55;
/** Below this scale a border would hide the face it outlines. */
const BORDER_MIN_SCALE = 3;
const GOLDEN_ANGLE = 137.508;

type Rgb = [number, number, number];

function hslToRgb(hue: number, saturation: number, lightness: number): Rgb {
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const channel = (offset: number): number => {
    const k = (offset + hue / 30) % 12;
    return Math.round(255 * (lightness - (chroma / 2) * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return [channel(0), channel(8), channel(4)];
}

const toHex = (rgb: Rgb): string => `#${rgb.map((value) => value.toString(16).padStart(2, "0")).join("")}`;

const elementHue = (index: number): number => (index * GOLDEN_ANGLE) % 360;

/** Lightness per outline: fixed per cube face, cycling through the faces of a mesh. */
function outlineLightness(coverage: IFaceCoverage): number[] {
  const meshFaceCount = new Map<number, number>();
  return coverage.outlines.map(({ element, face }) => {
    if (coverage.drawable[element]?.type === "cube" && isCubeFaceName(face)) return FACE_LIGHTNESS[face];
    const seen = meshFaceCount.get(element) ?? 0;
    meshFaceCount.set(element, seen + 1);
    return MESH_LIGHTNESS[seen % MESH_LIGHTNESS.length] ?? LEGEND_LIGHTNESS;
  });
}

function paint(coverage: IFaceCoverage, scale: number): Uint8Array {
  const { width, height, owner, outlines } = coverage;
  const lightness = outlineLightness(coverage);
  const colorOf = (darkening: number) => outlines.map((outline, id) => hslToRgb(elementHue(outline.element), SATURATION, (lightness[id] ?? LEGEND_LIGHTNESS) * darkening));
  const fills = colorOf(1);
  const borders = colorOf(BORDER_DARKENING);
  const ownerAt = (x: number, y: number): number => (x < 0 || y < 0 || x >= width || y >= height ? UNCOVERED : owner[y * width + x] ?? UNCOVERED);
  const rgba = new Uint8Array(width * scale * height * scale * 4);
  for (let py = 0; py < height * scale; py++) {
    for (let px = 0; px < width * scale; px++) {
      const x = Math.floor(px / scale);
      const y = Math.floor(py / scale);
      const id = ownerAt(x, y);
      if (id === UNCOVERED) continue;
      const localX = px % scale;
      const localY = py % scale;
      const onEdge =
        scale >= BORDER_MIN_SCALE &&
        ((localX === 0 && ownerAt(x - 1, y) !== id) ||
          (localX === scale - 1 && ownerAt(x + 1, y) !== id) ||
          (localY === 0 && ownerAt(x, y - 1) !== id) ||
          (localY === scale - 1 && ownerAt(x, y + 1) !== id));
      const [r, g, b] = (onEdge ? borders[id] : fills[id]) ?? [0, 0, 0];
      rgba.set([r, g, b, 255], (py * width * scale + px) * 4);
    }
  }
  return rgba;
}

/**
 * Draws the UV layout of a model's cubes and meshes.
 *
 * @throws Error when no face matches.
 */
export function buildUvTemplate(doc: IBBModel, options: IUvTemplateOptions): IUvTemplate {
  const coverage = coverFaces(doc, options.texture);
  const { outlines, drawable } = coverage;
  if (outlines.length === 0) throw new Error(options.texture === undefined ? "The model has no faces to draw." : "No face uses this texture.");

  const elements = drawable.flatMap((element, index): IUvElementRegions[] => {
    const faces = outlines.filter((outline) => outline.element === index);
    if (faces.length === 0) return [];
    return [
      {
        name: element.name,
        uuid: element.uuid,
        type: element.type,
        color: toHex(hslToRgb(elementHue(index), SATURATION, LEGEND_LIGHTNESS)),
        faces: Object.fromEntries(faces.map((outline) => [outline.face, outline.region])),
      },
    ];
  });
  const labelAt = (id: number): string => {
    const outline = outlines[id];
    return outline ? faceLabel(coverage, outline) : "";
  };

  return {
    width: coverage.width * options.scale,
    height: coverage.height * options.scale,
    scale: options.scale,
    rgba: paint(coverage, options.scale),
    elements,
    overlaps: coverage.overlaps.map(([a, b]) => [labelAt(a), labelAt(b)]),
    outside: [...new Set(outlines.filter((outline) => reachesOutside(coverage, outline)).map((outline) => elementName(coverage, outline)))],
  };
}
