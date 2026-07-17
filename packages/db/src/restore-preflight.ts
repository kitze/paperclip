import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import postgres from "postgres";
import {
  formatDatabaseBackupResult,
  runDatabaseBackup,
  runDatabaseRestore,
  type RunDatabaseBackupResult,
} from "./backup-lib.js";

export type RestorePreflightTargetIdentity = {
  databaseName: string;
  serverVersionNum: string;
  userTableCount: number;
};

export type RestorePreflightSafetyOptions = {
  sourceConnectionString?: string | null;
  targetConnectionString: string;
  expectedTargetDatabaseName: string;
  queryTargetIdentity?: (connectionString: string) => Promise<RestorePreflightTargetIdentity>;
};

export type Pg16RestorePreflightOptions = RestorePreflightSafetyOptions & {
  suppliedBackupFile?: string | null;
  runBackup?: typeof runDatabaseBackup;
  runRestore?: typeof runDatabaseRestore;
};

const DANGEROUS_TARGET_DATABASE_NAMES = new Set([
  "paperclip",
  "paperclip_kitze",
  "postgres",
  "template0",
  "template1",
]);

function trimNonEmpty(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function parseConnectionIdentity(connectionString: string): { databaseName: string; host: string; port: string; username: string } {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch (error) {
    throw new Error(`Invalid PostgreSQL connection URL: ${error instanceof Error ? error.message : String(error)}`);
  }

  const databaseName = decodeURIComponent(url.pathname.replace(/^\/+/, "")).trim();
  if (!databaseName) {
    throw new Error("PostgreSQL connection URL must include a database name.");
  }

  return {
    databaseName,
    host: url.hostname.toLowerCase(),
    port: url.port || "5432",
    username: decodeURIComponent(url.username || "").toLowerCase(),
  };
}

function targetIdentityKey(connectionString: string): string {
  const identity = parseConnectionIdentity(connectionString);
  return [
    identity.host,
    identity.port,
    identity.databaseName.toLowerCase(),
    identity.username,
  ].join("/");
}

export async function queryRestorePreflightTargetIdentity(
  connectionString: string,
): Promise<RestorePreflightTargetIdentity> {
  const sql = postgres(connectionString, { max: 1, connect_timeout: 5 });
  try {
    const rows = await sql<RestorePreflightTargetIdentity[]>`
      SELECT
        current_setting('server_version_num') AS "serverVersionNum",
        current_database() AS "databaseName",
        (
          SELECT count(*)::int
          FROM information_schema.tables
          WHERE table_type = 'BASE TABLE'
            AND table_schema <> 'information_schema'
            AND table_schema NOT LIKE 'pg\_%' ESCAPE '\'
        ) AS "userTableCount"
    `;
    const row = rows[0];
    if (!row) {
      throw new Error("Could not read PostgreSQL target identity.");
    }
    return row;
  } finally {
    await sql.end();
  }
}

export async function assertSafePg16RestoreTarget(opts: RestorePreflightSafetyOptions): Promise<RestorePreflightTargetIdentity> {
  const expectedTargetDatabaseName = trimNonEmpty(opts.expectedTargetDatabaseName);
  if (!expectedTargetDatabaseName) {
    throw new Error("Set PAPERCLIP_PG16_RESTORE_EXPECTED_DATABASE_NAME to the intended empty throwaway target database.");
  }

  const targetUrlIdentity = parseConnectionIdentity(opts.targetConnectionString);
  if (targetUrlIdentity.databaseName !== expectedTargetDatabaseName) {
    throw new Error(
      `Restore preflight target URL database ${targetUrlIdentity.databaseName} does not match expected target ${expectedTargetDatabaseName}.`,
    );
  }

  if (DANGEROUS_TARGET_DATABASE_NAMES.has(expectedTargetDatabaseName.toLowerCase())) {
    throw new Error(
      `Restore preflight target database ${expectedTargetDatabaseName} is a protected production/default name; use a uniquely named throwaway database.`,
    );
  }

  if (opts.sourceConnectionString && targetIdentityKey(opts.sourceConnectionString) === targetIdentityKey(opts.targetConnectionString)) {
    throw new Error("Restore preflight source and target resolve to the same PostgreSQL database identity.");
  }

  const queryTargetIdentity = opts.queryTargetIdentity ?? queryRestorePreflightTargetIdentity;
  const target = await queryTargetIdentity(opts.targetConnectionString);
  const versionNum = Number.parseInt(target.serverVersionNum, 10);
  const major = Number.isInteger(versionNum) ? Math.floor(versionNum / 10000) : null;
  if (major !== 16) {
    throw new Error(
      `Restore preflight target must be PostgreSQL 16; target database ${target.databaseName || "(unknown)"} reports ${target.serverVersionNum || "(unknown)"}.`,
    );
  }

  if (target.databaseName !== expectedTargetDatabaseName) {
    throw new Error(
      `Restore preflight connected to database ${target.databaseName}, not expected target ${expectedTargetDatabaseName}.`,
    );
  }

  if (target.userTableCount !== 0) {
    throw new Error(
      `Restore preflight target ${target.databaseName} is not empty; found ${target.userTableCount} user table(s).`,
    );
  }

  return target;
}

export async function runPg16RestorePreflight(opts: Pg16RestorePreflightOptions): Promise<{ backupFile: string; backup?: RunDatabaseBackupResult }> {
  await assertSafePg16RestoreTarget(opts);

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-pg16-restore-preflight-"));
  let backupFile = trimNonEmpty(opts.suppliedBackupFile);
  let backup: RunDatabaseBackupResult | undefined;
  const runBackup = opts.runBackup ?? runDatabaseBackup;
  const runRestore = opts.runRestore ?? runDatabaseRestore;

  try {
    if (!backupFile) {
      if (!opts.sourceConnectionString) {
        throw new Error(
          "Set PAPERCLIP_RESTORE_PREFLIGHT_BACKUP_FILE or PAPERCLIP_RESTORE_PREFLIGHT_SOURCE_DATABASE_URL.",
        );
      }
      backup = await runBackup({
        connectionString: opts.sourceConnectionString,
        backupDir: tempDir,
        retention: { dailyDays: 1, weeklyWeeks: 1, monthlyMonths: 1 },
        filenamePrefix: "paperclip-pg16-preflight",
      });
      backupFile = backup.backupFile;
      console.log(`Created temporary backup: ${formatDatabaseBackupResult(backup)}`);
    }

    if (!fs.existsSync(backupFile)) {
      throw new Error(`Backup file does not exist: ${backupFile}`);
    }

    await runRestore({
      connectionString: opts.targetConnectionString,
      backupFile,
    });

    console.log(`PG16 restore preflight passed for ${backupFile}`);
    return { backupFile, backup };
  } finally {
    if (!opts.suppliedBackupFile) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }
}
