import type {
  ClockPort,
  IdPort,
  McpCredentialCryptoPort,
  McpCredentialPort,
} from "../port/ports";
import type { McpCredentialRecord, McpCredentialSummary } from "../port/types";

export const DEFAULT_CREDENTIAL_ROTATION_OVERLAP_MS = 5 * 60 * 1_000;
export const MAX_CREDENTIAL_ROTATION_OVERLAP_MS = 24 * 60 * 60 * 1_000;
const ECMASCRIPT_DATE_MAX_MS = 8_640_000_000_000_000;

function validateRotationOverlap(overlapMs: number): void {
  if (!Number.isSafeInteger(overlapMs) || overlapMs < 0
    || overlapMs > MAX_CREDENTIAL_ROTATION_OVERLAP_MS) {
    throw new TypeError(
      `credential rotation overlap must be an integer between 0 and ${MAX_CREDENTIAL_ROTATION_OVERLAP_MS}`,
    );
  }
}

export interface McpCredentialServiceConfig {
  rotationOverlapMs: number;
}

export interface McpCredentialServiceDependencies {
  credentials: McpCredentialPort;
  crypto: McpCredentialCryptoPort;
  clock: ClockPort;
  ids: IdPort;
  config?: Partial<McpCredentialServiceConfig>;
}

/** Core lifecycle for one-time MCP bearer issuance and non-secret persistence. */
export class McpCredentialService {
  private readonly config: McpCredentialServiceConfig;

  constructor(private readonly dependencies: McpCredentialServiceDependencies) {
    const rotationOverlapMs = dependencies.config?.rotationOverlapMs
      ?? DEFAULT_CREDENTIAL_ROTATION_OVERLAP_MS;
    validateRotationOverlap(rotationOverlapMs);
    this.config = {
      rotationOverlapMs,
    };
  }

  async issue(label: string): Promise<{ id: string; secret: string }> {
    const normalizedLabel = label.trim();
    if (normalizedLabel.length === 0) throw new TypeError("credential label must not be empty");

    const id = this.dependencies.ids.newId("credential");
    const issued = this.dependencies.crypto.issue();
    const record: McpCredentialRecord = {
      id,
      label: normalizedLabel,
      secretHash: issued.secretHash,
      status: "active",
      createdAt: this.dependencies.clock.now().toISOString(),
      rotatedFrom: null,
      expiresAt: null,
    };
    await this.dependencies.credentials.create(record);
    return { id, secret: issued.secret };
  }

  async verify(secret: string): Promise<{ id: string } | null> {
    const secretHash = this.dependencies.crypto.hash(secret);
    if (!secretHash) return null;
    const credential = await this.dependencies.credentials.findUsableByHash(
      secretHash,
      this.dependencies.clock.now().toISOString(),
    );
    return credential && this.dependencies.crypto.equals(secretHash, credential.secretHash)
      ? { id: credential.id }
      : null;
  }

  async rotate(
    id: string,
    overlapMs = this.config.rotationOverlapMs,
  ): Promise<{ id: string; secret: string }> {
    validateRotationOverlap(overlapMs);
    const current = await this.dependencies.credentials.read(id);
    if (!current || current.status !== "active") throw new Error("credential_invalid");

    const createdAt = this.dependencies.clock.now();
    const expiresAtMs = createdAt.getTime() + overlapMs;
    if (!Number.isFinite(expiresAtMs) || Math.abs(expiresAtMs) > ECMASCRIPT_DATE_MAX_MS) {
      throw new TypeError("credential rotation expiry is outside the ECMAScript Date range");
    }
    const replacementId = this.dependencies.ids.newId("credential");
    const issued = this.dependencies.crypto.issue();
    const replacement: McpCredentialRecord = {
      id: replacementId,
      label: current.label,
      secretHash: issued.secretHash,
      status: "active",
      createdAt: createdAt.toISOString(),
      rotatedFrom: current.id,
      expiresAt: null,
    };
    const rotated = await this.dependencies.credentials.rotate(
      current.id,
      replacement,
      new Date(expiresAtMs).toISOString(),
    );
    if (!rotated) throw new Error("credential_invalid");
    return { id: replacement.id, secret: issued.secret };
  }

  async revoke(id: string): Promise<void> {
    if (!(await this.dependencies.credentials.revoke(id))) throw new Error("credential_invalid");
  }

  async list(): Promise<McpCredentialSummary[]> {
    return (await this.dependencies.credentials.list()).map((record) => ({
      id: record.id,
      label: record.label,
      status: record.status,
      createdAt: record.createdAt,
      rotatedFrom: record.rotatedFrom,
      expiresAt: record.expiresAt,
    }));
  }
}
