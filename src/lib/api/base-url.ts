/**
 * Where the API lives, resolved at runtime rather than baked into the bundle.
 *
 * The same static export is served by a daemon on whatever loopback port was
 * free, so the origin cannot be known when the bundle is built. A
 * `NEXT_PUBLIC_*` value would be inlined at build time and be wrong for every
 * run but the one it was built for.
 *
 * The source is a parameter with a default rather than a direct `window` read.
 * `vitest.config.ts` sets `environment: "node"` for the whole repo and there is
 * no `jsdom` here, so a function that reaches for `window` in its body cannot
 * be tested at all — and the natural way to "fix" that is to add a browser
 * environment nobody approved.
 */
export interface ApiBaseUrlSource {
  __VIDCOM_API_BASE_URL__?: string;
  location?: { origin?: string };
}

export function resolveApiBaseUrl(
  source: ApiBaseUrlSource = globalThis as unknown as ApiBaseUrlSource,
): string {
  const injected = source.__VIDCOM_API_BASE_URL__?.trim();
  if (injected) return injected.replace(/\/+$/u, "");
  const origin = source.location?.origin?.trim();
  if (origin) return origin.replace(/\/+$/u, "");
  // Same-origin relative requests: correct in a browser, and honest about
  // having no origin anywhere else.
  return "";
}
