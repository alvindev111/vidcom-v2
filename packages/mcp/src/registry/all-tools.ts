import type { ToolRegistry } from "./registry";
import {
  registerDeleteFile,
  registerDeleteScene,
  type DestructiveToolDependencies,
} from "./destructive-tools";
import {
  registerJobTools,
  type JobToolDependencies,
} from "./job-tools";
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
import { registerDeliveryLoopTools, type DeliveryLoopToolDependencies } from "./delivery-loop-tools";
import { registerAssetTools, type AssetToolDependencies } from "./asset-tools";
import { registerLifecycleTools, type LifecycleToolDependencies } from "./lifecycle-tools";
import { registerNarrationTools, type NarrationToolDependencies } from "./narration-tools";
import { registerBgmTools, type BgmToolDependencies } from "./bgm-tools";
import { registerPaletteTools } from "./palette-tools";
import { registerEditingTools, type EditingToolDependencies } from "./editing-tools";

export type VidcomToolDependencies =
  ReadToolDependencies & WriteToolDependencies & DestructiveToolDependencies & JobToolDependencies
  & DeliveryLoopToolDependencies & LifecycleToolDependencies & AssetToolDependencies
  & NarrationToolDependencies & BgmToolDependencies & EditingToolDependencies;

/** Registers the complete public tool surface exactly once. */
export function registerVidcomTools(registry: ToolRegistry, dependencies: VidcomToolDependencies): void {
  registerListProjects(registry, dependencies);
  registerProjectContextTools(registry, dependencies);
  registerReadComposition(registry, dependencies);
  registerSceneWriteTools(registry, dependencies);
  registerSourceWriteTools(registry, dependencies);
  registerDeleteScene(registry, dependencies);
  registerDeleteFile(registry, dependencies);
  registerJobTools(registry, dependencies);
  registerDeliveryLoopTools(registry, dependencies);
  registerLifecycleTools(registry, dependencies);
  registerAssetTools(registry, dependencies);
  registerNarrationTools(registry, dependencies);
  registerBgmTools(registry, dependencies);
  registerEditingTools(registry, dependencies);
  registerPaletteTools(registry);
  registry.assertPublicCatalogue();
}
