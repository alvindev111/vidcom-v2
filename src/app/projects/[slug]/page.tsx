import ComposerClient from "./composer-client";
import { SHELL_SENTINEL } from "./shell-sentinel";

/**
 * One rendered file stands in for every project.
 *
 * A static export has to know its paths at build time, and project slugs are
 * created by users long afterwards. Emitting a single sentinel shell keeps the
 * route in the export; the client reads the real slug from the address bar.
 */
export function generateStaticParams(): { slug: string }[] {
  return [{ slug: SHELL_SENTINEL }];
}

export default function ComposerPage() {
  return <ComposerClient />;
}
