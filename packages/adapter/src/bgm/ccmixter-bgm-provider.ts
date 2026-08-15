import {
  BgmProviderTrackSchema,
  MAX_BGM_BYTES,
  type BgmProviderTrack,
} from "@vidcom/contracts";

import {
  BgmProviderError,
  expandBgmMood,
  fetchBgmResponse,
  hasVocalTags,
  moodScore,
  readBgmAudio,
  readBgmJson,
  type BgmHttpOptions,
  type BgmProviderAdapter,
} from "./bgm-provider";

interface CcMixterBgmProviderOptions extends BgmHttpOptions {
  baseUrl?: string;
}

interface ParsedCcMixterTrack {
  track: BgmProviderTrack;
  downloadUrl: URL;
}

/** Independent keyless ccMixter fallback restricted to attribution-only tracks. */
export class CcMixterBgmProvider implements BgmProviderAdapter {
  readonly id = "ccmixter";
  readonly #baseUrl: URL;

  constructor(private readonly options: CcMixterBgmProviderOptions = {}) {
    this.#baseUrl = new URL(options.baseUrl ?? "https://ccmixter.org/api/query");
    if (this.#baseUrl.protocol !== "https:") throw new TypeError("ccMixter base URL must use HTTPS");
  }

  async search(input: { mood: string; limit: number }): Promise<BgmProviderTrack[]> {
    const terms = expandBgmMood(input.mood).split(/[^\p{L}\p{N}]+/u).filter((term) => term.length > 1);
    const url = this.queryUrl({
      tags: [...terms, "instrumental", "background"].join(" "),
      type: "any",
      lic: "by",
      limit: String(Math.min(40, Math.max(input.limit * 3, input.limit))),
    });
    const rows = await jsonRows(await fetchBgmResponse(url, this.options));
    return rows
      .map(parseCcMixterTrack)
      .filter((candidate): candidate is ParsedCcMixterTrack => candidate !== null)
      .filter(({ track }) => !hasVocalTags(track.tags))
      .map((candidate, index) => ({ candidate, index }))
      .sort((left, right) => moodScore(right.candidate.track, input.mood)
        - moodScore(left.candidate.track, input.mood) || left.index - right.index)
      .slice(0, input.limit)
      .map(({ candidate }) => candidate.track);
  }

  async download(trackId: string): Promise<{ track: BgmProviderTrack; bytes: Uint8Array }> {
    if (!/^\d{1,12}$/u.test(trackId)) throw new BgmProviderError("ccMixter track id is invalid");
    const rows = await jsonRows(await fetchBgmResponse(this.queryUrl({ ids: trackId, limit: "1" }), this.options));
    const candidate = rows.map(parseCcMixterTrack)
      .find((item): item is ParsedCcMixterTrack => item?.track.trackId === trackId);
    if (!candidate || hasVocalTags(candidate.track.tags)) {
      throw new BgmProviderError("ccMixter track is missing or no longer meets the BGM licence guard");
    }
    return {
      track: candidate.track,
      bytes: await readBgmAudio(candidate.downloadUrl, candidate.track.extension, this.options),
    };
  }

  private queryUrl(extra: Record<string, string>): URL {
    const url = new URL(this.#baseUrl);
    url.searchParams.set("f", "json");
    url.searchParams.set("dataview", "info");
    for (const [key, value] of Object.entries(extra)) url.searchParams.set(key, value);
    return url;
  }
}

function parseCcMixterTrack(value: unknown): ParsedCcMixterTrack | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const trackId = integerText(row.upload_id);
  const title = text(row.upload_name);
  const creator = text(row.user_real_name) ?? text(row.user_name);
  const sourceUrl = webUrl(row.file_page_url);
  const licenseUrl = webUrl(row.license_url);
  if (!trackId || !title || !creator || !sourceUrl || !licenseUrl
    || !/^https?:\/\/creativecommons\.org\/licenses\/by\//iu.test(licenseUrl.href)) return null;

  const tags = (text(row.upload_tags) ?? "").split(",")
    .map((tag) => tag.trim()).filter(Boolean).slice(0, 100);
  const file = bestAudioFile(row.files);
  if (!file) return null;
  const attribution = `"${title}" by ${creator} is licensed under CC BY (${licenseUrl.href}).`;
  try {
    const track = BgmProviderTrackSchema.parse({
      providerId: "ccmixter",
      trackId,
      title: title.slice(0, 255),
      creator: creator.slice(0, 255),
      durationSeconds: file.durationSeconds,
      extension: file.extension,
      license: {
        kind: "cc-by",
        holder: creator,
        url: licenseUrl.href,
        note: "Reported by ccMixter; verify the linked source before publication.",
      },
      sourceUrl: sourceUrl.href,
      attribution,
      tags,
    });
    return { track, downloadUrl: file.downloadUrl };
  } catch {
    return null;
  }
}

function bestAudioFile(value: unknown): {
  extension: BgmProviderTrack["extension"];
  downloadUrl: URL;
  durationSeconds: number;
} | null {
  if (!Array.isArray(value)) return null;
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const file = item as Record<string, unknown>;
    const downloadUrl = httpsUrl(file.download_url);
    const rawSize = numberLike(file.file_rawsize);
    const format = file.file_format_info && typeof file.file_format_info === "object"
      && !Array.isArray(file.file_format_info) ? file.file_format_info as Record<string, unknown> : {};
    const extension = extensionOf(text(format["default-ext"]) ?? text(file.file_name));
    const durationSeconds = durationOf(text(format.ps));
    if (downloadUrl && extension && durationSeconds && (rawSize === null || rawSize <= MAX_BGM_BYTES)) {
      return { extension, downloadUrl, durationSeconds };
    }
  }
  return null;
}

function durationOf(value: string | null): number | null {
  if (!value) return null;
  const parts = value.split(":").map(Number);
  if (parts.some((part) => !Number.isFinite(part) || part < 0)) return null;
  const seconds = parts.reduce((total, part) => total * 60 + part, 0);
  return seconds > 0 ? seconds : null;
}

function extensionOf(value: string | null): BgmProviderTrack["extension"] | null {
  if (!value) return null;
  const suffix = value.includes(".") ? value.slice(value.lastIndexOf(".") + 1) : value;
  const candidate = suffix.toLowerCase() === "mpeg" ? "mp3" : suffix.toLowerCase();
  return ["mp3", "wav", "ogg", "m4a"].includes(candidate) ? candidate as BgmProviderTrack["extension"] : null;
}

async function jsonRows(response: Response): Promise<unknown[]> {
  const value = await readBgmJson(response, "ccMixter returned invalid JSON");
  if (Array.isArray(value)) return value;
  throw new BgmProviderError("ccMixter returned invalid JSON");
}

function numberLike(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function integerText(value: unknown): string | null {
  const parsed = numberLike(value);
  return parsed !== null && Number.isSafeInteger(parsed) && parsed > 0 ? String(parsed) : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function webUrl(value: unknown): URL | null {
  const raw = text(value);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return ["http:", "https:"].includes(url.protocol) ? url : null;
  } catch {
    return null;
  }
}

function httpsUrl(value: unknown): URL | null {
  const url = webUrl(value);
  return url?.protocol === "https:" ? url : null;
}
