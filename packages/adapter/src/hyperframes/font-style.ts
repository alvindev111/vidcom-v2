import { ErrorCode, type DomainError } from "@vidcom/contracts";
import { err, ok, type FontStyleRequest, type Result } from "@vidcom/core";
import { parseHTML } from "linkedom";

function escapeCssString(value: string): string {
  return [...value].map((character) => {
    const code = character.codePointAt(0) ?? 0;
    return character === "\\" || character === '"' || code < 0x20 || (code >= 0x7f && code <= 0x9f)
      ? `\\${code.toString(16)} `
      : character;
  }).join("");
}

function encodedProjectPath(value: string): string {
  return value.split("/").map((segment) => encodeURIComponent(segment)).join("/");
}

function fontTraits(style: string): { fontStyle: "normal" | "italic" | "oblique"; fontWeight: number } {
  const lower = style.toLowerCase();
  const fontStyle = lower.includes("oblique") ? "oblique" : lower.includes("italic") ? "italic" : "normal";
  const fontWeight = lower.includes("thin") ? 100
    : lower.includes("extra light") || lower.includes("ultra light") ? 200
      : lower.includes("light") ? 300
        : lower.includes("medium") ? 500
          : lower.includes("semi bold") || lower.includes("demi bold") ? 600
            : lower.includes("extra bold") || lower.includes("ultra bold") ? 800
              : lower.includes("black") || lower.includes("heavy") ? 900
                : lower.includes("bold") ? 700 : 400;
  return { fontStyle, fontWeight };
}

function styleTarget(request: FontStyleRequest): { marker: string; selector: string } {
  if (request.target.kind === "document") return { marker: "document", selector: "body" };
  return {
    marker: `composition:${request.target.id}`,
    selector: `[data-composition-id="${escapeCssString(request.target.id)}"]`,
  };
}

/** Applies one idempotent, adapter-owned font block without concatenating untrusted CSS tokens. */
export async function applyFontStyle(
  source: string,
  request: FontStyleRequest,
): Promise<Result<string, DomainError>> {
  try {
    const { document } = parseHTML(source);
    if (!document.documentElement || !document.head) {
      return err({ code: ErrorCode.SdkRejected, message: "composition source is not an HTML document" });
    }
    const { marker, selector } = styleTarget(request);
    const escapedFamily = escapeCssString(request.family);
    const escapedPath = escapeCssString(encodedProjectPath(request.fontPath));
    const traits = fontTraits(request.style);
    const css = `@font-face {
  font-family: "${escapedFamily}";
  src: url("${escapedPath}");
  font-style: ${traits.fontStyle};
  font-weight: ${traits.fontWeight};
}
${selector} {
  font-family: "${escapedFamily}";
  font-style: ${traits.fontStyle};
  font-weight: ${traits.fontWeight};
}`;
    const owned = [...document.querySelectorAll("style[data-vidcom-font-target]")]
      .find((element) => element.getAttribute("data-vidcom-font-target") === marker);
    const style = owned ?? document.createElement("style");
    style.setAttribute("data-vidcom-font-target", marker);
    style.textContent = css;
    if (!owned) document.head.append(style);
    return ok(document.documentElement.outerHTML);
  } catch {
    return err({ code: ErrorCode.SdkRejected, message: "font style could not be serialized" });
  }
}
