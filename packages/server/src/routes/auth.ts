import { zValidator } from "@hono/zod-validator";
import { AuthExchangeRequestSchema, ErrorCode } from "@vidcom/contracts";
import type { SessionPort } from "@vidcom/core";
import { Hono } from "hono";
import { setCookie } from "hono/cookie";

import type { NonceSource } from "../auth/nonce";
import { sessionPolicy } from "../auth/session";
import { HttpBoundaryError } from "../middleware/error-mapper";
import { SESSION_COOKIE } from "../middleware/perimeter";

export function createAuthRoutes(
  nonces: NonceSource,
  sessions: SessionPort,
  trace?: (step: string) => void,
): Hono {
  return new Hono().post(
    "/auth/exchange",
    async (_c, next) => {
      trace?.("validate");
      await next();
    },
    zValidator("json", AuthExchangeRequestSchema, (result) => {
      if (!result.success) {
        throw new HttpBoundaryError({
          code: ErrorCode.SchemaInvalid,
          message: "request body is invalid",
        });
      }
    }),
    (c) => {
      trace?.("route");
      const { nonce } = c.req.valid("json");
      if (!nonces.consume(nonce)) {
        throw new HttpBoundaryError({
          code: ErrorCode.AuthNonceInvalid,
          message: "nonce is invalid or expired",
        });
      }

      const { token } = sessions.mint(sessionPolicy);
      setCookie(c, SESSION_COOKIE, token, {
        httpOnly: true,
        sameSite: "Strict",
        path: "/",
      });
      return c.body(null, 204);
    },
  );
}
