import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertSafePg16RestoreTarget,
  runPg16RestorePreflight,
  type RestorePreflightTargetIdentity,
} from "./restore-preflight.js";

const tempFiles: string[] = [];

function targetIdentity(overrides: Partial<RestorePreflightTargetIdentity> = {}): RestorePreflightTargetIdentity {
  return {
    databaseName: "paperclip_restore_preflight_20260717",
    serverVersionNum: "160009",
    userTableCount: 0,
    ...overrides,
  };
}

function makeBackupFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-restore-preflight-test-"));
  tempFiles.push(dir);
  const file = path.join(dir, "backup.sql");
  fs.writeFileSync(file, "-- test backup\n", "utf8");
  return file;
}

afterEach(() => {
  vi.restoreAllMocks();
  while (tempFiles.length > 0) {
    fs.rmSync(tempFiles.pop()!, { recursive: true, force: true });
  }
});

describe("assertSafePg16RestoreTarget", () => {
  it("requires an explicit expected target database identity", async () => {
    const queryTargetIdentity = vi.fn(async () => targetIdentity());

    await expect(assertSafePg16RestoreTarget({
      targetConnectionString: "postgres://user:pass@localhost:5432/paperclip_restore_preflight_20260717",
      expectedTargetDatabaseName: "",
      queryTargetIdentity,
    })).rejects.toThrow(/PAPERCLIP_PG16_RESTORE_EXPECTED_DATABASE_NAME/);
    expect(queryTargetIdentity).not.toHaveBeenCalled();
  });

  it("rejects target URLs that do not match the expected database before connecting", async () => {
    const queryTargetIdentity = vi.fn(async () => targetIdentity());

    await expect(assertSafePg16RestoreTarget({
      targetConnectionString: "postgres://user:pass@localhost:5432/paperclip_kitze",
      expectedTargetDatabaseName: "paperclip_restore_preflight_20260717",
      queryTargetIdentity,
    })).rejects.toThrow(/does not match expected target/);
    expect(queryTargetIdentity).not.toHaveBeenCalled();
  });

  it("rejects known production and default database names before connecting", async () => {
    const queryTargetIdentity = vi.fn(async () => targetIdentity({ databaseName: "paperclip_kitze" }));

    await expect(assertSafePg16RestoreTarget({
      targetConnectionString: "postgres://user:pass@localhost:5432/paperclip_kitze",
      expectedTargetDatabaseName: "paperclip_kitze",
      queryTargetIdentity,
    })).rejects.toThrow(/protected production\/default name/);
    expect(queryTargetIdentity).not.toHaveBeenCalled();
  });

  it("rejects source and target database identity collision before connecting", async () => {
    const queryTargetIdentity = vi.fn(async () => targetIdentity());
    const url = "postgres://paperclip:secret@localhost:5432/paperclip_restore_preflight_20260717";

    await expect(assertSafePg16RestoreTarget({
      sourceConnectionString: url,
      targetConnectionString: url,
      expectedTargetDatabaseName: "paperclip_restore_preflight_20260717",
      queryTargetIdentity,
    })).rejects.toThrow(/same PostgreSQL database identity/);
    expect(queryTargetIdentity).not.toHaveBeenCalled();
  });

  it("rejects non-PG16 targets", async () => {
    await expect(assertSafePg16RestoreTarget({
      targetConnectionString: "postgres://user:pass@localhost:5432/paperclip_restore_preflight_20260717",
      expectedTargetDatabaseName: "paperclip_restore_preflight_20260717",
      queryTargetIdentity: vi.fn(async () => targetIdentity({ serverVersionNum: "150014" })),
    })).rejects.toThrow(/must be PostgreSQL 16/);
  });

  it("rejects a connected database identity that differs from the expected target", async () => {
    await expect(assertSafePg16RestoreTarget({
      targetConnectionString: "postgres://user:pass@localhost:5432/paperclip_restore_preflight_20260717",
      expectedTargetDatabaseName: "paperclip_restore_preflight_20260717",
      queryTargetIdentity: vi.fn(async () => targetIdentity({ databaseName: "paperclip_restore_other" })),
    })).rejects.toThrow(/not expected target/);
  });

  it("rejects targets that already contain user tables", async () => {
    await expect(assertSafePg16RestoreTarget({
      targetConnectionString: "postgres://user:pass@localhost:5432/paperclip_restore_preflight_20260717",
      expectedTargetDatabaseName: "paperclip_restore_preflight_20260717",
      queryTargetIdentity: vi.fn(async () => targetIdentity({ userTableCount: 1 })),
    })).rejects.toThrow(/not empty/);
  });
});

describe("runPg16RestorePreflight", () => {
  it("does not call runDatabaseRestore when target safety checks fail", async () => {
    const runRestore = vi.fn(async () => {});

    await expect(runPg16RestorePreflight({
      targetConnectionString: "postgres://user:pass@localhost:5432/paperclip_kitze",
      expectedTargetDatabaseName: "paperclip_kitze",
      suppliedBackupFile: makeBackupFile(),
      queryTargetIdentity: vi.fn(async () => targetIdentity({ databaseName: "paperclip_kitze" })),
      runRestore,
    })).rejects.toThrow(/protected production\/default name/);
    expect(runRestore).not.toHaveBeenCalled();
  });

  it("calls runDatabaseRestore only after the target is PG16, expected, and empty", async () => {
    const backupFile = makeBackupFile();
    const runRestore = vi.fn(async () => {});

    await expect(runPg16RestorePreflight({
      targetConnectionString: "postgres://user:pass@localhost:5432/paperclip_restore_preflight_20260717",
      expectedTargetDatabaseName: "paperclip_restore_preflight_20260717",
      suppliedBackupFile: backupFile,
      queryTargetIdentity: vi.fn(async () => targetIdentity()),
      runRestore,
    })).resolves.toMatchObject({ backupFile });
    expect(runRestore).toHaveBeenCalledWith({
      connectionString: "postgres://user:pass@localhost:5432/paperclip_restore_preflight_20260717",
      backupFile,
    });
  });
});
