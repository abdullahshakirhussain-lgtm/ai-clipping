"use client";
import { createAuthClient } from "better-auth/react";

/**
 * Same-origin: requests hit the web domain and Next.js proxies them to the API
 * (next.config.mjs rewrites), so the session cookie is first-party to the web
 * domain. baseURL is the current origin in the browser.
 */
export const authClient = createAuthClient({
  baseURL: typeof window !== "undefined" ? window.location.origin : undefined,
  basePath: "/api/auth",
  fetchOptions: { credentials: "include" },
});

export const { signIn, signOut, signUp, useSession } = authClient;
