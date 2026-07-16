import { afterEach, describe, expect, it } from "vitest";

import {
  createOpenCodeInstructionBundlePreflightFailure,
  ensureRemoteOpenCodeModelConfiguredAndAvailable,
} from "./execute.js";

describe("ensureRemoteOpenCodeModelConfiguredAndAvailable", () => {
  afterEach(() => {
    delete process.env.OPENCODE_ALLOW_ALL_MODELS;
  });

  // The remote/sandbox execution path must honour OPENCODE_ALLOW_ALL_MODELS just
  // like the local path: gateway-routed models (e.g. anthropic/<gateway>/<model>
  // via Bifrost) never appear in `opencode models`, so the availability probe
  // must be skipped. The early return happens before the executionTarget is ever
  // touched, so a bogus target proves the probe was not run.
  const bogusTarget = {} as never;

  it("skips the remote availability probe when OPENCODE_ALLOW_ALL_MODELS is set in the run env", async () => {
    await expect(
      ensureRemoteOpenCodeModelConfiguredAndAvailable({
        runId: "run-1",
        executionTarget: bogusTarget,
        command: "opencode",
        model: "anthropic/tensorix/deepseek/deepseek-chat-v3.1",
        cwd: "/tmp",
        env: { OPENCODE_ALLOW_ALL_MODELS: "true" },
        timeoutSec: 30,
        graceSec: 5,
      }),
    ).resolves.toBeUndefined();
  });

  it("honours OPENCODE_ALLOW_ALL_MODELS from the process env", async () => {
    process.env.OPENCODE_ALLOW_ALL_MODELS = "1";
    await expect(
      ensureRemoteOpenCodeModelConfiguredAndAvailable({
        runId: "run-2",
        executionTarget: bogusTarget,
        command: "opencode",
        model: "anthropic/tensorix/deepseek/deepseek-chat-v3.1",
        cwd: "/tmp",
        env: {},
        timeoutSec: 30,
        graceSec: 5,
      }),
    ).resolves.toBeUndefined();
  });

  it("still enforces provider/model format even when the bypass flag is set", async () => {
    await expect(
      ensureRemoteOpenCodeModelConfiguredAndAvailable({
        runId: "run-3",
        executionTarget: bogusTarget,
        command: "opencode",
        model: "",
        cwd: "/tmp",
        env: { OPENCODE_ALLOW_ALL_MODELS: "true" },
        timeoutSec: 30,
        graceSec: 5,
      }),
    ).rejects.toThrow();
  });
});

describe("createOpenCodeInstructionBundlePreflightFailure", () => {
  it("returns a deterministic non-transient failure without requesting retry/session recovery", () => {
    const result = createOpenCodeInstructionBundlePreflightFailure({
      instructionsFilePath: "/workspace/.paperclip-runtime/AGENTS.md",
      reason: new Error("ENOENT: no such file or directory, open '/workspace/.paperclip-runtime/AGENTS.md'"),
    });

    expect(result).toMatchObject({
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorCode: "opencode_instruction_bundle_unreadable",
      errorFamily: null,
      clearSession: false,
    });
    expect(result.errorMessage).toContain("instruction-bundle preflight failed");
    expect(result.resultJson).toMatchObject({
      preflight: "instruction_bundle",
      instructionsFilePath: "/workspace/.paperclip-runtime/AGENTS.md",
    });
  });

  it("bounds noisy OS failure details before storing result metadata", () => {
    const result = createOpenCodeInstructionBundlePreflightFailure({
      instructionsFilePath: "/workspace/AGENTS.md",
      reason: `bad ${"x".repeat(1000)}`,
    });

    expect(String(result.resultJson?.reason).length).toBeLessThanOrEqual(500);
  });
});
