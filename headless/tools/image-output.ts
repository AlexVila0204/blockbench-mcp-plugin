/**
 * Where tools that produce PNG images write them, and how they return them.
 *
 * @module
 */

import { mkdir } from "node:fs/promises";
import { basename, join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { IHeadlessContext } from "../tool";

/**
 * Resolves the PNG path for an image made from a model.
 *
 * @param explicit - Path inside the workspace; a scratch file outside it when absent.
 * @throws Error when `explicit` exists and `overwrite` is false.
 */
export async function outputPath(context: IHeadlessContext, file: string, label: string, explicit: string | undefined, overwrite = false): Promise<string> {
  if (explicit !== undefined) {
    const target = context.store.resolvePath(explicit, [".png"]);
    if (!overwrite && (await Bun.file(target).exists())) throw new Error(`${target} already exists; pass overwrite: true to replace it.`);
    return target;
  }
  await mkdir(context.scratchDir, { recursive: true, mode: 0o700 });
  const stem = basename(file).replace(/\.bbmodel$/i, "");
  return join(context.scratchDir, `${stem}-${label}-${Date.now().toString(36)}.png`);
}

/** Reads a PNG file as inline image content. */
export async function imageContent(path: string): Promise<CallToolResult["content"][number]> {
  const data = Buffer.from(await Bun.file(path).arrayBuffer()).toString("base64");
  return { type: "image", data, mimeType: "image/png" };
}
