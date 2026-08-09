import { DaemonDiscoveryStore } from "@vidcom/adapter";
import type { DoctorItem } from "@vidcom/core";

import type { RepairOutcome } from "./doctor";

/** Only these are re-extractable. Settings and projects belong to the user. */
export const REPAIRABLE_CHECKS: readonly string[] = [
  "runtime.manifest",
  "runtime.integrity",
  "runtime.ffmpeg",
  "runtime.esbuild-binary",
  "compiler.probe",
  "runtime.hyperframes",
  "runtime.motion",
  "runtime.python",
  "runtime.python-utf8",
];

export interface DoctorRepairDependencies {
  appDataRoot: string;
  activeWorkspace(): Promise<string | null>;
  discovery?: Pick<DaemonDiscoveryStore, "read">;
  /** Re-extracts into a temporary tree and swaps it in. Never writes in place. */
  reextract(keys: readonly string[]): Promise<void>;
}

/**
 * Repairs what the artifact ships, and refuses the rest.
 *
 * Refusing while a daemon is running is not caution: on Windows the daemon
 * holds the very files a repair replaces, so the swap fails partway and leaves
 * a tree that is neither the old install nor the new one. Saying "stop the app
 * first" costs the user one step and saves them that state.
 */
export async function repairRuntime(
  failing: readonly DoctorItem[],
  dependencies: DoctorRepairDependencies,
): Promise<RepairOutcome> {
  const repairable = failing.filter((item) => REPAIRABLE_CHECKS.includes(item.id));
  const untouched = failing
    .filter((item) => !REPAIRABLE_CHECKS.includes(item.id))
    .map((item) => ({
      ...item,
      remedy: `${item.remedy ?? "no remedy"} (repair only re-extracts runtime components)`,
    }));

  if (repairable.length === 0) return { items: untouched };

  const workspace = await dependencies.activeWorkspace();
  const running = workspace === null
    ? null
    : await dependencies.discovery?.read(workspace) ?? null;
  if (running !== null) {
    return {
      items: [
        ...untouched,
        ...repairable.map((item) => ({
          ...item,
          // Deliberately not "broken": nothing new is wrong, the repair simply
          // did not happen.
          status: item.status,
          remedy: "stop the app or `vidcom serve`, then run this again"
            + ` (daemon ${running.instanceId} is holding these files)`,
        })),
      ],
    };
  }

  await dependencies.reextract(repairable.map((item) => item.id));
  // Reported as repaired only for what was actually re-extracted; the next
  // `doctor` run is what confirms it, and saying "ok" here would be this
  // command grading its own work.
  return {
    items: [
      ...untouched,
      ...repairable.map((item) => ({
        ...item,
        status: "ok" as const,
        detail: "re-extracted",
      })),
    ],
  };
}
