import { EventEmitter } from "node:events";

import { describe, expect, it } from "vitest";

import { startMcpStdio, type ToolRegistry } from "@vidcom/mcp";

const emptyRegistry = { list: () => [] } as unknown as ToolRegistry;
type TestTransport = NonNullable<NonNullable<Parameters<typeof startMcpStdio>[1]>["transport"]>;

function createTransport(): TestTransport {
  return {
    onclose: undefined,
    onerror: undefined,
    onmessage: undefined,
    async start() {},
    async send() {},
    async close() { this.onclose?.(); },
  };
}

describe("MCP stdio lifecycle", () => {
  it.each(["stdin EOF", "stdout close"] as const)("settles and closes on %s", async (event) => {
    const stdin = new EventEmitter();
    const stdout = new EventEmitter();
    const transport = createTransport();
    const handle = await startMcpStdio(emptyRegistry, { transport, stdin, stdout });

    if (event === "stdin EOF") stdin.emit("end");
    else stdout.emit("close");

    await expect(handle.closed).resolves.toBeUndefined();
    await expect(handle.close()).resolves.toBeUndefined();
    expect(stdin.listenerCount("end")).toBe(0);
    expect(stdout.listenerCount("close")).toBe(0);
  });
});
