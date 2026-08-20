/**
 * The whole of a preview host page.
 *
 * Deliberately not a route in the studio app: a host page is created and thrown
 * away for every reload, and paying for the studio's framework each time is both
 * slow and, measured in a real browser, enough to exhaust the renderer. This
 * bundle is the player and nothing else.
 */

async function boot(): Promise<void> {
  await import("@hyperframes/player");
  const host = document.querySelector<HTMLElement>("[data-preview-host]");
  if (!host) return;
  const source = new URLSearchParams(window.location.search).get("src");
  const player = document.createElement("hyperframes-player");
  player.style.position = "absolute";
  player.style.inset = "0";
  host.appendChild(player);
  // Connected first, sourced second: a detached load never opens the bridge to
  // this page, and the studio is waiting on exactly that bridge.
  if (source) player.setAttribute("src", source);
}

void boot();
