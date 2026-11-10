/**
 * Texture authoring aids: what an agent needs to paint a texture in an outside
 * image editor and bring it back with `bbmodel_add_texture`.
 *
 * @module
 */

import { z } from "zod";
import { encodeRgbaPng } from "../document/png";
import { resolveTexture } from "../edit/operations";
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
    await Bun.write(target, encodeRgbaPng(template.rgba, template.width, template.height));
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

/** Texture authoring tools. */
export const textureTools: readonly IRegistrableTool[] = [uvTemplateTool];
