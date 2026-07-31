import { ChevronDownIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { TOKEN_CLASS, tokenizeLine } from "@/lib/studio/highlight";

export function CodeView({
  code,
  foldableLines = [],
  activeLine = 1,
}: {
  code: string;
  foldableLines?: number[];
  activeLine?: number;
}) {
  const lines = code.replace(/\n$/, "").split("\n");

  return (
    <div className="w-max min-w-full py-1 font-mono text-[12.5px] leading-[18px]">
      {lines.map((line, index) => {
        const lineNumber = index + 1;
        return (
          <div
            key={lineNumber}
            data-active={lineNumber === activeLine || undefined}
            className="flex items-start data-active:bg-muted/60"
          >
            <span className="text-muted-foreground/60 w-10 shrink-0 pr-2 text-right tabular-nums select-none">
              {lineNumber}
            </span>
            <span className="w-4 shrink-0 select-none">
              {foldableLines.includes(lineNumber) ? (
                <ChevronDownIcon className="text-muted-foreground/60 size-3" />
              ) : null}
            </span>
            <span className="whitespace-pre pr-6">
              {tokenizeLine(line).map((token, tokenIndex) => (
                <span key={tokenIndex} className={cn(TOKEN_CLASS[token.kind])}>
                  {token.value}
                </span>
              ))}
            </span>
          </div>
        );
      })}
    </div>
  );
}
