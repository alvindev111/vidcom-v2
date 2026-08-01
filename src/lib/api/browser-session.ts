let exchange: Promise<void> | null = null;

/** Exchanges the CLI URL nonce once, then removes it from browser history. */
export function ensureBrowserSession(): Promise<void> {
  if (exchange) return exchange;
  const url = new URL(window.location.href);
  const nonce = url.searchParams.get("t");
  if (!nonce) return Promise.resolve();

  exchange = fetch("/api/v1/auth/exchange", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ nonce }),
  }).then(async (response) => {
    if (!response.ok) throw new Error("The VidCom launch link is invalid or expired.");
    url.searchParams.delete("t");
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  });
  return exchange;
}

export async function apiError(response: Response): Promise<string> {
  const payload = await response.json().catch(() => null) as { error?: { message?: string } } | null;
  if (response.status === 401) return "Open VidCom again from the CLI to start a new session.";
  return payload?.error?.message ?? `Request failed (${response.status}).`;
}
