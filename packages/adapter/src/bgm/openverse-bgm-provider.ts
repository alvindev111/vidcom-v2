import {
  BgmProviderTrackSchema,
  MAX_BGM_BYTES,
  type BgmLicense,
  type BgmProviderTrack,
} from "@vidcom/contracts";

import {
  BgmProviderError,
  fetchBgmResponse,
  expandBgmMood,
  hasVocalTags,
  moodScore,
  readBgmAudio,
  readBgmJson,
  type BgmHttpOptions,
  type BgmProviderAdapter,
} from "./bgm-provider";

interface OpenverseBgmProviderOptions extends BgmHttpOptions {
  baseUrl?: string;
}

interface ParsedOpenverseTrack {
  track: BgmProviderTrack;
  downloadUrl: URL;
}

/** Keyless Openverse audio adapter restricted to CC0, public-domain and CC BY works. */
export class OpenverseBgmProvider implements BgmProviderAdapter {
  readonly id = "openverse";
  readonly #baseUrl: URL;

  constructor(private readonly options: OpenverseBgmProviderOptions = {}) {
    this.#baseUrl = new URL(options.baseUrl ?? "https://api.openverse.org/v1/audio/");
    if (this.#baseUrl.protocol !== "https:") throw new TypeError("Openverse base URL must use HTTPS");
  }

  async search(input: { mood: string; limit: number }): Promise<BgmProviderTrack[]> {
    const url = new URL(this.#baseUrl);
    url.searchParams.set("q", `${expandBgmMood(input.mood)} instrumental background music`);
    url.searchParams.set("license", "cc0,pdm,by");
    url.searchParams.set("mature", "false");
    url.searchParams.set("filter_dead", "true");
    url.searchParams.set("page_size", String(Math.min(20, Math.max(input.limit * 3, input.limit))));
    const response = await fetchBgmResponse(url, this.options);
    const payload = await jsonObject(response, "Openverse search returned invalid JSON");
    const results = Array.isArray(payload.results) ? payload.results : [];
    return results
      .map(parseOpenverseTrack)
      .filter((candidate): candidate is ParsedOpenverseTrack => candidate !== null)
      .filter(({ track }) => !hasVocalTags(track.tags))
      .map((candidate, index) => ({ candidate, index }))
      .sort((left, right) => moodScore(right.candidate.track, input.mood)
        - moodScore(left.candidate.track, input.mood) || left.index - right.index)
      .slice(0, input.limit)
      .map(({ candidate }) => candidate.track);
  }

  async download(trackId: string): Promise<{ track: BgmProviderTrack; bytes: Uint8Array }> {
    const url = new URL(`${encodeURIComponent(trackId)}/`, this.#baseUrl);
    const response = await fetchBgmResponse(url, this.options);
    const candidate = parseOpenverseTrack(await jsonObject(response, "Openverse track returned invalid JSON"));
    if (!candidate || candidate.track.trackId !== trackId || hasVocalTags(candidate.track.tags)) {
      throw new BgmProviderError("Openverse track is missing or no longer meets the BGM licence guard");
    }
    return {
      track: candidate.track,
      bytes: await readBgmAudio(candidate.downloadUrl, candidate.track.extension, this.options),
    };
  }
}

function parseOpenverseTrack(value: unknown): ParsedOpenverseTrack | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const trackId = text(row.id);
  const title = text(row.title);
  const sourceUrl = webUrl(row.foreign_landing_url);
  const downloadUrl = httpsUrl(row.url);
  const durationMilliseconds = finiteNumber(row.duration);
  const filesize = finiteNumber(row.filesize);
  if (!trackId || !title || !sourceUrl || !downloadUrl
    || durationMilliseconds === null || durationMilliseconds <= 0
    || (filesize !== null && filesize > MAX_BGM_BYTES)) return null;
  const extension = audioExtension(row.filetype, downloadUrl);
  if (!extension) return null;

  const creator = text(row.creator) ?? "Unknown creator";
  const license = openverseLicense(row, creator, sourceUrl);
  if (!license) return null;
  const tags = Array.isArray(row.tags) ? row.tags.flatMap((tag) => {
    if (!tag || typeof tag !== "object" || Array.isArray(tag)) return [];
    const name = text((tag as Record<string, unknown>).name);
    return name ? [name.slice(0, 100)] : [];
  }).slice(0, 100) : [];
  const attribution = text(row.attribution)
    ?? `"${title}" by ${creator} (${license.kind === "cc-by" ? "CC BY" : license.kind})`;

  try {
    const track = BgmProviderTrackSchema.parse({
      providerId: "openverse",
      trackId,
      title: title.slice(0, 255),
      creator: creator.slice(0, 255),
      durationSeconds: Number((durationMilliseconds / 1_000).toFixed(3)),
      extension,
      license,
      sourceUrl: sourceUrl.href,
      attribution: attribution.slice(0, 2_048),
      tags,
    });
    return { track, downloadUrl };
  } catch {
    return null;
  }
}

function openverseLicense(
  row: Record<string, unknown>,
  creator: string,
  sourceUrl: URL,
): BgmLicense | null {
  const code = text(row.license)?.toLowerCase();
  const licenseUrl = webUrl(row.license_url)?.href ?? sourceUrl.href;
  if (code === "by") return {
    kind: "cc-by",
    holder: creator === "Unknown creator" ? null : creator,
    url: licenseUrl,
    note: "Indexed by Openverse; verify the linked source before publication.",
  };
  if (code === "cc0") return {
    kind: "cc0", holder: creator, url: licenseUrl,
    note: "Indexed by Openverse; verify the linked source before publication.",
  };
  if (code === "pdm") return {
    kind: "public-domain", holder: creator, url: licenseUrl,
    note: "Public Domain Mark indexed by Openverse; verify the linked source before publication.",
  };
  return null;
}

async function jsonObject(response: Response, message: string): Promise<Record<string, unknown>> {
  const value = await readBgmJson(response, message);
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  throw new BgmProviderError(message);
}

function audioExtension(value: unknown, url: URL): BgmProviderTrack["extension"] | null {
  const explicit = text(value)?.toLowerCase().replace(/^audio\//u, "");
  const suffix = url.pathname.slice(url.pathname.lastIndexOf(".") + 1).toLowerCase();
  const candidate = explicit === "mpeg" ? "mp3" : explicit ?? suffix;
  return ["mp3", "wav", "ogg", "m4a"].includes(candidate) ? candidate as BgmProviderTrack["extension"] : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
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
