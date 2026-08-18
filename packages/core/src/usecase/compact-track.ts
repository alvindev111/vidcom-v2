import { ErrorCode, type Actor, type ProjectId } from "@vidcom/contracts";

import { planCompact } from "../domain/plan-scene-order";
import { err } from "../error/result";
import { ignoredMutationOriginForActor } from "../port/mutation-observer";
import type { WriteInvocation } from "../port/types";
import type { ProjectWriteDependencies } from "./project-writes";
import { applySceneOrderPlan, loadSceneOrderContext } from "./scene-order-write";

export async function compactTrack(
  dependencies: ProjectWriteDependencies,
  input: {
    projectId: ProjectId;
    trackIndex: number;
    extendRoot?: boolean;
    expectedContentHash: string;
  },
  actor: Actor,
  invocation: WriteInvocation = { origin: ignoredMutationOriginForActor(actor), toolAudit: null },
) {
  if (!Number.isInteger(input.trackIndex)) {
    return err({ code: ErrorCode.TimingInvalid, message: "trackIndex must be an integer", field: "trackIndex" });
  }
  const context = await loadSceneOrderContext(dependencies, input);
  if (!context.ok) return context;
  return applySceneOrderPlan(
    dependencies,
    context.value,
    planCompact(context.value.clips, input.trackIndex),
    input,
    actor,
    invocation,
  );
}
