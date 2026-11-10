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

import { CUBE_FACES, isCube, isMesh, type CubeFaceName, type IBBModel, type ICube, type IMesh, type Vec2 } from "../document/schema";
import { lookupIn, sortedVertices } from "../mesh/face";

/** Pixel rectangle `[x, y, width, height]` in texture pixels. */
export type PixelRect = [number, number, number, number];

/** Where one face sits on the texture. */
export interface IUvFaceRegion {
  rect: PixelRect;
  /** Axes along which the face reads the texture mirrored. */
  flip?: "x" | "y" | "xy";
  rotation?: number;
}

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

interface IFaceOutline {
  element: number;
  face: string;
  /** Polygon in texture pixels. */
  points: Vec2[];
  lightness: number;
  region: IUvFaceRegion;
}

const FACE_LIGHTNESS: Record<CubeFaceName, number> = { up: 0.74, north: 0.64, east: 0.58, south: 0.52, west: 0.46, down: 0.38 };
const MESH_LIGHTNESS = [0.7, 0.58, 0.46] as const;
const SATURATION = 0.55;
const LEGEND_LIGHTNESS = 0.58;
const BORDER_DARKENING = 0.55;
/** Below this scale a border would hide the face it outlines. */
const BORDER_MIN_SCALE = 3;
const GOLDEN_ANGLE = 137.508;
const EMPTY = -1;

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

function boundsOf(points: readonly Vec2[]): { minX: number; minY: number; maxX: number; maxY: number } {
  const xs = points.map((point) => point[0]);
  const ys = points.map((point) => point[1]);
  return { minX: Math.floor(Math.min(...xs)), minY: Math.floor(Math.min(...ys)), maxX: Math.ceil(Math.max(...xs)), maxY: Math.ceil(Math.max(...ys)) };
}

function regionOf(points: readonly Vec2[], extra: Omit<IUvFaceRegion, "rect"> = {}): IUvFaceRegion {
  const { minX, minY, maxX, maxY } = boundsOf(points);
  return { rect: [minX, minY, maxX - minX, maxY - minY], ...extra };
}

function usesTexture(doc: IBBModel, face: { texture?: string | number | null }, texture: number | undefined): boolean {
  if (face.texture === null) return false;
  if (texture === undefined) return true;
  return face.texture === texture || face.texture === doc.textures[texture]?.uuid;
}

function flipOf(u1: number, v1: number, u2: number, v2: number): IUvFaceRegion["flip"] {
  const axes = `${u2 < u1 ? "x" : ""}${v2 < v1 ? "y" : ""}`;
  return axes === "" ? undefined : (axes as IUvFaceRegion["flip"]);
}

function cubeOutlines(doc: IBBModel, cube: ICube, element: number, options: IUvTemplateOptions, toPixels: (uv: Vec2) => Vec2): IFaceOutline[] {
  return CUBE_FACES.flatMap((name) => {
    const face = cube.faces[name];
    if (!face || !usesTexture(doc, face, options.texture)) return [];
    const [u1, v1, u2, v2] = face.uv;
    const points = ([[u1, v1], [u2, v1], [u2, v2], [u1, v2]] satisfies Vec2[]).map(toPixels);
    const flip = flipOf(u1, v1, u2, v2);
    const region = regionOf(points, { ...(flip ? { flip } : {}), ...(face.rotation ? { rotation: face.rotation } : {}) });
    return [{ element, face: name, points, lightness: FACE_LIGHTNESS[name], region }];
  });
}

function meshOutlines(doc: IBBModel, mesh: IMesh, element: number, options: IUvTemplateOptions, toPixels: (uv: Vec2) => Vec2): IFaceOutline[] {
  const lookup = lookupIn(mesh);
  return Object.entries(mesh.faces)
    .filter(([, face]) => face.vertices.length >= 3 && usesTexture(doc, face, options.texture))
    .map(([key, face], index) => {
      const points = sortedVertices(lookup, face).map((vertex) => toPixels(face.uv[vertex] ?? [0, 0]));
      return { element, face: key, points, lightness: MESH_LIGHTNESS[index % MESH_LIGHTNESS.length] ?? LEGEND_LIGHTNESS, region: regionOf(points) };
    });
}

/** Even-odd test of a point against a polygon. */
function isInside(points: readonly Vec2[], x: number, y: number): boolean {
  return points.reduce((inside, [ax, ay], index) => {
    const [bx, by] = points[(index + points.length - 1) % points.length] ?? [ax, ay];
    const crosses = ay > y !== by > y && x < ((bx - ax) * (y - ay)) / (by - ay) + ax;
    return crosses ? !inside : inside;
  }, false);
}

/** Size of the template in texture pixels and the UV-to-pixel factors. */
function textureSpace(doc: IBBModel, texture: number | undefined): { width: number; height: number; toPixels: (uv: Vec2) => Vec2 } {
  const entry = texture === undefined ? undefined : doc.textures[texture];
  const width = entry?.width ?? doc.resolution.width;
  const height = entry?.height ?? doc.resolution.height;
  const factorX = width / (entry?.uv_width ?? doc.resolution.width);
  const factorY = height / (entry?.uv_height ?? doc.resolution.height);
  return { width, height, toPixels: ([u, v]) => [u * factorX, v * factorY] };
}

interface ICoverage {
  /** Index into the outlines per texture pixel, or {@link EMPTY}. */
  owner: Int32Array;
  overlaps: [string, string][];
}

function coverTexture(outlines: readonly IFaceOutline[], labelOf: (outline: IFaceOutline) => string, width: number, height: number): ICoverage {
  const owner = new Int32Array(width * height).fill(EMPTY);
  const overlaps = new Map<string, [string, string]>();
  outlines.forEach((outline, id) => {
    const { minX, minY, maxX, maxY } = boundsOf(outline.points);
    for (let y = Math.max(0, minY); y < Math.min(height, maxY); y++) {
      for (let x = Math.max(0, minX); x < Math.min(width, maxX); x++) {
        if (!isInside(outline.points, x + 0.5, y + 0.5)) continue;
        const previous = outlines[owner[y * width + x] ?? EMPTY];
        if (previous) overlaps.set(`${owner[y * width + x]}:${id}`, [labelOf(previous), labelOf(outline)]);
        owner[y * width + x] = id;
      }
    }
  });
  return { owner, overlaps: [...overlaps.values()] };
}

function paint(outlines: readonly IFaceOutline[], owner: Int32Array, width: number, height: number, scale: number): Uint8Array {
  const fills = outlines.map((outline) => hslToRgb(elementHue(outline.element), SATURATION, outline.lightness));
  const borders = outlines.map((outline) => hslToRgb(elementHue(outline.element), SATURATION, outline.lightness * BORDER_DARKENING));
  const ownerAt = (x: number, y: number): number => (x < 0 || y < 0 || x >= width || y >= height ? EMPTY : owner[y * width + x] ?? EMPTY);
  const rgba = new Uint8Array(width * scale * height * scale * 4);
  for (let py = 0; py < height * scale; py++) {
    for (let px = 0; px < width * scale; px++) {
      const x = Math.floor(px / scale);
      const y = Math.floor(py / scale);
      const id = ownerAt(x, y);
      if (id === EMPTY) continue;
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
  const { width, height, toPixels } = textureSpace(doc, options.texture);
  const drawable = doc.elements.filter((element): element is ICube | IMesh => isCube(element) || isMesh(element));
  const outlines = drawable.flatMap((element, index) =>
    isCube(element) ? cubeOutlines(doc, element, index, options, toPixels) : meshOutlines(doc, element, index, options, toPixels),
  );
  if (outlines.length === 0) throw new Error(options.texture === undefined ? "The model has no faces to draw." : "No face uses this texture.");

  const labelOf = (outline: IFaceOutline): string => `${drawable[outline.element]?.name ?? ""}.${outline.face}`;
  const { owner, overlaps } = coverTexture(outlines, labelOf, width, height);
  const reachesOutside = ({ region: { rect } }: IFaceOutline): boolean => rect[0] < 0 || rect[1] < 0 || rect[0] + rect[2] > width || rect[1] + rect[3] > height;
  const outside = [...new Set(outlines.filter(reachesOutside).map((outline) => drawable[outline.element]?.name ?? ""))];

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

  return {
    width: width * options.scale,
    height: height * options.scale,
    scale: options.scale,
    rgba: paint(outlines, owner, width, height, options.scale),
    elements,
    overlaps,
    outside,
  };
}
