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
  const url = new URL(rawUrl);
  url.searchParams.delete("t");
  return url.toString();
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
  const allowed = new Set(allowedOrigins);
  return async (c, next) => {
    const origin = c.req.header("Origin");
    if (origin && !allowed.has(origin)) {
      reject(ErrorCode.OriginNotAllowed, "request origin is not allowed");
    }
    if (origin) {
      c.header("Access-Control-Allow-Origin", origin);
      c.header("Vary", "Origin");
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
