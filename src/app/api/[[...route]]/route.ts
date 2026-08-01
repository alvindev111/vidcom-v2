import { handleNextHostedRequest } from "@vidcom/cli";
import { Hono } from "hono";
import { handle } from "hono/vercel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const host = new Hono().all("*", (c) => handleNextHostedRequest(c.req.raw));
const handler = handle(host);

export { handler as GET };
export { handler as POST };
export { handler as PUT };
export { handler as PATCH };
export { handler as DELETE };
export { handler as OPTIONS };
