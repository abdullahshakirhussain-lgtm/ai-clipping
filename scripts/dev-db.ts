/**
 * Boots a local embedded PostgreSQL for development on machines without Docker.
 * Data persists under .data/pg. Listens on port 5433 so it never collides with
 * a Docker/system Postgres on 5432.
 */
import EmbeddedPostgres from "embedded-postgres";
import { existsSync } from "node:fs";
import { join } from "node:path";

const dataDir = join(process.cwd(), ".data", "pg");
const alreadyInitialised = existsSync(join(dataDir, "PG_VERSION"));

const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: "postgres",
  password: "postgres",
  port: 5433,
  persistent: true,
});

async function main() {
  if (!alreadyInitialised) {
    console.log("[dev-db] initialising embedded postgres data dir...");
    await pg.initialise();
  }
  await pg.start();
  const client = pg.getPgClient();
  await client.connect();
  const res = await client.query("SELECT 1 FROM pg_database WHERE datname = 'clipfactory'");
  if (res.rowCount === 0) {
    await client.query("CREATE DATABASE clipfactory");
    console.log("[dev-db] created database 'clipfactory'");
  }
  await client.end();
  console.log("[dev-db] postgres ready on postgresql://postgres:postgres@localhost:5433/clipfactory");
  console.log("[dev-db] press Ctrl+C to stop");

  const stop = async () => {
    console.log("[dev-db] stopping...");
    await pg.stop();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch(async (err) => {
  console.error("[dev-db] failed:", err);
  try {
    await pg.stop();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
