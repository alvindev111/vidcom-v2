import { randomUUID } from "node:crypto";

import { ErrorCode } from "@vidcom/contracts";
import type { SessionPort } from "@vidcom/core";
import { getCookie } from "hono/cookie";
import type { MiddlewareHandler } from "hono";

import { HttpBoundaryError } from "./error-mapper";

export const SESSION_COOKIE = "vidcom_session";

export interface McpCredentialVerifier {
  verify(secret: string): Promise<{ id: string } | null>;
}

export type McpAuthEnv = {
  Variables: { credentialId: string };
};

const CORS_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;
const CORS_HEADERS = ["Authorization", "Content-Type", "MCP-Protocol-Version", "Mcp-Method", "Mcp-Name"] as const;
const CORS_HEADER_NAMES = new Set(CORS_HEADERS.map((header) => header.toLowerCase()));

function reject(code: ErrorCode, message: string): never {
  throw new HttpBoundaryError({ code, message });
}

export function requestId(): MiddlewareHandler {
  return async (c, next) => {
    c.set("requestId", randomUUID());
    c.header("X-Request-Id", c.get("requestId"));
    c.header("Referrer-Policy", "no-referrer");
    await next();
  };
}

export function redactRequestUrl(rawUrl: string): string {
  return new URL(rawUrl).pathname;
}

export function requestLogger(write: (line: string) => void): MiddlewareHandler {
  return async (c, next) => {
    write(`${c.req.method} ${redactRequestUrl(c.req.url)}`);
    await next();
  };
}

export function hostCheck(port: number): MiddlewareHandler {
  const allowed = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  return async (c, next) => {
    if (!allowed.has(c.req.header("Host") ?? "")) {
      reject(ErrorCode.HostNotAllowed, "request host is not allowed");
    }
    await next();
  };
}

export function strictCors(allowedOrigins: readonly string[]): MiddlewareHandler {
  const allowed = new Map<string, string>();
  for (const configured of allowedOrigins) {
    const canonical = new URL(configured).origin;
    allowed.set(canonical, canonical);
  }
  return async (c, next) => {
    const origin = c.req.header("Origin");
    if (origin) {
      let canonical: string;
      try { canonical = new URL(origin).origin; }
      catch { return reject(ErrorCode.OriginNotAllowed, "request origin is not allowed"); }
      const configured = allowed.get(canonical);
      if (!configured) reject(ErrorCode.OriginNotAllowed, "request origin is not allowed");
      c.header("Access-Control-Allow-Origin", configured);
      c.header("Access-Control-Allow-Credentials", "true");
      c.header("Vary", "Origin");
      const requestedMethod = c.req.header("Access-Control-Request-Method")?.toUpperCase();
      if (c.req.method === "OPTIONS" && requestedMethod) {
        if (!CORS_METHODS.includes(requestedMethod as (typeof CORS_METHODS)[number])) {
          reject(ErrorCode.OriginNotAllowed, "CORS preflight method is not allowed");
        }
        const requestedHeaders = (c.req.header("Access-Control-Request-Headers") ?? "")
          .split(",")
          .map((header) => header.trim().toLowerCase())
          .filter(Boolean);
        if (requestedHeaders.some((header) => !CORS_HEADER_NAMES.has(header))) {
          reject(ErrorCode.OriginNotAllowed, "CORS preflight header is not allowed");
        }
        c.header("Access-Control-Allow-Methods", CORS_METHODS.join(", "));
        c.header("Access-Control-Allow-Headers", CORS_HEADERS.join(", "));
        c.header("Vary", "Origin, Access-Control-Request-Method, Access-Control-Request-Headers");
        return c.body(null, 204);
      }
    }
    await next();
  };
}

export function sessionAuth(sessions: SessionPort): MiddlewareHandler {
  return async (c, next) => {
    const isExchange = c.req.method === "POST" && c.req.path === "/api/v1/auth/exchange";
    if (!isExchange) {
      const token = getCookie(c, SESSION_COOKIE);
      if (!token || !sessions.verify(token).valid) {
        reject(ErrorCode.AuthRequired, "authentication required");
      }
    }
    await next();
  };
}

/** Requires one MCP bearer and exposes only its non-secret credential ID downstream. */
export function mcpBearerAuth(credentials: McpCredentialVerifier): MiddlewareHandler<McpAuthEnv> {
  return async (c, next) => {
    const authorization = c.req.header("Authorization") ?? "";
    const match = /^Bearer ([^\s]+)$/i.exec(authorization);
    const verified = match ? await credentials.verify(match[1]!) : null;
    if (!verified) reject(ErrorCode.CredentialInvalid, "credential_invalid");
    c.set("credentialId", verified.id);
    await next();
  };
}
