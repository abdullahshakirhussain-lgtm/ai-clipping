import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { getPrisma } from "@clipfactory/db";
import type { Env } from "@clipfactory/core";

/**
 * Better Auth instance backed by the shared Prisma client. Email+password only
 * for the MVP (internal ops tool). The session cookie is shared with the Next.js
 * dashboard via CORS credentials.
 */
export function createAuth(env: Env) {
  return betterAuth({
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.API_URL,
    database: prismaAdapter(getPrisma(), { provider: "postgresql" }),
    emailAndPassword: {
      enabled: true,
      autoSignIn: true,
    },
    trustedOrigins: [env.WEB_URL],
    user: {
      additionalFields: {
        role: { type: "string", defaultValue: "REVIEWER", input: false },
      },
    },
    advanced: {
      // In production the dashboard and API live on different origins (e.g.
      // separate *.railway.app subdomains), so the session cookie is sent on
      // cross-site fetches only with SameSite=None + Secure. Locally, Lax over
      // http is correct. Put both behind a custom domain to use Lax in prod too.
      defaultCookieAttributes:
        env.NODE_ENV === "production"
          ? { sameSite: "none", secure: true }
          : { sameSite: "lax", secure: false },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;
