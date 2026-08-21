import { isIP } from "node:net";
import { Readable } from "node:stream";

import { BgmProviderTrackSchema, MAX_BGM_BYTES, ErrorCode, type BgmProviderTrack } from "@vidcom/contracts";
import type { BgmProviderPort } from "@vidcom/core";
import { err, ok } from "@vidcom/core";

import { isPublicAddress } from "../net/public-address";

const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_PROVIDER_OPERATION_MS = 10_000;
const MAX_BGM_JSON_BYTES = 1_048_576;

/** Provider-specific search/download implementation used by the aggregate registry. */
export interface BgmProviderAdapter {
  readonly id: string;
  /** Searches this provider only; an empty array is a healthy empty result. */
  search(input: { mood: string; limit: number }): Promise<BgmProviderTrack[]>;
  /** Downloads and revalidates the exact provider track id. */
  download(trackId: string): Promise<{ track: BgmProviderTrack; bytes: Uint8Array }>;
}

/** Expected provider failure carrying the domain code callers can recover from. */
export class BgmProviderError extends Error {
  constructor(
    message: string,
    readonly code: ErrorCode = ErrorCode.DownloadUnavailable,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "BgmProviderError";
  }
}

export interface BgmHttpOptions {
  fetch?: typeof globalThis.fetch;
  /** Low-level HTTPS seam used to verify DNS pinning without real network I/O. */
  requestHttps?: typeof import("node:https").request;
  /** Resolves hostnames for the public-network guard; injected by tests. */
  resolveHost?: (hostname: string) => Promise<readonly string[]>;
  timeoutMs?: number;
}

/** Performs one bounded provider request and maps network/HTTP failures consistently. */
export async function fetchBgmResponse(
  url: URL,
  options: BgmHttpOptions,
): Promise<Response> {
  if (url.protocol !== "https:") throw new BgmProviderError("BGM providers must use HTTPS");
  const signal = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    let requestUrl = url;
    for (let redirects = 0; redirects <= 3; redirects += 1) {
      await assertPublicUrl(requestUrl, options);
      const response = options.fetch
        ? await options.fetch(requestUrl, {
            signal,
            redirect: "manual",
            headers: { Accept: "application/json, audio/*;q=0.9, */*;q=0.1" },
          })
        : await pinnedHttpsResponse(
            requestUrl,
            signal,
            options.resolveHost ?? defaultResolveHost,
            options.requestHttps,
          );
      const location = response.headers.get("location");
      if (response.status >= 300 && response.status < 400 && location !== null) {
        await discardResponseBody(response);
        if (redirects === 3) throw new BgmProviderError("BGM provider redirected too many times");
        requestUrl = new URL(location, requestUrl);
        if (requestUrl.protocol !== "https:") {
          throw new BgmProviderError("BGM provider redirected to a non-HTTPS URL");
        }
        continue;
      }
      if (!response.ok) {
        const reason = response.status === 429 ? "rate limited" : `HTTP ${response.status}`;
        await discardResponseBody(response);
        throw new BgmProviderError(`BGM provider request was ${reason}`);
      }
      return response;
    }
    throw new BgmProviderError("BGM provider redirected too many times");
  } catch (error) {
    if (error instanceof BgmProviderError) throw error;
    throw new BgmProviderError(
      signal.aborted ? "BGM provider request timed out" : "BGM provider request failed",
      ErrorCode.DownloadUnavailable,
      { cause: error },
    );
  }
}

async function discardResponseBody(response: Response): Promise<void> {
  try { await response.body?.cancel(); }
  catch { /* preserve the provider error that caused the discard */ }
}

async function pinnedHttpsResponse(
  url: URL,
  signal: AbortSignal,
  resolveHost: NonNullable<BgmHttpOptions["resolveHost"]>,
  requestHttps?: BgmHttpOptions["requestHttps"],
): Promise<Response> {
  const request = requestHttps ?? (await import("node:https")).request;
  return new Promise<Response>((resolve, reject) => {
    const outgoing = request(url, {
      signal,
      method: "GET",
      headers: { Accept: "application/json, audio/*;q=0.9, */*;q=0.1" },
      lookup(hostname, lookupOptions, callback) {
        void resolveHost(hostname).then((addresses) => {
          if (addresses.length === 0 || addresses.some((address) => !isPublicAddress(address))) {
            callback(Object.assign(new Error("hostname resolved to a non-public address"), { code: "EACCES" }), "");
            return;
          }
          const family = typeof lookupOptions === "number"
            ? lookupOptions
            : lookupOptions.family ? Number(lookupOptions.family) : 0;
          const eligible = addresses.filter((address) => family === 0 || isIP(address) === family);
          if (typeof lookupOptions === "object" && lookupOptions.all) {
            callback(null, eligible.map((address) => ({ address, family: isIP(address) })));
            return;
          }
          const chosen = eligible[0];
          if (!chosen) {
            callback(Object.assign(new Error("hostname has no address for the requested family"), { code: "ENOTFOUND" }), "");
            return;
          }
          callback(null, chosen, isIP(chosen));
        }).catch((error: unknown) => {
          callback(error instanceof Error ? error as NodeJS.ErrnoException : new Error("hostname resolution failed"), "");
        });
      },
    }, (incoming) => {
      try {
        const status = incoming.statusCode ?? 500;
        const headers = new Headers();
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (Array.isArray(value)) value.forEach((item) => headers.append(name, item));
          else if (value !== undefined) headers.set(name, value);
        }
        if ([204, 205, 304].includes(status)) {
          incoming.resume();
          resolve(new Response(null, { status, headers }));
          return;
        }
        const body = Readable.toWeb(incoming) as ReadableStream<Uint8Array>;
        resolve(new Response(body, { status, headers }));
      } catch (error) {
        incoming.destroy();
        reject(error);
      }
    });
    outgoing.on("error", (error: NodeJS.ErrnoException) => {
      reject(error.code === "EACCES"
        ? new BgmProviderError("BGM provider URL resolved to a non-public address", ErrorCode.DownloadUnavailable, { cause: error })
        : error);
    });
    outgoing.end();
  });
}

/** Parses a provider JSON body without buffering an unbounded remote response. */
export async function readBgmJson(response: Response, message: string): Promise<unknown> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BGM_JSON_BYTES) {
    await discardResponseBody(response);
    throw new BgmProviderError("BGM provider JSON response is too large");
  }
  if (!response.body) throw new BgmProviderError(message);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > MAX_BGM_JSON_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new BgmProviderError("BGM provider JSON response is too large");
      }
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch (error) {
    if (error instanceof BgmProviderError) throw error;
    throw new BgmProviderError(message, ErrorCode.DownloadUnavailable, { cause: error });
  }
}

async function assertPublicUrl(url: URL, options: BgmHttpOptions): Promise<void> {
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new BgmProviderError("BGM provider URL is not a public HTTPS URL");
  }
  const addresses = options.resolveHost
    ? await options.resolveHost(url.hostname)
    : await defaultResolveHost(url.hostname);
  if (addresses.length === 0 || addresses.some((address) => !isPublicAddress(address))) {
    throw new BgmProviderError("BGM provider URL resolved to a non-public address");
  }
}

async function defaultResolveHost(hostname: string): Promise<readonly string[]> {
  const { lookup } = await import("node:dns/promises");
  try {
    return (await lookup(hostname, { all: true, verbatim: true })).map(({ address }) => address);
  } catch (error) {
    throw new BgmProviderError("BGM provider hostname could not be resolved", ErrorCode.DownloadUnavailable, { cause: error });
  }
}

/** Reads a remote audio response without ever buffering past the public BGM cap. */
export async function readBgmAudio(
  url: URL,
  extension: BgmProviderTrack["extension"],
  options: BgmHttpOptions,
): Promise<Uint8Array> {
  const response = await fetchBgmResponse(url, options);
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType && !contentType.startsWith("audio/")
    && !["application/octet-stream", "binary/octet-stream", "application/ogg"].includes(contentType)) {
    await discardResponseBody(response);
    throw new BgmProviderError("BGM provider returned a non-audio response", ErrorCode.UnsupportedMedia);
  }
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BGM_BYTES) {
    await discardResponseBody(response);
    throw new BgmProviderError("BGM track exceeds the 20 MiB project limit", ErrorCode.TooLarge);
  }
  if (!response.body) throw new BgmProviderError("BGM provider returned an empty audio response");

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    length += next.value.byteLength;
    if (length > MAX_BGM_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new BgmProviderError("BGM track exceeds the 20 MiB project limit", ErrorCode.TooLarge);
    }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (!matchesAudioSignature(bytes, extension)) {
    throw new BgmProviderError("BGM bytes do not match the advertised audio format", ErrorCode.UnsupportedMedia);
  }
  return bytes;
}

function matchesAudioSignature(bytes: Uint8Array, extension: BgmProviderTrack["extension"]): boolean {
  if (extension === "wav") return ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WAVE";
  if (extension === "ogg") return ascii(bytes, 0, 4) === "OggS";
  if (extension === "m4a") return ascii(bytes, 4, 8) === "ftyp";
  return ascii(bytes, 0, 3) === "ID3" || (bytes[0] === 0xff && (bytes[1] ?? 0) >= 0xe0);
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.subarray(start, end));
}

/** Ordered provider cascade: search isolates failures; exact download never substitutes a track. */
export class BgmProviderRegistry implements BgmProviderPort {
  readonly #providers: ReadonlyMap<string, BgmProviderAdapter>;

  constructor(providers: readonly BgmProviderAdapter[]) {
    const entries = providers.map((provider) => [provider.id, provider] as const);
    this.#providers = new Map(entries);
    if (this.#providers.size !== entries.length) throw new TypeError("BGM provider ids must be unique");
  }

  async search(input: { mood: string; limit: number }) {
    const rows = await Promise.all([...this.#providers.values()].map(async (provider) => {
      try {
        const searched = await bounded(provider.search(input), DEFAULT_PROVIDER_OPERATION_MS);
        const tracks = searched.flatMap((track) => {
          const parsed = BgmProviderTrackSchema.safeParse(track);
          return parsed.success && parsed.data.providerId === provider.id ? [parsed.data] : [];
        });
        if (tracks.length !== searched.length) {
          throw new BgmProviderError("BGM provider returned an invalid or mismatched track");
        }
        return {
          tracks,
          status: {
            providerId: provider.id,
            status: tracks.length > 0 ? "ok" as const : "empty" as const,
            resultCount: tracks.length,
            message: null,
          },
        };
      } catch (error) {
        return {
          tracks: [],
          status: {
            providerId: provider.id,
            status: "unavailable" as const,
            resultCount: 0,
            message: error instanceof Error ? error.message.slice(0, 512) : "provider unavailable",
          },
        };
      }
    }));

    const tracks: BgmProviderTrack[] = [];
    for (let index = 0; tracks.length < input.limit; index += 1) {
      let added = false;
      for (const row of rows) {
        const track = row.tracks[index];
        if (!track || tracks.length >= input.limit) continue;
        tracks.push(track);
        added = true;
      }
      if (!added) break;
    }
    return { tracks, providers: rows.map(({ status }) => status) };
  }

  async download(ref: { providerId: string; trackId: string }) {
    const provider = this.#providers.get(ref.providerId);
    if (!provider) return err({
      code: ErrorCode.NotFound,
      message: `BGM provider ${ref.providerId} is not configured`,
      field: "providerTrack.providerId",
    });
    try {
      const downloaded = await bounded(provider.download(ref.trackId), DEFAULT_PROVIDER_OPERATION_MS * 2);
      const parsed = BgmProviderTrackSchema.safeParse(downloaded.track);
      if (!parsed.success || parsed.data.providerId !== ref.providerId || parsed.data.trackId !== ref.trackId) {
        throw new BgmProviderError("BGM provider returned a different track than the one selected");
      }
      return ok({ track: parsed.data, bytes: downloaded.bytes });
    } catch (error) {
      const mapped = error instanceof BgmProviderError ? error : new BgmProviderError("BGM provider download failed");
      return err({
        code: mapped.code,
        message: mapped.message,
        field: "providerTrack.trackId",
        details: { providerId: provider.id },
      });
    }
  }
}

async function bounded<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new BgmProviderError("BGM provider operation timed out")), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** True when provider tags indicate spoken or sung vocals rather than an instrumental bed. */
export function hasVocalTags(tags: readonly string[]): boolean {
  return tags.some((tag) => /(^|[_\s-])(a?cappella|vocals?|singing|voice)([_\s-]|$)/iu.test(tag));
}

/** Stable mood relevance score used only to sort a provider's own candidates. */
export function moodScore(track: Pick<BgmProviderTrack, "title" | "tags" | "durationSeconds">, mood: string): number {
  const haystack = `${track.title} ${track.tags.join(" ")}`.toLowerCase();
  const terms = expandBgmMood(mood).split(/[^\p{L}\p{N}]+/u).filter((term) => term.length > 1);
  const moodMatches = terms.filter((term) => haystack.includes(term)).length * 5;
  const bedSignals = ["instrumental", "background", "ambient", "soundtrack", "music"]
    .filter((term) => haystack.includes(term)).length;
  const usefulLength = track.durationSeconds >= 20 && track.durationSeconds <= 600 ? 2 : 0;
  return moodMatches + bedSignals + usefulLength;
}

const MOOD_TRANSLATIONS: ReadonlyArray<[RegExp, string]> = [
  [/(?:êm\s*dịu|dịu\s*dàng|nhẹ\s*nhàng|bình\s*yên|thư\s*giãn)/iu, "calm gentle peaceful relaxing"],
  [/(?:tập\s*trung|chuyên\s*nghiệp|công\s*nghệ)/iu, "focused professional technology"],
  [/(?:ấm\s*áp|thân\s*thiện|gần\s*gũi)/iu, "warm friendly intimate"],
  [/(?:kịch\s*tính|điện\s*ảnh|hùng\s*tráng|mạnh\s*mẽ)/iu, "dramatic cinematic epic powerful"],
  [/(?:căng\s*thẳng|nghiêm\s*túc|u\s*tối|cảnh\s*báo)/iu, "tense serious dark warning"],
  [/(?:vui\s*tươi|năng\s*động|sôi\s*động|lạc\s*quan)/iu, "upbeat energetic lively optimistic"],
];

/** Adds controlled English discovery terms while retaining the user's original mood words. */
export function expandBgmMood(mood: string): string {
  const translations = MOOD_TRANSLATIONS.flatMap(([pattern, expansion]) => pattern.test(mood) ? [expansion] : []);
  return [...new Set(`${mood.toLowerCase()} ${translations.join(" ")}`.split(/\s+/u).filter(Boolean))].join(" ");
}
