import { startMcpStdio } from "@vidcom/mcp";

import { createContractMatrixRegistry } from "../support";

const pinnedRevision = process.argv[2];
await startMcpStdio(
  createContractMatrixRegistry(),
  { onerror: (error) => process.stderr.write(`${error.message}\n`) },
  pinnedRevision ? { pinnedRevision } : {},
);
