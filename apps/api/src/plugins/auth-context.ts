import type { FastifyReply, FastifyRequest } from "fastify";
import { AppError } from "@clipfactory/core";
import type { Auth } from "../auth.js";

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: "ADMIN" | "REVIEWER";
}

declare module "fastify" {
  interface FastifyRequest {
    authUser?: AuthUser;
  }
}

/** Resolves the Better Auth session from request headers, if any. */
export async function loadSession(auth: Auth, request: FastifyRequest): Promise<AuthUser | null> {
  const session = await auth.api.getSession({ headers: toHeaders(request.headers) });
  if (!session?.user) return null;
  const u = session.user as { id: string; email: string; name: string; role?: string };
  return { id: u.id, email: u.email, name: u.name, role: (u.role as AuthUser["role"]) ?? "REVIEWER" };
}

/** requireAuth preHandler — 401 when no valid session. */
export function requireAuth(auth: Auth) {
  return async (request: FastifyRequest, _reply: FastifyReply) => {
    const user = await loadSession(auth, request);
    if (!user) throw new AppError("Authentication required", 401, "UNAUTHORIZED");
    request.authUser = user;
  };
}

/** requireRole preHandler — 403 unless the user has one of the given roles. */
export function requireRole(auth: Auth, roles: AuthUser["role"][]) {
  return async (request: FastifyRequest, _reply: FastifyReply) => {
    const user = await loadSession(auth, request);
    if (!user) throw new AppError("Authentication required", 401, "UNAUTHORIZED");
    if (!roles.includes(user.role)) throw new AppError("Forbidden", 403, "FORBIDDEN");
    request.authUser = user;
  };
}

export function toHeaders(raw: Record<string, unknown>): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(raw)) {
    if (Array.isArray(value)) headers.set(key, value.join(", "));
    else if (value != null) headers.set(key, String(value));
  }
  return headers;
}
