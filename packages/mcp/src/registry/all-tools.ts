import type { ToolRegistry } from "./registry";
import {
  registerDeleteFile,
  registerDeleteScene,
  type DestructiveToolDependencies,
} from "./destructive-tools";
import {
  registerListProjects,
  registerProjectContextTools,
  registerReadComposition,
  type ReadToolDependencies,
} from "./read-tools";
import {
  registerSceneWriteTools,
  registerSourceWriteTools,
  type WriteToolDependencies,
} from "./write-tools";

export type VidcomToolDependencies = ReadToolDependencies & WriteToolDependencies & DestructiveToolDependencies;

/** Registers the complete public Phase-2 tool surface exactly once. */
export function registerVidcomTools(registry: ToolRegistry, dependencies: VidcomToolDependencies): void {
  registerListProjects(registry, dependencies);
  registerProjectContextTools(registry, dependencies);
  registerReadComposition(registry, dependencies);
  registerSceneWriteTools(registry, dependencies);
  registerSourceWriteTools(registry, dependencies);
  registerDeleteScene(registry, dependencies);
  registerDeleteFile(registry, dependencies);
}
