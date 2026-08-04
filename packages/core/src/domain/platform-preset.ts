import { ErrorCode, type DomainError } from "@vidcom/contracts";

import { err, ok, type Result } from "../error/result";

export type PresetId = "vertical-shorts" | "horizontal-youtube" | "custom";
export type Orientation = "vertical" | "horizontal";

export interface PlatformConfig {
  presetId: PresetId;
  orientation: Orientation;
  aspectRatio: string;
  width: number;
  height: number;
  fps: number;
  targets: string[];
  recommendedMaxDurationSeconds: number | null;
}

export const PLATFORM_PRESETS: readonly PlatformConfig[] = [
  {
    presetId: "vertical-shorts", orientation: "vertical", aspectRatio: "9:16",
    width: 1080, height: 1920, fps: 30,
    targets: ["tiktok", "instagram-reels", "youtube-shorts"], recommendedMaxDurationSeconds: 180,
  },
  {
    presetId: "horizontal-youtube", orientation: "horizontal", aspectRatio: "16:9",
    width: 1920, height: 1080, fps: 30,
    targets: ["youtube"], recommendedMaxDurationSeconds: null,
  },
] as const;

/** Canonical empty authored document shared by lifecycle and first-scene insertion. */
export function rootCompositionSource(platform: PlatformConfig, content = "", duration = 0): string {
  return `<!doctype html>\n<html><head><meta charset="UTF-8"></head><body>\n`
    + `<main data-composition-id="main" data-width="${platform.width}" data-height="${platform.height}" data-fps="${platform.fps}" data-duration="${duration}">${content}</main>\n`
    + `</body></html>\n`;
}

/** Rejects an unencodable bundled catalog before the application starts. */
export function assertCatalogEncodable(catalog: readonly PlatformConfig[] = PLATFORM_PRESETS): void {
  for (const preset of catalog) {
    if (preset.width % 2 !== 0 || preset.height % 2 !== 0) {
      throw new TypeError(`platform preset ${preset.presetId} must use even dimensions`);
    }
  }
}

/** Infers an exact bundled preset, otherwise preserves the dimensions as custom. */
export function inferPreset(width: number, height: number, fps: number): PlatformConfig {
  const matched = PLATFORM_PRESETS.find((preset) =>
    preset.width === width && preset.height === height && preset.fps === fps);
  return matched ? clone(matched) : custom(width, height, fps);
}

/** Validates custom encoder bounds and derives orientation/aspect without guessing targets. */
export function validateCustom(input: { width: number; height: number; fps: number }): Result<PlatformConfig, DomainError> {
  for (const field of ["width", "height"] as const) {
    const value = input[field];
    if (!Number.isInteger(value) || value < 128 || value > 7680 || value % 2 !== 0) {
      return err({ code: ErrorCode.SchemaInvalid, message: `${field} must be an even integer from 128 to 7680`, field });
    }
  }
  if (!Number.isInteger(input.fps) || input.fps < 1 || input.fps > 120) {
    return err({ code: ErrorCode.SchemaInvalid, message: "fps must be an integer from 1 to 120", field: "fps" });
  }
  return ok(custom(input.width, input.height, input.fps));
}

/** Resolves the strict create-project boundary without duplicating preset policy in HTTP/MCP adapters. */
export function resolvePlatformPreset(input: {
  presetId: PresetId;
  width?: number;
  height?: number;
  fps?: number;
}): Result<PlatformConfig, DomainError> {
  if (input.presetId === "custom") {
    if (input.width === undefined || input.height === undefined || input.fps === undefined) {
      return err({ code: ErrorCode.SchemaInvalid, message: "custom preset requires width, height and fps" });
    }
    return validateCustom({ width: input.width, height: input.height, fps: input.fps });
  }
  if (input.width !== undefined || input.height !== undefined || input.fps !== undefined) {
    return err({ code: ErrorCode.SchemaInvalid, message: "bundled presets do not accept custom dimensions" });
  }
  const preset = PLATFORM_PRESETS.find((candidate) => candidate.presetId === input.presetId);
  return preset
    ? ok(clone(preset))
    : err({ code: ErrorCode.SchemaInvalid, message: "platform preset was not found", field: "presetId" });
}

function custom(width: number, height: number, fps: number): PlatformConfig {
  const divisor = gcd(width, height);
  return {
    presetId: "custom",
    orientation: height > width ? "vertical" : "horizontal",
    aspectRatio: `${width / divisor}:${height / divisor}`,
    width, height, fps, targets: [], recommendedMaxDurationSeconds: null,
  };
}

function gcd(left: number, right: number): number {
  let a = Math.abs(left);
  let b = Math.abs(right);
  while (b !== 0) [a, b] = [b, a % b];
  return a || 1;
}

function clone(preset: PlatformConfig): PlatformConfig {
  return { ...preset, targets: [...preset.targets] };
}

assertCatalogEncodable();
