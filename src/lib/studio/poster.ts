export interface Poster {
  className: string;
  labelClassName: string;
}

/**
 * Placeholder poster styling for the project grid. Real poster frames come from
 * `hyperframes snapshot`; until a project has one, its card gets a stable style
 * derived from its position so the grid still reads as distinct videos.
 */
const POSTERS: Poster[] = [
  {
    className: "bg-[#f5f0e0] text-[#3b3222]",
    labelClassName: "font-serif text-lg tracking-tight",
  },
  {
    className: "bg-black text-white",
    labelClassName: "font-mono text-sm tracking-[0.3em] uppercase",
  },
  {
    className: "bg-[#f2f0ea] text-[#141414]",
    labelClassName: "text-base font-medium tracking-tight",
  },
  {
    className:
      "bg-gradient-to-br from-[#1b2a6b] via-[#16205a] to-[#0b1233] text-white",
    labelClassName: "text-lg font-semibold",
  },
  {
    className: "bg-neutral-900 text-neutral-300",
    labelClassName: "font-mono text-sm",
  },
];

export function posterFor(index: number): Poster {
  return POSTERS[index % POSTERS.length];
}

/** `10s` / `5.5s` — the duration shown under a poster. */
export function formatDuration(seconds: number | null): string | null {
  if (seconds == null) return null;
  return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)}s`;
}
