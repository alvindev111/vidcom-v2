import type { z } from "zod";

import {
  ListColorPalettesInputSchema,
  ListColorPalettesOutputSchema,
} from "@vidcom/contracts";
import {
  DEFAULT_COLOR_PALETTE_ID,
  listColorPalettes,
  ok,
} from "@vidcom/core";

import { annotationsForLevel, ToolRegistry } from "./registry";
import type { ToolDefinition } from "./types";

/** Lists the bundled semantic video palettes without mutating a project. */
export function listColorPalettesTool(): ToolDefinition<
  z.infer<typeof ListColorPalettesInputSchema>,
  z.infer<typeof ListColorPalettesOutputSchema>
> {
  return {
    name: "list_color_palettes",
    title: "List standardized video palettes",
    level: "read",
    description: [
      "Use when choosing a video's look and the user and brand kit provide no explicit color direction; filter by mood or category when the brief implies one.",
      "Do not use a preset to replace colors explicitly supplied by the user or brand; custom direction always wins.",
      "Preconditions: none; every entry includes semantic color roles, controlled moods, harmony, choose/avoid guidance, and its source palette URL and swatches.",
      "Side effects: read-only; to apply one result atomically, call set_preview_settings with patch.theme.paletteId set to its id.",
      "Errors/recovery: an omitted category returns the complete catalog; defaultPaletteId is the deterministic fallback when no palette better matches the brief.",
    ].join(" "),
    input: ListColorPalettesInputSchema,
    output: ListColorPalettesOutputSchema,
    annotations: annotationsForLevel("read"),
    availableInLegacy: true,
    projectIdOf: () => null,
    handler: async (_context, input) => ok(ListColorPalettesOutputSchema.parse({
      defaultPaletteId: DEFAULT_COLOR_PALETTE_ID,
      palettes: listColorPalettes(input.category, input.mood),
    })),
  };
}

/** Registers the bundled palette catalog tool. */
export function registerPaletteTools(registry: ToolRegistry): void {
  registry.register(listColorPalettesTool());
}
