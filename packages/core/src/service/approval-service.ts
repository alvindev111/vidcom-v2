import { ErrorCode, type DomainError } from "@vidcom/contracts";

import { err, ok, type Result } from "../error/result";
import type { ApprovalGrantPort, ClockPort, IdPort } from "../port/ports";
import type { ApprovalGrantRecord, GrantBinding } from "../port/types";
import { canonicalizeJson } from "./canonical-json";

export const DEFAULT_APPROVAL_REQUEST_TTL_MS = 10 * 60 * 1_000;
export const DEFAULT_APPROVAL_GRANT_TTL_MS = 5 * 60 * 1_000;

export interface ApprovalServiceConfig {
  requestTtlMs: number;
  grantTtlMs: number;
}

export interface ApprovalServiceDependencies {
  grants: ApprovalGrantPort;
  clock: ClockPort;
  ids: IdPort;
  config?: Partial<ApprovalServiceConfig>;
}

/** Returns one stable binding representation with target hashes ordered by canonical relative path. */
export function canonicalizeGrantBinding(binding: GrantBinding): GrantBinding {
  const targetHashes = Object.fromEntries(
    Object.entries(binding.targetHashes).sort(([left], [right]) => left.localeCompare(right)),
  ) as GrantBinding["targetHashes"];
  return { ...binding, targetHashes };
}

function validBinding(binding: GrantBinding): boolean {
  return binding.tool.length > 0
    && binding.target.length > 0
    && binding.expectedRevision >= 0
    && Number.isInteger(binding.expectedRevision)
    && /^sha256:[0-9a-f]{64}$/.test(binding.planDigest)
    && Object.keys(binding.targetHashes).length > 0
    && Object.entries(binding.targetHashes).every(([path, hash]) =>
      path.length > 0 && !path.startsWith("/") && !path.includes("..") && /^sha256:[0-9a-f]{64}$/.test(hash));
}

/** Core approval lifecycle; journal T1 remains the final reserve authority. */
export class ApprovalService {
  private readonly config: ApprovalServiceConfig;

  constructor(private readonly dependencies: ApprovalServiceDependencies) {
    this.config = {
      requestTtlMs: dependencies.config?.requestTtlMs ?? DEFAULT_APPROVAL_REQUEST_TTL_MS,
      grantTtlMs: dependencies.config?.grantTtlMs ?? DEFAULT_APPROVAL_GRANT_TTL_MS,
    };
  }

  async request(binding: GrantBinding, summary: string): Promise<string> {
    const createdAt = this.dependencies.clock.now();
    const id = this.dependencies.ids.newId("grant");
    const record: ApprovalGrantRecord = {
      id,
      binding: canonicalizeGrantBinding(binding),
      summary,
      status: "requested",
      approver: null,
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + this.config.requestTtlMs).toISOString(),
    };
    await this.dependencies.grants.create(record);
    return id;
  }

  async issue(
    requestId: string,
    approver: "ui" | "cli",
  ): Promise<Result<string, DomainError>> {
    const now = this.dependencies.clock.now();
    const current = await this.dependencies.grants.read(requestId);
    if (!current || current.status !== "requested") {
      return err({ code: ErrorCode.ApprovalInvalid, message: "the approval request is not issuable" });
    }
    if (current.expiresAt <= now.toISOString()) {
      return err({ code: ErrorCode.ApprovalExpired, message: "the approval request has expired" });
    }
    const issued = await this.dependencies.grants.issue(
      requestId,
      approver,
      now.toISOString(),
      new Date(now.getTime() + this.config.grantTtlMs).toISOString(),
    );
    return issued
      ? ok(issued.id)
      : err({ code: ErrorCode.ApprovalInvalid, message: "the approval request lost its issue transition" });
  }

  async planReserve(
    grantId: string,
    binding: GrantBinding,
  ): Promise<Result<{ kind: "reserve"; grantId: string; binding: GrantBinding }, DomainError>> {
    const planned = canonicalizeGrantBinding(binding);
    if (!validBinding(planned)) {
      return err({ code: ErrorCode.ApprovalInvalid, message: "the approval binding is invalid" });
    }
    const now = this.dependencies.clock.now().toISOString();
    const current = await this.dependencies.grants.read(grantId);
    if (current?.status === "expired") {
      return err({ code: ErrorCode.ApprovalExpired, message: "the approval grant has expired" });
    }
    if (!current || current.status !== "issued") {
      return err({ code: ErrorCode.ApprovalInvalid, message: "the approval grant is not issued" });
    }
    if (current.expiresAt <= now) {
      return err({ code: ErrorCode.ApprovalExpired, message: "the approval grant has expired" });
    }
    if (current.binding.expectedRevision !== planned.expectedRevision) {
      return err({ code: ErrorCode.WriteConflict, message: "the approved project revision has changed" });
    }
    if (canonicalizeJson(canonicalizeGrantBinding(current.binding)) !== canonicalizeJson(planned)
      || !(await this.dependencies.grants.matches(grantId, planned, now))) {
      return err({ code: ErrorCode.ApprovalInvalid, message: "the approval grant binding does not match" });
    }
    return ok({ kind: "reserve", grantId, binding: planned });
  }

  async revoke(grantId: string): Promise<Result<void, DomainError>> {
    return await this.dependencies.grants.revoke(grantId)
      ? ok(undefined)
      : err({ code: ErrorCode.ApprovalInvalid, message: "only an issued grant can be revoked" });
  }

  async cleanupTerminal(olderThan: Date): Promise<number> {
    await this.dependencies.grants.expireDue(this.dependencies.clock.now().toISOString());
    return this.dependencies.grants.cleanupTerminal(olderThan.toISOString());
  }
}
