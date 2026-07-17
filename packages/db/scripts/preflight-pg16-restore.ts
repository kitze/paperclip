import { runPg16RestorePreflight } from "../src/restore-preflight.js";

function env(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

async function main() {
  if (env("PAPERCLIP_ALLOW_RESTORE_PREFLIGHT") !== "1") {
    throw new Error(
      "Set PAPERCLIP_ALLOW_RESTORE_PREFLIGHT=1 to acknowledge the restore target is disposable.",
    );
  }

  const targetUrl = env("PAPERCLIP_PG16_RESTORE_DATABASE_URL");
  if (!targetUrl) {
    throw new Error("Set PAPERCLIP_PG16_RESTORE_DATABASE_URL to an empty throwaway PostgreSQL 16 database.");
  }

  await runPg16RestorePreflight({
    sourceConnectionString: env("PAPERCLIP_RESTORE_PREFLIGHT_SOURCE_DATABASE_URL") ?? env("DATABASE_URL"),
    targetConnectionString: targetUrl,
    expectedTargetDatabaseName: env("PAPERCLIP_PG16_RESTORE_EXPECTED_DATABASE_NAME") ?? "",
    suppliedBackupFile: env("PAPERCLIP_RESTORE_PREFLIGHT_BACKUP_FILE"),
  });
}

await main();
