import { getPrisma } from "@clipfactory/db";
import type { Container } from "@clipfactory/core";
import type { Auth } from "./auth.js";

/**
 * Creates a first ADMIN user on an empty database so the dashboard is usable
 * immediately in dev. No-op once any user exists.
 */
export async function bootstrapAdmin(container: Container, auth: Auth): Promise<void> {
  const { env, logger } = container;
  const prisma = getPrisma();
  // Never fatal: a DB blip at boot shouldn't take down the API. If the DB is
  // unreachable we log and continue — the server still serves /health and /docs.
  try {
    const count = await prisma.user.count();
    if (count > 0) return;

    await auth.api.signUpEmail({
      body: { email: env.ADMIN_EMAIL, password: env.ADMIN_PASSWORD, name: "Admin" },
    });
    await prisma.user.update({ where: { email: env.ADMIN_EMAIL }, data: { role: "ADMIN" } });
    logger.info({ email: env.ADMIN_EMAIL }, "bootstrapped admin user");
  } catch (err) {
    logger.warn({ err: String(err) }, "admin bootstrap skipped (database not reachable?)");
  }
}
