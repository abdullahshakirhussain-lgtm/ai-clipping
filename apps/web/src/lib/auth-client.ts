"use client";
import { createAuthClient } from "better-auth/react";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

/** Talks to the API's mounted Better Auth handler; cookies live on the API origin. */
export const authClient = createAuthClient({
  baseURL: API_URL,
  basePath: "/api/auth",
  fetchOptions: { credentials: "include" },
});

export const { signIn, signOut, signUp, useSession } = authClient;
