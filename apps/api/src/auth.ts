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
      defaultCookieAttributes: {
        sameSite: "lax",
        secure: env.NODE_ENV === "production",
      },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;
