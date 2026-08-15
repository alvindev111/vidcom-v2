import {
  COLOR_PALETTE_IDS,
  type ColorPaletteCategory,
  type ColorPaletteDto,
  type ColorPaletteId,
  type ColorPaletteMood,
  type PreviewSettingsDto,
  type PreviewSettingsPatchDto,
} from "@vidcom/contracts";

import { COLOR_PALETTE_RESEARCH } from "./color-palette-research";

/** Complete preview color state produced when one bundled palette is selected. */
export interface ColorPaletteSelection {
  tone: Pick<PreviewSettingsDto["tone"], "colorMode" | "backgroundColor" | "mainLight" | "softLight">;
  theme: PreviewSettingsDto["theme"];
  subtitles: Pick<PreviewSettingsDto["subtitles"], "color" | "activeColor">;
}

/** Palette used for a new project and when an agent has no color direction from the user. */
export const DEFAULT_COLOR_PALETTE_ID: ColorPaletteId = "clean-slate";

const PALETTES: Readonly<Record<ColorPaletteId, ColorPaletteDto>> = {
  "clean-slate": palette("clean-slate", "Clean Slate", "minimal", "light", "balanced",
    "Neutral, crisp blue system for broadly useful product and explainer videos.",
    ["default fallback", "SaaS", "product demos"], ["#3F72AF", "#112D4E", "#F9F7F7", "#DBE2EF", "#112D4E"]),
  ocean: palette("ocean", "Ocean", "minimal", "light", "balanced",
    "Calm blue and cyan palette with a technical, trustworthy character.",
    ["technology", "science", "calm explainers"], ["#2196F3", "#90CAF9", "#E3F2FD", "#90CAF9", "#0D47A1"]),
  forest: palette("forest", "Forest", "minimal", "light", "balanced",
    "Grounded green palette for sustainability, health, and steady growth.",
    ["sustainability", "health", "growth"], ["#66BB6A", "#A5D6A7", "#E8F5E9", "#A5D6A7", "#1B5E20"]),
  lavender: palette("lavender", "Lavender", "minimal", "light", "soft",
    "Gentle indigo and lavender system with a thoughtful, approachable tone.",
    ["wellness", "education", "creative tools"], ["#8B639B", "#AF719D", "#F8B2B2", "#F8B2B2", "#403D88"]),
  sunset: palette("sunset", "Sunset", "vibrant", "light", "high",
    "Energetic orange and amber palette designed for strong calls to action.",
    ["launches", "promotions", "event recaps"], ["#E68457", "#AA1C41", "#FFE8B4", "#FFE8B4", "#5E244E"]),
  candy: palette("candy", "Candy", "vibrant", "light", "balanced",
    "Playful pink palette for social, lifestyle, and youth-oriented stories.",
    ["social video", "lifestyle", "youth brands"], ["#F62477", "#FFADEE", "#FFE185", "#FFE185", "#92003A"]),
  electric: palette("electric", "Electric", "vibrant", "dark", "high",
    "Electric indigo and blue with an acid-lime signal for fast innovation narratives.",
    ["AI", "innovation", "high-energy promos"], ["#5B23FF", "#008BFF", "#362F4F", "#5B23FF", "#E4FF30"]),
  tropical: palette("tropical", "Tropical", "vibrant", "light", "balanced",
    "Fresh teal and mint palette with an optimistic, contemporary feel.",
    ["travel", "hospitality", "community"], ["#65DCD5", "#43637E", "#D9FFF4", "#65DCD5", "#321E48"]),
  midnight: palette("midnight", "Midnight", "dark", "dark", "high",
    "Graphite and cyan system for premium cinematic technology.",
    ["cinematic tech", "premium products", "keynotes"], ["#00ADB5", "#EEEEEE", "#222831", "#393E46", "#EEEEEE"]),
  noir: palette("noir", "Noir", "dark", "dark", "high",
    "Black, espresso, and parchment system for restrained luxury and drama.",
    ["luxury", "film", "dramatic reveals"], ["#412D15", "#E1DCC9", "#000000", "#1F150C", "#E1DCC9"]),
  cyber: palette("cyber", "Cyber", "dark", "dark", "high",
    "Neon violet and magenta over black for futuristic, digital-first stories.",
    ["gaming", "cybersecurity", "futuristic UI"], ["#9929EA", "#FF5FCF", "#000000", "#000000", "#FAEB92"]),
  ember: palette("ember", "Ember", "dark", "dark", "high",
    "Charcoal and hot orange palette for urgency, impact, and transformation.",
    ["sports", "transformation", "urgent announcements"], ["#D99B7F", "#A56F63", "#0F3040", "#0F3040", "#D99B7F"]),
  newsroom: palette("newsroom", "Newsroom", "editorial", "light", "high",
    "Slate and signal red system optimized for facts, headlines, and data.",
    ["news", "data reports", "current affairs"], ["#D90000", "#8DB355", "#FFEA93", "#FFEA93", "#000000"]),
  vintage: palette("vintage", "Vintage", "editorial", "light", "soft",
    "Muted ochre and paper tones for historical and documentary narratives.",
    ["history", "documentary", "heritage brands"], ["#EB7D00", "#2C5745", "#EBE3A7", "#EBE3A7", "#2E2910"]),
  monograph: palette("monograph", "Monograph", "editorial", "light", "high",
    "Near-monochrome system for portfolios, architecture, and typography-led work.",
    ["portfolios", "architecture", "typography"], ["#853953", "#612D53", "#F3F4F4", "#F3F4F4", "#2C2C2C"]),
  academia: palette("academia", "Academia", "editorial", "light", "balanced",
    "Ink blue and warm paper palette for research and educational authority.",
    ["research", "education", "institutions"], ["#0B1849", "#E4B028", "#EBEDE3", "#E4B028", "#0B1849"]),
  terracotta: palette("terracotta", "Terracotta", "warm", "light", "balanced",
    "Earthy orange system for craft, food, home, and human-centered stories.",
    ["food", "craft", "home and design"], ["#EC5B38", "#A8A492", "#FCF2E5", "#FCF2E5", "#524646"]),
  sand: palette("sand", "Sand", "warm", "light", "soft",
    "Quiet neutral and amber palette for understated premium communication.",
    ["consulting", "hospitality", "premium minimalism"], ["#9D6638", "#B0BA99", "#F7F1DE", "#B0BA99", "#4E220F"]),
  rose: palette("rose", "Rose", "warm", "light", "balanced",
    "Rich rose palette for personal, expressive, and emotionally warm narratives.",
    ["beauty", "personal stories", "community"], ["#CA5995", "#FFB090", "#FFF1D3", "#FFB090", "#5D1C6A"]),
  wheat: palette("wheat", "Wheat", "warm", "light", "balanced",
    "Golden wheat and brown system for natural products and grounded storytelling.",
    ["agriculture", "natural products", "tradition"], ["#D99B21", "#838921", "#FAF7BB", "#D99B21", "#133458"]),
};

function palette(
  id: ColorPaletteId,
  name: string,
  category: ColorPaletteCategory,
  appearance: "light" | "dark",
  contrast: "soft" | "balanced" | "high",
  description: string,
  recommendedFor: string[],
  [primary, accent, background, surface, text]: [string, string, string, string, string],
): ColorPaletteDto {
  return {
    id, name, category, appearance, contrast, description, recommendedFor,
    colors: { primary, accent, background, surface, text },
    ...COLOR_PALETTE_RESEARCH[id],
  };
}

function mix(left: string, right: string, rightWeight: number): string {
  const channel = (value: string, offset: number) => Number.parseInt(value.slice(offset, offset + 2), 16);
  const mixed = [1, 3, 5].map((offset) => Math.round(
    channel(left, offset) * (1 - rightWeight) + channel(right, offset) * rightWeight,
  ));
  return `#${mixed.map((value) => value.toString(16).padStart(2, "0")).join("")}`.toUpperCase();
}

function relativeLuminance(color: string): number {
  const channels = [1, 3, 5]
    .map((offset) => Number.parseInt(color.slice(offset, offset + 2), 16) / 255)
    .map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
}

function contrastRatio(left: string, right: string): number {
  const leftLuminance = relativeLuminance(left);
  const rightLuminance = relativeLuminance(right);
  return (Math.max(leftLuminance, rightLuminance) + 0.05)
    / (Math.min(leftLuminance, rightLuminance) + 0.05);
}

/** Returns the immutable bundled catalog in stable presentation order. */
export function listColorPalettes(category?: ColorPaletteCategory, mood?: ColorPaletteMood): ColorPaletteDto[] {
  return COLOR_PALETTE_IDS
    .map((id) => PALETTES[id])
    .filter((entry) => category === undefined || entry.category === category)
    .filter((entry) => mood === undefined || entry.guidance.moods.includes(mood))
    .map((entry) => ({
      ...entry,
      recommendedFor: [...entry.recommendedFor],
      colors: { ...entry.colors },
      guidance: { ...entry.guidance, moods: [...entry.guidance.moods] },
      source: { ...entry.source, swatches: [...entry.source.swatches] },
    }));
}

/** Returns the complete semantic preview color state for one bundled palette. */
export function colorPaletteSelection(id: ColorPaletteId): ColorPaletteSelection {
  const paletteValue = PALETTES[id];
  const { primary, accent, background, surface, text } = paletteValue.colors;
  const activeColor = [accent, primary].find((color) => contrastRatio(color, background) >= 4.5) ?? text;
  return {
    tone: {
      colorMode: paletteValue.appearance === "dark" ? "dark" : "cream",
      backgroundColor: background,
      mainLight: primary,
      softLight: accent,
    },
    theme: {
      paletteId: id,
      variables: {
        "--primary": primary,
        "--primary-light": mix(primary, background, 0.62),
        "--accent": accent,
        "--accent-light": mix(accent, background, 0.68),
        "--background": background,
        "--surface": surface,
        "--text": text,
        "--text-muted": mix(text, background, 0.46),
        "--success": mix("#22C55E", background, 0.16),
        "--info": accent,
      },
    },
    subtitles: { color: text, activeColor },
  };
}

/** Returns the complete semantic preview-settings patch for one bundled palette. */
export function colorPalettePatch(id: ColorPaletteId): PreviewSettingsPatchDto {
  return colorPaletteSelection(id);
}

/** Returns the full default selection used to bootstrap a project deterministically. */
export function defaultColorPalettePatch(): PreviewSettingsPatchDto {
  return colorPalettePatch(DEFAULT_COLOR_PALETTE_ID);
}
