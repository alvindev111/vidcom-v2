import { z } from "zod";

/** Stable palette identifiers shared by preview settings and MCP contracts. */
export const COLOR_PALETTE_IDS = [
  "clean-slate", "ocean", "forest", "lavender",
  "sunset", "candy", "electric", "tropical",
  "midnight", "noir", "cyber", "ember",
  "newsroom", "vintage", "monograph", "academia",
  "terracotta", "sand", "rose", "wheat",
] as const;

/** Palette families exposed for focused catalog discovery. */
export const COLOR_PALETTE_CATEGORIES = [
  "minimal", "vibrant", "dark", "editorial", "warm",
] as const;

/** Controlled creative moods an MCP harness can use without fuzzy keyword guessing. */
export const COLOR_PALETTE_MOODS = [
  "clean", "trustworthy", "calm", "natural", "gentle",
  "energetic", "playful", "innovative", "fresh", "premium",
  "dramatic", "futuristic", "urgent", "authoritative", "nostalgic",
  "intellectual", "handcrafted", "understated", "romantic", "grounded",
] as const;

/** Color-wheel relationship used to explain why a palette holds together. */
export const COLOR_PALETTE_HARMONIES = [
  "monochromatic", "analogous", "complementary", "split-complementary",
  "triadic", "accented-neutral",
] as const;

/** Identifier of one bundled, versioned color palette. */
export const ColorPaletteIdSchema = z.enum(COLOR_PALETTE_IDS);
/** Visual family used to filter the bundled palette catalog. */
export const ColorPaletteCategorySchema = z.enum(COLOR_PALETTE_CATEGORIES);
/** Creative mood used to filter or rank palettes for a video brief. */
export const ColorPaletteMoodSchema = z.enum(COLOR_PALETTE_MOODS);
/** Declared color harmony used by the sourced palette. */
export const ColorPaletteHarmonySchema = z.enum(COLOR_PALETTE_HARMONIES);
/** Five author-facing roles that define one palette without positional guessing. */
export const ColorPaletteColorsSchema = z.strictObject({
  primary: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  accent: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  background: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  surface: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  text: z.string().regex(/^#[0-9a-fA-F]{6}$/),
});

/** Verifiable source swatches from which the semantic video colors were mapped. */
export const ColorPaletteSourceSchema = z.strictObject({
  provider: z.literal("color-hunt"),
  url: z.url(),
  swatches: z.tuple([z.string(), z.string(), z.string(), z.string()])
    .refine((values) => values.every((value) => /^#[0-9a-fA-F]{6}$/.test(value))),
});

/** Decision metadata intended for an MCP harness choosing from a creative brief. */
export const ColorPaletteGuidanceSchema = z.strictObject({
  moods: z.array(ColorPaletteMoodSchema).min(1).max(6),
  harmony: ColorPaletteHarmonySchema,
  temperature: z.enum(["cool", "neutral", "warm", "mixed"]),
  energy: z.enum(["calm", "balanced", "energetic"]),
  chooseWhen: z.string().min(1).max(240),
  avoidWhen: z.string().min(1).max(240),
});

/** One deterministic palette and the creative metadata an agent uses to choose it. */
export const ColorPaletteSchema = z.strictObject({
  id: ColorPaletteIdSchema,
  name: z.string().min(1).max(80),
  category: ColorPaletteCategorySchema,
  appearance: z.enum(["light", "dark"]),
  contrast: z.enum(["soft", "balanced", "high"]),
  description: z.string().min(1).max(240),
  colorStory: z.string().min(1).max(320),
  recommendedFor: z.array(z.string().min(1).max(80)).min(1).max(8),
  colors: ColorPaletteColorsSchema,
  guidance: ColorPaletteGuidanceSchema,
  source: ColorPaletteSourceSchema,
});

export type ColorPaletteId = z.infer<typeof ColorPaletteIdSchema>;
export type ColorPaletteCategory = z.infer<typeof ColorPaletteCategorySchema>;
export type ColorPaletteMood = z.infer<typeof ColorPaletteMoodSchema>;
export type ColorPaletteHarmony = z.infer<typeof ColorPaletteHarmonySchema>;
export type ColorPaletteColors = z.infer<typeof ColorPaletteColorsSchema>;
export type ColorPaletteSource = z.infer<typeof ColorPaletteSourceSchema>;
export type ColorPaletteGuidance = z.infer<typeof ColorPaletteGuidanceSchema>;
export type ColorPaletteDto = z.infer<typeof ColorPaletteSchema>;
