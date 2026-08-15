import { ErrorCode, type DomainError } from "@vidcom/contracts";
import {
  err,
  ok,
  type CompositionSource,
  type FontCompatibilityService,
  type ProjectRef,
  type Result,
} from "@vidcom/core";

/** Re-runs the deterministic font gate immediately before snapshot or render work is accepted. */
export async function checkFontCompatibility(
  fonts: FontCompatibilityService,
  ref: ProjectRef,
  sources: readonly CompositionSource[],
): Promise<Result<void, DomainError>> {
  const diagnostics = await fonts.inspect(ref, sources);
  const errors = diagnostics.filter(({ severity }) => severity === "error");
  if (errors.length === 0) return ok(undefined);
  return err({
    code: ErrorCode.ProjectInvalid,
    message: "project text or font compatibility is invalid",
    details: {
      reason: errors[0]?.code ?? "font-compatibility-check-failed",
      diagnostics: errors.map(({ code, file, details }) => ({
        code,
        ...(file === undefined ? {} : { file }),
        ...(details === undefined ? {} : { details }),
      })),
    },
  });
}
