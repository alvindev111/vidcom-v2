import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import {
  RemoteAssetReportCollector,
  type JobId,
  type RuntimeAssetGuardPort,
  type RuntimeAssetReport,
} from "@vidcom/core";

const CALLBACK_HOST = "127.0.0.1";
const MAX_REPORT_BYTES = 16 * 1024;

interface GuardSession {
  token: string;
  collector: RemoteAssetReportCollector;
  server: Server;
}

function sameToken(actual: string, expected: string): boolean {
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

function respond(response: ServerResponse, status: number): void {
  response.writeHead(status, {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "cache-control": "no-store",
  }).end();
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > MAX_REPORT_BYTES) throw new RangeError("runtime guard report is too large");
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function reportFrom(value: unknown, jobId: JobId, token: string): RuntimeAssetReport | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  if (input.jobId !== jobId || typeof input.token !== "string" || !sameToken(input.token, token)) return null;
  if (input.kind === "media"
    && typeof input.blockedUri === "string"
    && /^https?:\/\//iu.test(input.blockedUri)
    && (input.directive === "img-src" || input.directive === "media-src")) {
    return {
      kind: "media",
      jobId,
      blockedUri: input.blockedUri,
      directive: input.directive,
    };
  }
  if (input.kind === "external"
    && typeof input.url === "string"
    && /^https?:\/\//iu.test(input.url)
    && (input.initiatorType === "script" || input.initiatorType === "link"
      || input.initiatorType === "css" || input.initiatorType === "font")) {
    return {
      kind: "external",
      jobId,
      url: input.url,
      initiatorType: input.initiatorType,
    };
  }
  return null;
}

function bootstrap(callbackUrl: string, jobId: JobId, token: string): string {
  return `(() => {
  const callbackUrl = ${JSON.stringify(callbackUrl)};
  const jobId = ${JSON.stringify(jobId)};
  const token = ${JSON.stringify(token)};
  const observed = new Set();
  const send = (report) => fetch(callbackUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jobId, token, ...report })
  }).catch(() => {});
  addEventListener("securitypolicyviolation", (event) => {
    if (event.effectiveDirective !== "img-src" && event.effectiveDirective !== "media-src") return;
    send({ kind: "media", blockedUri: event.blockedURI, directive: event.effectiveDirective });
  });
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      if (!/^https?:/i.test(entry.name) || entry.name === callbackUrl) continue;
      if (!["script", "link", "css", "font"].includes(entry.initiatorType)) continue;
      const key = entry.initiatorType + "\\u0000" + entry.name;
      if (observed.has(key) || observed.size >= 100) continue;
      observed.add(key);
      send({ kind: "external", url: entry.name, initiatorType: entry.initiatorType });
    }
  }).observe({ type: "resource", buffered: true });
})();`;
}

/** Per-job, loopback-only runtime report channel. Tokens live only for the render session. */
export class LoopbackRuntimeAssetGuard implements RuntimeAssetGuardPort {
  private readonly sessions = new Map<JobId, GuardSession>();

  async open(jobId: JobId): Promise<{ csp: string; bootstrapScript: string; token: string }> {
    if (this.sessions.has(jobId)) throw new Error("runtime asset guard is already open for this job");
    const token = randomBytes(32).toString("base64url");
    const collector = new RemoteAssetReportCollector(jobId);
    const server = createServer(async (request, response) => {
      if (request.method === "OPTIONS") {
        respond(response, 204);
        return;
      }
      if (request.method !== "POST" || request.url !== "/report") {
        respond(response, 404);
        return;
      }
      try {
        const report = reportFrom(await readJson(request), jobId, token);
        respond(response, report && collector.record(report) ? 204 : 403);
      } catch {
        respond(response, 400);
      }
    });
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      server.once("error", onError);
      server.listen(0, CALLBACK_HOST, () => {
        server.off("error", onError);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new Error("runtime asset guard did not bind a TCP port");
    }
    this.sessions.set(jobId, { token, collector, server });
    const callbackUrl = `http://${CALLBACK_HOST}:${address.port}/report`;
    return {
      csp: "default-src * data: blob: 'unsafe-inline' 'unsafe-eval'; img-src 'self' data: blob:; media-src 'self' data: blob:; connect-src *",
      bootstrapScript: bootstrap(callbackUrl, jobId, token),
      token,
    };
  }

  async close(jobId: JobId, token: string) {
    const session = this.sessions.get(jobId);
    if (!session || !sameToken(token, session.token)) throw new Error("runtime asset guard token is invalid");
    this.sessions.delete(jobId);
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(forceClose);
        if (error) reject(error);
        else resolve();
      };
      const forceClose = setTimeout(() => {
        session.server.closeAllConnections();
        finish();
      }, 2_000);
      forceClose.unref?.();
      session.server.close((error) => finish(error ?? undefined));
      session.server.closeIdleConnections();
    });
    return session.collector.snapshot();
  }
}
