import { startMcpStdio } from "@vidcom/mcp";

import { createTransportRegistry } from "../support";

const pinnedRevision = process.argv[2];

await startMcpStdio(createTransportRegistry(), {
  onerror: (error) => process.stderr.write(`${error.message}\n`),
}, pinnedRevision ? { pinnedRevision } : {});
