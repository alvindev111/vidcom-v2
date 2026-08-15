import { AttachmentRegistry, attachmentPolicy } from "@vidcom/server";
import { describe, expect, it } from "vitest";

function registry(options: {
  autoStarted?: boolean;
  hasActiveWork?: () => boolean;
} = {}) {
  let now = new Date("2026-08-09T00:00:00.000Z").getTime();
  let counter = 0;
  const instance = new AttachmentRegistry({
    clock: { now: () => new Date(now) },
    instanceId: "daemon_first",
    autoStarted: options.autoStarted ?? true,
    hasActiveWork: options.hasActiveWork ?? (() => false),
    // Deterministic ids keep the assertions about ownership readable; the real
    // registry takes 256 bits from randomBytes.
    random: (size) => Buffer.alloc(size, (counter += 1)),
  });
  return { instance, advance: (ms: number) => { now += ms; } };
}

describe("attachment registry", () => {
  it("hands out an attachment with the heartbeat the client must keep", () => {
    const { instance } = registry();
    const attachment = instance.attach({ kind: "bridge", credentialId: "credential-1" });
    expect(attachment.heartbeatEveryMs).toBe(attachmentPolicy.heartbeatEveryMs);
    expect(Date.parse(attachment.expiresAt) - Date.parse("2026-08-09T00:00:00.000Z"))
      .toBe(attachmentPolicy.ttlMs);
  });

  it("drops an attachment whose client stopped heartbeating", () => {
    const { instance, advance } = registry();
    instance.attach({ kind: "bridge", credentialId: "credential-1" });
    advance(attachmentPolicy.ttlMs);
    expect(instance.live()).toEqual([]);
  });

  it("keeps an attachment alive across renewals", () => {
    const { instance, advance } = registry();
    const attached = instance.attach({ kind: "bridge", credentialId: "credential-1" });
    advance(attachmentPolicy.heartbeatEveryMs);
    expect(instance.renew(attached.attachmentId, "credential-1")).not.toBeNull();
    advance(attachmentPolicy.ttlMs - 1);
    expect(instance.live()).toHaveLength(1);
  });

  it("refuses a renewal from a different credential", () => {
    // The id alone is portable. Without this check, anything that ever saw an
    // id could keep alive an attachment for a client that is long gone.
    const { instance } = registry();
    const attached = instance.attach({ kind: "bridge", credentialId: "credential-1" });
    expect(instance.renew(attached.attachmentId, "credential-2")).toBeNull();
    expect(instance.detach(attached.attachmentId, "credential-2")).toBe(false);
  });

  it("refuses a renewal for an attachment that no longer exists", () => {
    const { instance } = registry();
    expect(instance.renew("never-issued", "credential-1")).toBeNull();
  });

  it("does not shut down while a client is attached", async () => {
    const { instance, advance } = registry();
    instance.attach({ kind: "bridge", credentialId: "credential-1" });
    advance(attachmentPolicy.gracePeriodMs * 2);
    expect(await instance.canSelfShutdown()).toBe(false);
  });

  it("does not shut down while a job is still running", async () => {
    // This is the bug the separation exists for: `--detach` lets the CLI exit
    // immediately, so its attachment expires while the render keeps going. A
    // refcount built only from attachments kills the daemon mid-render.
    const { instance, advance } = registry({ hasActiveWork: () => true });
    advance(attachmentPolicy.gracePeriodMs * 2);
    expect(await instance.canSelfShutdown()).toBe(false);
  });

  it("never shuts down a daemon a person started", async () => {
    const { instance, advance } = registry({ autoStarted: false });
    advance(attachmentPolicy.gracePeriodMs * 2);
    expect(await instance.canSelfShutdown()).toBe(false);
  });

  it("loses the right to self-shutdown permanently once a UI has attached", async () => {
    // Permanently, not while attached: a window that closes for a moment during
    // a workspace switch must not hand the daemon a reason to disappear.
    const { instance, advance } = registry();
    const ui = instance.attach({ kind: "ui", credentialId: "credential-1" });
    instance.detach(ui.attachmentId, "credential-1");
    advance(attachmentPolicy.gracePeriodMs * 2);
    expect(await instance.canSelfShutdown()).toBe(false);
  });

  it("shuts down only after the grace period has actually elapsed", async () => {
    const { instance, advance } = registry();
    // The period runs from the moment the daemon became idle, so a first check
    // starts the clock rather than satisfying it.
    expect(await instance.canSelfShutdown()).toBe(false);
    advance(attachmentPolicy.gracePeriodMs - 1);
    expect(await instance.canSelfShutdown()).toBe(false);
    advance(1);
    expect(await instance.canSelfShutdown()).toBe(true);
  });

  it("restarts the grace period when someone comes back", async () => {
    const { instance, advance } = registry();
    expect(await instance.canSelfShutdown()).toBe(false);
    advance(attachmentPolicy.gracePeriodMs - 1);
    const attached = instance.attach({ kind: "bridge", credentialId: "credential-1" });
    instance.detach(attached.attachmentId, "credential-1");
    advance(2);
    expect(await instance.canSelfShutdown()).toBe(false);
  });
});
