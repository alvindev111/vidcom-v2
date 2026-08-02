/**
 * Child process for the Q10 stdio probe: an MCP server over stdio built ONLY
 * from `@modelcontextprotocol/server@2.x`. No `sdk@1.x` here.
 *
 * `legacy` is left at its default (`'serve'`) so the same factory has to cover
 * both eras. Anything written to stdout other than protocol frames breaks the
 * handshake, so the era is reported on stderr.
 */
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

await serveStdio(({ era }) => {
  process.stderr.write(`era=${era}\n`);
  const server = new McpServer({ name: "vidcom-q10-stdio", version: "0.0.0" });
  server.registerTool(
    "echo",
    {
      inputSchema: z.object({ message: z.string() }),
      outputSchema: z.object({ echo: z.string() }),
    },
    async ({ message }) => ({
      content: [{ type: "text", text: message }],
      structuredContent: { echo: message },
    }),
  );
  return server;
});
