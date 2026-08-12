import { describe, expect, it } from "vitest";

import { COLOR_PALETTE_IDS, ColorPaletteSchema } from "@vidcom/contracts";
import {
  DEFAULT_COLOR_PALETTE_ID,
  DEFAULT_PREVIEW_SETTINGS,
  colorPaletteSelection,
  listColorPalettes,
  mergePreviewSettings,
  normalizePreviewSettings,
} from "@vidcom/core";

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255);
  const linear = channels.map((value) => value <= 0.04045
    ? value / 12.92
    : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
}

function contrast(left: string, right: string): number {
  const [lighter, darker] = [luminance(left), luminance(right)].sort((a, b) => b - a);
  return (lighter! + 0.05) / (darker! + 0.05);
}

describe("bundled color palettes", () => {
  it("publishes the complete stable catalog with a deterministic fallback", () => {
    const palettes = listColorPalettes();
    expect(DEFAULT_COLOR_PALETTE_ID).toBe("clean-slate");
    expect(palettes.map((entry) => entry.id)).toEqual(COLOR_PALETTE_IDS);
    expect(new Set(palettes.map((entry) => entry.id))).toHaveLength(20);
    for (const entry of palettes) expect(ColorPaletteSchema.parse(entry)).toEqual(entry);
  });

  it("filters by editorial category without changing catalog order", () => {
    expect(listColorPalettes("editorial").map((entry) => entry.id)).toEqual([
      "newsroom", "vintage", "monograph", "academia",
    ]);
  });

  it("filters by controlled mood and exposes source-backed selection guidance", () => {
    const palettes = listColorPalettes(undefined, "futuristic");
    expect(palettes.map((entry) => entry.id)).toEqual(["electric", "midnight", "cyber"]);
    for (const entry of listColorPalettes()) {
      expect(entry.guidance.chooseWhen).not.toBe(entry.guidance.avoidWhen);
      expect(entry.source.url).toBe(
        `https://colorhunt.co/palette/${entry.source.swatches.map((value) => value.slice(1).toLowerCase()).join("")}`,
      );
      expect(Object.values(entry.colors).every((value) => entry.source.swatches.includes(value))).toBe(true);
    }
  });

  it("keeps body text readable on both background and surface roles", () => {
    for (const entry of listColorPalettes()) {
      expect(contrast(entry.colors.text, entry.colors.background), entry.id).toBeGreaterThanOrEqual(4.5);
      expect(contrast(entry.colors.text, entry.colors.surface), entry.id).toBeGreaterThanOrEqual(4.5);
      const selection = colorPaletteSelection(entry.id);
      expect(contrast(selection.subtitles.activeColor, entry.colors.background), entry.id)
        .toBeGreaterThanOrEqual(4.5);
    }
  });

  it("applies every semantic role atomically through preview settings", () => {
    const settings = mergePreviewSettings(DEFAULT_PREVIEW_SETTINGS, {
      theme: { paletteId: "sunset" },
    });
    expect(settings.theme).toMatchObject({
      paletteId: "sunset",
      variables: {
        "--primary": "#E68457",
        "--accent": "#AA1C41",
        "--background": "#FFE8B4",
        "--surface": "#FFE8B4",
        "--text": "#5E244E",
      },
    });
    expect(settings.tone).toMatchObject({
      colorMode: "cream",
      backgroundColor: "#FFE8B4",
      mainLight: "#E68457",
      softLight: "#AA1C41",
    });
    expect(settings.subtitles).toMatchObject({ color: "#5E244E", activeColor: "#AA1C41" });
  });

  it("marks individual color overrides custom while preserving non-color edits", () => {
    const selected = mergePreviewSettings(DEFAULT_PREVIEW_SETTINGS, { theme: { paletteId: "ocean" } });
    const resized = mergePreviewSettings(selected, { subtitles: { fontSize: 64 } });
    expect(resized.theme.paletteId).toBe("ocean");

    const customized = mergePreviewSettings(resized, { theme: { variables: { "--accent": "#123456" } } });
    expect(customized.theme.paletteId).toBeNull();
    expect(customized.theme.variables["--accent"]).toBe("#123456");
  });

  it("migrates legacy settings without falsely assigning the default preset", () => {
    const normalized = normalizePreviewSettings({
      theme: { variables: { "--primary": "#112233" } },
    });
    expect(normalized.theme.paletteId).toBeNull();
    expect(normalized.theme.variables["--primary"]).toBe("#112233");
    expect(normalized.theme.variables["--background"]).toBe("#F9F7F7");
  });
});
