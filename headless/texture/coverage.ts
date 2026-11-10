/**
 * Which texture pixels each face covers.
 *
 * Shared by the UV template, which draws the layout, and the texture gates,
 * which read the painted pixels under each face.
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

/** One face's outline on the texture. */
export interface IFaceOutline {
  /** Index into {@link IFaceCoverage.drawable}. */
  element: number;
  /** Cube face name or mesh face key. */
  face: string;
  /** Polygon in texture pixels. */
  points: Vec2[];
  region: IUvFaceRegion;
}

/** The faces of a model laid over one texture. */
export interface IFaceCoverage {
  /** Texture size in pixels. */
  width: number;
  height: number;
  /** Cubes and meshes, in document order. */
  drawable: (ICube | IMesh)[];
  outlines: IFaceOutline[];
  /** Per texture pixel, the index of the last outline covering it, or {@link UNCOVERED}. */
  owner: Int32Array;
  /** Pairs of outline indexes that share pixels. */
  overlaps: [number, number][];
}

/** Value of {@link IFaceCoverage.owner} where no face reaches. */
export const UNCOVERED = -1;

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

type ToPixels = (uv: Vec2) => Vec2;

function cubeOutlines(doc: IBBModel, cube: ICube, element: number, texture: number | undefined, toPixels: ToPixels): IFaceOutline[] {
  return CUBE_FACES.flatMap((name) => {
    const face = cube.faces[name];
    if (!face || !usesTexture(doc, face, texture)) return [];
    const [u1, v1, u2, v2] = face.uv;
    const points = ([[u1, v1], [u2, v1], [u2, v2], [u1, v2]] satisfies Vec2[]).map(toPixels);
    const flip = flipOf(u1, v1, u2, v2);
    return [{ element, face: name, points, region: regionOf(points, { ...(flip ? { flip } : {}), ...(face.rotation ? { rotation: face.rotation } : {}) }) }];
  });
}

function meshOutlines(doc: IBBModel, mesh: IMesh, element: number, texture: number | undefined, toPixels: ToPixels): IFaceOutline[] {
  const lookup = lookupIn(mesh);
  return Object.entries(mesh.faces)
    .filter(([, face]) => face.vertices.length >= 3 && usesTexture(doc, face, texture))
    .map(([key, face]) => {
      const points = sortedVertices(lookup, face).map((vertex) => toPixels(face.uv[vertex] ?? [0, 0]));
      return { element, face: key, points, region: regionOf(points) };
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

/** Size of a texture in pixels and the UV-to-pixel conversion; the model's resolution when no texture is given. */
function textureSpace(doc: IBBModel, texture: number | undefined): { width: number; height: number; toPixels: ToPixels } {
  const entry = texture === undefined ? undefined : doc.textures[texture];
  const width = entry?.width ?? doc.resolution.width;
  const height = entry?.height ?? doc.resolution.height;
  const factorX = width / (entry?.uv_width ?? doc.resolution.width);
  const factorY = height / (entry?.uv_height ?? doc.resolution.height);
  return { width, height, toPixels: ([u, v]) => [u * factorX, v * factorY] };
}

function assignPixels(outlines: readonly IFaceOutline[], width: number, height: number): Pick<IFaceCoverage, "owner" | "overlaps"> {
  const owner = new Int32Array(width * height).fill(UNCOVERED);
  const overlaps = new Map<string, [number, number]>();
  outlines.forEach((outline, id) => {
    const { minX, minY, maxX, maxY } = boundsOf(outline.points);
    for (let y = Math.max(0, minY); y < Math.min(height, maxY); y++) {
      for (let x = Math.max(0, minX); x < Math.min(width, maxX); x++) {
        if (!isInside(outline.points, x + 0.5, y + 0.5)) continue;
        const previous = owner[y * width + x] ?? UNCOVERED;
        if (previous !== UNCOVERED) overlaps.set(`${previous}:${id}`, [previous, id]);
        owner[y * width + x] = id;
      }
    }
  });
  return { owner, overlaps: [...overlaps.values()] };
}

/**
 * Lays the model's cube and mesh faces over a texture.
 *
 * @param texture - Only faces using this texture index, at its size; every enabled face at the model's resolution when absent.
 */
export function coverFaces(doc: IBBModel, texture?: number): IFaceCoverage {
  const { width, height, toPixels } = textureSpace(doc, texture);
  const drawable = doc.elements.filter((element): element is ICube | IMesh => isCube(element) || isMesh(element));
  const outlines = drawable.flatMap((element, index) =>
    isCube(element) ? cubeOutlines(doc, element, index, texture, toPixels) : meshOutlines(doc, element, index, texture, toPixels),
  );
  return { width, height, drawable, outlines, ...assignPixels(outlines, width, height) };
}

/** Name of the element an outline belongs to. */
export const elementName = (coverage: IFaceCoverage, outline: IFaceOutline): string => coverage.drawable[outline.element]?.name ?? "";

/** `element.face` label of an outline. */
export const faceLabel = (coverage: IFaceCoverage, outline: IFaceOutline): string => `${elementName(coverage, outline)}.${outline.face}`;

/** Whether a face reaches past the texture. */
export function reachesOutside(coverage: IFaceCoverage, { region: { rect } }: IFaceOutline): boolean {
  return rect[0] < 0 || rect[1] < 0 || rect[0] + rect[2] > coverage.width || rect[1] + rect[3] > coverage.height;
}

/** Whether a string names a cube face. */
export const isCubeFaceName = (face: string): face is CubeFaceName => (CUBE_FACES as readonly string[]).includes(face);
