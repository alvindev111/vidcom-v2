import { SUPPORTED_PROTOCOL_VERSIONS } from "@modelcontextprotocol/server";

/** Legacy revisions published by the pinned MCP server runtime. */
export const SDK_SUPPORTED_LEGACY_REVISIONS = SUPPORTED_PROTOCOL_VERSIONS;

/** SDK-neutral revision allowlist owned by shared contracts. */
export { SUPPORTED_REVISIONS, type Era, type ProtocolRevision } from "@vidcom/contracts";
