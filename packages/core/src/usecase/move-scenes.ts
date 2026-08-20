import type { Actor, ProjectId } from "@vidcom/contracts";

import { planGroupShift, validateSceneSelection } from "../domain/plan-scene-order";
import { ignoredMutationOriginForActor } from "../port/mutation-observer";
import type { WriteInvocation } from "../port/types";
import type { ProjectWriteDependencies } from "./project-writes";
import { applySceneOrderPlan, loadSceneOrderContext } from "./scene-order-write";

export async function moveScenes(
  dependencies: ProjectWriteDependencies,
  input: {
    projectId: ProjectId;
    sceneIds: string[];
    deltaSeconds: number;
    extendRoot?: boolean;
    expectedContentHash: string;
  },
  actor: Actor,
  invocation: WriteInvocation = { origin: ignoredMutationOriginForActor(actor), toolAudit: null },
) {
  const selection = validateSceneSelection(input.sceneIds);
  if (!selection.ok) return selection;
  const context = await loadSceneOrderContext(dependencies, input);
  if (!context.ok) return context;
  const alignment = context.value.frameGrid.validate(input.deltaSeconds, "deltaSeconds");
  if (alignment) return { ok: false as const, error: alignment };
  const completePlan = planGroupShift(context.value.clips, input.sceneIds, input.deltaSeconds);
  return completePlan.ok
    ? applySceneOrderPlan(dependencies, context.value, completePlan.value, input, actor, invocation)
    : completePlan;
}
