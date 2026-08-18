import type { Actor, ProjectId } from "@vidcom/contracts";

import { groupOf, planReorder } from "../domain/plan-scene-order";
import { ignoredMutationOriginForActor } from "../port/mutation-observer";
import type { WriteInvocation } from "../port/types";
import type { ProjectWriteDependencies } from "./project-writes";
import { applySceneOrderPlan, loadSceneOrderContext } from "./scene-order-write";

export async function reorderScenes(
  dependencies: ProjectWriteDependencies,
  input: {
    projectId: ProjectId;
    sceneId: string;
    toIndex: number;
    toTrackIndex?: number;
    extendRoot?: boolean;
    expectedContentHash: string;
  },
  actor: Actor,
  invocation: WriteInvocation = { origin: ignoredMutationOriginForActor(actor), toolAudit: null },
) {
  const context = await loadSceneOrderContext(dependencies, input);
  if (!context.ok) return context;
  const groups = Object.fromEntries(context.value.model.scenes.map((scene) => [scene.id, groupOf(scene)]));
  const plan = planReorder(context.value.clips, groups, input);
  return plan.ok
    ? applySceneOrderPlan(dependencies, context.value, plan.value, input, actor, invocation)
    : plan;
}
