import type { Diagnostic } from "@vidcom/contracts";

import type { CompositionSource, FontCompatibilityIssue, ProjectRef } from "../domain/models";
import type { FontCompatibilityPort } from "../port/ports";

function codePointLabel(value: number): string {
  return `U+${value.toString(16).toUpperCase().padStart(4, "0")}`;
}

function issueDetails(issue: FontCompatibilityIssue): Record<string, unknown> {
  return {
    ...(issue.fontFamily === undefined ? {} : { fontFamily: issue.fontFamily }),
    ...(issue.fontFile === undefined ? {} : { fontFile: issue.fontFile }),
    ...(issue.missingCodePoints === undefined ? {} : {
      missingCodePoints: issue.missingCodePoints.map(codePointLabel),
    }),
    ...(issue.sample === undefined ? {} : { sample: issue.sample }),
  };
}

function diagnostic(issue: FontCompatibilityIssue): Diagnostic {
  const details = issueDetails(issue);
  switch (issue.kind) {
    case "invalid-utf8":
      return {
        severity: "error",
        code: "text-encoding-invalid",
        file: issue.sourceFile,
        message: "Source is not valid UTF-8; re-save it as UTF-8 before preview or render.",
        details,
      };
    case "font-file-invalid":
      return {
        severity: "error",
        code: "font-file-invalid",
        file: issue.sourceFile,
        message: `Font ${issue.fontFamily ?? "resource"} could not be read as a supported OpenType font.`,
        details,
      };
    case "font-glyph-missing": {
      const labels = (issue.missingCodePoints ?? []).slice(0, 12).map(codePointLabel).join(", ");
      return {
        severity: "error",
        code: "font-glyph-missing",
        file: issue.sourceFile,
        message: `Font ${issue.fontFamily ?? "resource"} is missing glyphs for ${labels || "authored Unicode text"}.`,
        details,
      };
    }
    case "font-coverage-unverified":
      return {
        severity: "warning",
        code: "font-coverage-unverified",
        file: issue.sourceFile,
        message: `Font ${issue.fontFamily ?? "selected by the browser"} is not backed by inspectable project-local bytes, so Unicode glyph coverage cannot be guaranteed across render machines.`,
        details,
      };
  }
}

/** Converts exact font/encoding evidence into stable project diagnostics. */
export class FontCompatibilityService {
  constructor(private readonly inspector: FontCompatibilityPort) {}

  /** Checks the authored composition sources without mutating project state. */
  async inspect(ref: ProjectRef, sources: readonly CompositionSource[]): Promise<Diagnostic[]> {
    try {
      return (await this.inspector.inspect(ref, sources)).map(diagnostic);
    } catch {
      return [{
        severity: "error",
        code: "font-compatibility-check-failed",
        message: "Font compatibility could not be verified; retry validation before preview or render.",
      }];
    }
  }
}
