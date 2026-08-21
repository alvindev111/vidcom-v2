import { describe, expect, it } from "vitest";

import {
  ApplyFontRequestSchema,
  CreateEntryRequestSchema,
  DeleteEntryRequestSchema,
  RenameEntryRequestSchema,
  UploadAssetQuerySchema,
} from "@vidcom/contracts";

describe("editing asset contracts", () => {
  it("accepts raw upload query metadata and enforces pending mount all-or-none", () => {
    expect(UploadAssetQuerySchema.safeParse({ kind: "font", filename: "local.woff2", expectedRevision: "3" }).success).toBe(true);
    expect(UploadAssetQuerySchema.safeParse({
      kind: "video", filename: "clip.mp4", expectedRevision: "3",
      operationId: "01K2ABCDEFGHJKMNPQRSTVWXYZ", atSeconds: "1.5", trackIndex: "2",
    }).success).toBe(true);
    expect(UploadAssetQuerySchema.safeParse({
      kind: "video", filename: "clip.mp4", expectedRevision: "3", operationId: "01K2ABCDEFGHJKMNPQRSTVWXYZ",
    }).success).toBe(false);
    expect(UploadAssetQuerySchema.safeParse({ kind: "font", filename: "x.woff2", expectedRevision: "3", extra: "no" }).success).toBe(false);
  });

  it("keeps CRUD and font payloads strict and discriminated", () => {
    expect(CreateEntryRequestSchema.safeParse({ path: "assets/new", kind: "folder", expectedRevision: 1 }).success).toBe(true);
    expect(RenameEntryRequestSchema.safeParse({
      from: "assets/a", to: "assets/b", expectedRevision: 1,
      expectedTreeDigest: `sha256:${"a".repeat(64)}`,
    }).success).toBe(true);
    expect(RenameEntryRequestSchema.safeParse({
      from: "assets/a", to: "assets/b", expectedRevision: 1,
      expectedContentHash: `sha256:${"a".repeat(64)}`, expectedTreeDigest: `sha256:${"a".repeat(64)}`,
    }).success).toBe(false);
    expect(DeleteEntryRequestSchema.safeParse({ path: "assets/a", recursive: true, expectedRevision: 1 }).success).toBe(true);
    expect(ApplyFontRequestSchema.safeParse({
      fontPath: "assets/font.woff2", fontContentHash: `sha256:${"b".repeat(64)}`,
      scope: { kind: "scene", sceneId: "scene-a" }, expectedContentHash: `sha256:${"c".repeat(64)}`,
    }).success).toBe(true);
    expect(ApplyFontRequestSchema.safeParse({
      fontPath: "assets/font.woff2", family: "client-owned", fontContentHash: `sha256:${"b".repeat(64)}`,
      scope: { kind: "project" }, expectedContentHash: `sha256:${"c".repeat(64)}`,
    }).success).toBe(false);
  });
});
