export interface HostPair {
  /** Where the page was served from, e.g. `localhost:3000`. */
  pageOrigin: string;
  /** Where the API lives, e.g. `http://127.0.0.1:7788`. */
  apiBaseUrl: string;
}

export type HostVerdict =
  | { ok: true }
  | { ok: false; reason: string };

function hostnameOf(origin: string): string | null {
  try {
    return new URL(origin).hostname;
  } catch {
    return null;
  }
}

/**
 * Refuses a dev setup whose page and API disagree on hostname.
 *
 * Measured in spike S9: serving the page from `localhost:3000` while the API
 * answers on `127.0.0.1:<port>` makes `exchange` return **200** and the session
 * cookie never come back. Nothing errors; the app simply behaves as though the
 * user were never signed in. The same hostname across different ports keeps
 * `SameSite=Strict` intact, because a port is not part of a site.
 *
 * This is checked at boot rather than on the first request on purpose. A failure
 * at request time looks like an authentication bug and sends whoever hits it
 * hunting through session code; a failure at boot names the actual cause once,
 * before anything else has had a chance to look broken.
 */
export function checkDevHosts(pair: HostPair): HostVerdict {
  const pageHost = hostnameOf(pair.pageOrigin);
  const apiHost = hostnameOf(pair.apiBaseUrl);
  // An empty API base is a same-origin deployment, which cannot disagree.
  if (!pair.apiBaseUrl.trim()) return { ok: true };
  if (!pageHost || !apiHost) {
    return { ok: false, reason: `could not read a hostname from ${pair.pageOrigin} and ${pair.apiBaseUrl}` };
  }
  if (pageHost === apiHost) return { ok: true };
  return {
    ok: false,
    reason: `the page is served from ${pageHost} while the API answers on ${apiHost};`
      + " the session cookie will be dropped even though the exchange returns 200."
      + ` Serve both from ${apiHost}.`,
  };
}

/** Throws at boot so a mismatched dev setup cannot look like an auth bug. */
export function assertDevHosts(pair: HostPair): void {
  const verdict = checkDevHosts(pair);
  if (!verdict.ok) throw new Error(`VidCom dev host mismatch: ${verdict.reason}`);
}
