import { cn } from "@/lib/utils";
import type { TerminalLine } from "@/lib/studio/types";

/**
 * A terminal pane stays dark in both themes, so these colours are literal
 * rather than theme tokens — the token foreground would be near-black on light
 * mode and invisible here.
 */
const LINE_CLASS: Record<TerminalLine["kind"], string> = {
  command: "text-neutral-100",
  output: "text-neutral-300",
  muted: "text-neutral-500",
  accent: "text-teal-300",
};

export function TerminalView({
  lines,
  prompt,
}: {
  lines: TerminalLine[];
  prompt: string;
}) {
  return (
    <div className="min-h-full p-4 font-mono text-[12.5px] leading-[20px]">
      {lines.map((line, index) => (
        <div
          key={index}
          className={cn("whitespace-pre-wrap", LINE_CLASS[line.kind])}
        >
          {line.kind === "command" ? (
            <>
              <span className="text-teal-300">$ </span>
              {line.text}
            </>
          ) : (
            line.text || " "
          )}
        </div>
      ))}

      <div className="flex items-center text-neutral-100">
        <span className="text-teal-300">{prompt}&nbsp;</span>
        <span className="inline-block h-4 w-2 animate-pulse bg-neutral-200" />
      </div>
    </div>
  );
}
