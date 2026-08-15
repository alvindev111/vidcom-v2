import { randomBytes } from "node:crypto";

import type { ClockPort } from "@vidcom/core";

export type AttachmentKind = "bridge" | "ui" | "render";

export const attachmentPolicy = {
  heartbeatEveryMs: 5_000,
  ttlMs: 20_000,
  /** How long an auto-started daemon stays up with nothing attached and nothing running. */
  gracePeriodMs: 60_000,
} as const;

export interface Attachment {
  attachmentId: string;
  kind: AttachmentKind;
  expiresAt: string;
  heartbeatEveryMs: number;
}

interface StoredAttachment {
  kind: AttachmentKind;
  credentialId: string;
  instanceId: string;
  expiresAt: number;
}

export interface AttachmentRegistryOptions {
  clock: ClockPort;
  instanceId: string;
  /** True while any non-terminal job belongs to this workspace. */
  hasActiveWork: () => boolean | Promise<boolean>;
  /** Only a daemon this process started on demand may ever shut itself down. */
  autoStarted: boolean;
  random?: (size: number) => Buffer;
}

/**
 * The daemon's own count of who is still here.
 *
 * An attachment measures a live client and nothing else. It is deliberately not
 * a measure of work in progress: `--detach` lets a CLI exit immediately, so a
 * refcount built only from attachments shuts the daemon down in the middle of a
 * render. Work is held separately, read straight from the job store.
 */
export class AttachmentRegistry {
  private readonly attachments = new Map<string, StoredAttachment>();
  private readonly random: (size: number) => Buffer;
  private uiHasAttached = false;
  private idleSince: number | null = null;

  constructor(private readonly options: AttachmentRegistryOptions) {
    this.random = options.random ?? randomBytes;
  }

  private expire(now: number): void {
    for (const [id, attachment] of this.attachments) {
      if (now >= attachment.expiresAt) this.attachments.delete(id);
    }
  }

  attach(input: { kind: AttachmentKind; credentialId: string }): Attachment {
    const now = this.options.clock.now().getTime();
    this.expire(now);
    // 256 bits, because the id is the only thing a renew or detach presents.
    const attachmentId = this.random(32).toString("base64url");
    this.attachments.set(attachmentId, {
      kind: input.kind,
      credentialId: input.credentialId,
      instanceId: this.options.instanceId,
      expiresAt: now + attachmentPolicy.ttlMs,
    });
    // A UI attachment removes the right to self-shutdown permanently, not for as
    // long as it stays attached: a window that closes for a moment during a
    // workspace switch must not hand the daemon a reason to disappear.
    if (input.kind === "ui") this.uiHasAttached = true;
    this.idleSince = null;
    return this.describe(attachmentId);
  }

  /**
   * Extends an attachment, and only for the client that owns it.
   *
   * The credential and the instance are both checked because the id alone is
   * portable: a stale id replayed against a restarted daemon would otherwise
   * keep alive an attachment for a client that is long gone.
   */
  renew(attachmentId: string, credentialId: string): Attachment | null {
    const now = this.options.clock.now().getTime();
    this.expire(now);
    const attachment = this.attachments.get(attachmentId);
    if (!attachment) return null;
    if (attachment.credentialId !== credentialId) return null;
    if (attachment.instanceId !== this.options.instanceId) return null;
    attachment.expiresAt = now + attachmentPolicy.ttlMs;
    return this.describe(attachmentId);
  }

  detach(attachmentId: string, credentialId: string): boolean {
    const attachment = this.attachments.get(attachmentId);
    if (!attachment || attachment.credentialId !== credentialId) return false;
    this.attachments.delete(attachmentId);
    return true;
  }

  private describe(attachmentId: string): Attachment {
    const attachment = this.attachments.get(attachmentId);
    if (!attachment) throw new TypeError(`attachment is not registered: ${attachmentId}`);
    return {
      attachmentId,
      kind: attachment.kind,
      expiresAt: new Date(attachment.expiresAt).toISOString(),
      heartbeatEveryMs: attachmentPolicy.heartbeatEveryMs,
    };
  }

  live(): readonly Attachment[] {
    this.expire(this.options.clock.now().getTime());
    return [...this.attachments.keys()].map((id) => this.describe(id));
  }

  /**
   * Whether the daemon may shut itself down right now.
   *
   * Four conditions, all of which have to hold: nothing attached, no job
   * running, the daemon was started on demand, and it has been idle for the
   * grace period. Any one of them alone is a reason a daemon disappears while
   * someone still needs it.
   */
  async canSelfShutdown(): Promise<boolean> {
    if (!this.options.autoStarted) return false;
    if (this.uiHasAttached) return false;

    const now = this.options.clock.now().getTime();
    this.expire(now);
    if (this.attachments.size > 0 || await this.options.hasActiveWork()) {
      this.idleSince = null;
      return false;
    }
    // The grace period starts when the daemon first becomes idle, not when it
    // is asked: a caller that only checks once would otherwise never see the
    // period elapse.
    this.idleSince ??= now;
    return now - this.idleSince >= attachmentPolicy.gracePeriodMs;
  }
}
