/**
 * Texture authoring aids: what an agent needs to paint a texture in an outside
 * image editor, bring it back with `bbmodel_add_texture`, and check the result.
 *
 * @module
 */

import { dirname } from "node:path";
import { z } from "zod";
import { decodePngDataUrl } from "../document/png";
import type { IBBModel, ITexture } from "../document/schema";
import type { ModelStore } from "../document/store";
import { resolveTexture } from "../edit/operations";
import {
  countColors,
  DEFAULT_TEXTURE_OPTIONS,
  MODEL_TEXTURE_GATE_IDS,
  runModelTextureGates,
  runTextureGates,
  TEXTURE_GATE_IDS,
  type ITextureImage,
} from "../gates/texture";
import { summarizeGates } from "../gates/types";
import { decodePng, encodePng } from "../render/engine/png";
import { textureImage } from "../render/input";
import { coverFaces } from "../texture/coverage";
import { buildUvTemplate } from "../texture/uv-template";
import { defineTool, fileParam, type IRegistrableTool } from "../tool";
import { imageContent, outputPath } from "./image-output";

const MAX_IMAGE_SIDE = 4096;
const OVERLAP_LIMIT = 20;

const uvTemplateTool = defineTool({
  name: "bbmodel_uv_template",
  title: "UV Template",
  description:
    "Draws where every cube and mesh face sits on the texture and returns the image, its path, and each face's pixel rectangle [x, y, width, height]. Each element has its own hue and each face its own lightness (up lightest, then north, east, south, west, down darkest); uncovered pixels are transparent. Use it before painting a texture: at scale 1 the image has the texture's exact size and works as a base layer, larger scales add outlines for viewing. Faces listed in overlaps share pixels and need separate UVs first (bbmodel_edit update_node with uv_offset or faces). flip marks faces that read the texture mirrored.",
  parameters: {
    file: fileParam,
    texture: z.union([z.string(), z.number().int().min(0)]).optional().describe("Only faces using this texture (UUID, name or index), at that texture's size. Defaults to every enabled face at the model's resolution."),
    scale: z.number().int().min(1).max(32).default(1).describe("Image pixels per texture pixel."),
    output: z.string().optional().describe("PNG path inside the workspace; defaults to a scratch file outside it."),
    overwrite: z.boolean().default(false).describe("Allow output to replace an existing PNG."),
  },
  // Not read-only: an explicit output path writes into the workspace, and may replace a PNG there.
  readOnly: false,
  destructive: true,
  async execute({ file, texture, scale, output, overwrite }, context) {
    const { doc, path, revision } = await context.store.read(file);
    const template = buildUvTemplate(doc, { texture: texture === undefined ? undefined : resolveTexture(doc, texture), scale });
    if (Math.max(template.width, template.height) > MAX_IMAGE_SIDE) throw new Error(`The image would be ${template.width}x${template.height}; lower scale to stay within ${MAX_IMAGE_SIDE} pixels.`);
    const target = await outputPath(context, path, "uv", output, overwrite);
    await Bun.write(target, encodePng(template.rgba, template.width, template.height));
    const summary = {
      revision,
      path: target,
      width: template.width,
      height: template.height,
      scale: template.scale,
      elements: template.elements,
      overlap_count: template.overlaps.length,
      overlaps: template.overlaps.slice(0, OVERLAP_LIMIT),
      outside_texture: template.outside,
    };
    return { content: [{ type: "text", text: JSON.stringify(summary) }, await imageContent(target)] };
  },
});

/** Normal, height and MER maps are data, not paint, so the paint gates would misread them. */
const isColorTexture = (texture: ITexture): boolean => texture.group === undefined || (texture.pbr_channel ?? "color") === "color";

async function loadPixels(store: ModelStore, modelPath: string, texture: ITexture): Promise<ITextureImage | { unavailable: string }> {
  const image = await textureImage(store, dirname(modelPath), texture);
  if (image.source === undefined) return { unavailable: image.problems.join(" ") || "The texture has no image." };
  try {
    return decodePng(decodePngDataUrl(image.source));
  } catch (error) {
    return { unavailable: error instanceof Error ? error.message : String(error) };
  }
}

function chosenTextures(doc: IBBModel, refs: readonly (string | number)[] | undefined): number[] {
  if (refs !== undefined) return refs.map((ref) => resolveTexture(doc, ref));
  return doc.textures.flatMap((texture, index) => (isColorTexture(texture) ? [index] : []));
}

const GATE_IDS = [...MODEL_TEXTURE_GATE_IDS, ...TEXTURE_GATE_IDS] as const;

const validateTexturesTool = defineTool({
  name: "bbmodel_validate_textures",
  title: "Validate Textures",
  description: [
    "Checks a .bbmodel file's UV layout and painted textures, and reports every finding by element and face.",
    "Model gates: untextured_faces (enabled faces with no texture), texel_density (cube faces that stretch the texture, or whose pixel density is far from the model's median).",
    "Per-texture gates: uv_bounds (faces reaching past the texture), uv_overlap (faces sharing pixels; faces with identical rectangles are taken as deliberate sharing), unpainted_faces (fully transparent), flat_faces (one single color, no shading), stray_pixels (paint no face shows), color_count (too many colors for pixel art).",
    "Run it after bbmodel_add_texture. Pixel gates are skipped, with the reason, for textures whose image is not embedded or inside the workspace.",
  ].join(" "),
  parameters: {
    file: fileParam,
    textures: z.array(z.union([z.string(), z.number().int().min(0)])).optional().describe("Textures to check (UUID, name or index). Defaults to every color texture."),
    gates: z.array(z.enum(GATE_IDS)).optional().describe("Defaults to all gates."),
    max_colors: z.number().int().positive().default(DEFAULT_TEXTURE_OPTIONS.maxColors),
    min_face_pixels: z.number().int().positive().default(DEFAULT_TEXTURE_OPTIONS.minFacePixels).describe("Smaller faces are not checked for flat color."),
    density_tolerance: z.number().min(1).default(DEFAULT_TEXTURE_OPTIONS.densityTolerance).describe("Allowed ratio between a face's texel density and the model's median."),
    stretch_tolerance: z.number().min(1).default(DEFAULT_TEXTURE_OPTIONS.stretchTolerance).describe("Allowed ratio between a face's horizontal and vertical texel density."),
  },
  readOnly: true,
  async execute(args, { store }) {
    const { doc, path, revision } = await store.read(args.file);
    const options = { maxColors: args.max_colors, minFacePixels: args.min_face_pixels, densityTolerance: args.density_tolerance, stretchTolerance: args.stretch_tolerance };
    const gates = args.gates ?? [...GATE_IDS];
    const model = runModelTextureGates(doc, options, gates);
    const textures = await Promise.all(
      chosenTextures(doc, args.textures).map(async (index) => {
        const texture = doc.textures[index];
        const coverage = coverFaces(doc, index);
        const image = texture ? await loadPixels(store, path, texture) : { unavailable: "The texture does not exist." };
        return {
          index,
          name: texture?.name ?? "",
          width: coverage.width,
          height: coverage.height,
          faces: coverage.outlines.length,
          ...("data" in image ? { colors: countColors(image) } : {}),
          gates: runTextureGates(coverage, image, options, gates),
        };
      }),
    );
    return { revision, summary: summarizeGates([...model, ...textures.flatMap((texture) => texture.gates)]), model_gates: model, textures };
  },
});

/** Texture authoring tools. */
export const textureTools: readonly IRegistrableTool[] = [uvTemplateTool, validateTexturesTool];
