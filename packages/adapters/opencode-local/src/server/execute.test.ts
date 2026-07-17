import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  createOpenCodeInstructionBundlePreflightFailure,
  ensureRemoteOpenCodeModelConfiguredAndAvailable,
  execute,
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

describe("execute", () => {
  async function writeOpenCodeStub(root: string, body: string[] = []) {
    const commandPath = path.join(root, "opencode");
    await fs.writeFile(
      commandPath,
      [
        "#!/bin/sh",
        "if [ \"$1\" = \"models\" ]; then",
        "  echo 'openai/gpt-5.1-codex-mini'",
        "  exit 0",
        "fi",
        ...body,
        "exit 0",
        "",
      ].join("\n"),
      "utf8",
    );
    await fs.chmod(commandPath, 0o755);
    return commandPath;
  }

  function buildExecuteInput(input: {
    runId: string;
    command: string;
    cwd: string;
    instructionsFilePath?: string;
    onMeta?: Parameters<typeof execute>[0]["onMeta"];
  }): Parameters<typeof execute>[0] {
    return {
      runId: input.runId,
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "OpenCode Coder",
        adapterType: "opencode_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        command: input.command,
        cwd: input.cwd,
        model: "openai/gpt-5.1-codex-mini",
        promptTemplate: "Follow the paperclip heartbeat.",
        ...(input.instructionsFilePath ? { instructionsFilePath: input.instructionsFilePath } : {}),
      },
      context: {},
      authToken: "run-jwt-token",
      onLog: async () => {},
      ...(input.onMeta ? { onMeta: input.onMeta } : {}),
    };
  }

  it("loads configured instructions from the workspace real path", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-instructions-valid-"));
    const workspace = path.join(root, "workspace");
    const instructionsPath = path.join(workspace, "AGENTS.md");
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(instructionsPath, "Stay inside the workspace.\n", "utf8");
    const commandPath = await writeOpenCodeStub(root);
    const metaPrompts: string[] = [];

    try {
      const result = await execute(buildExecuteInput({
        runId: "run-opencode-valid-instructions",
        command: commandPath,
        cwd: workspace,
        instructionsFilePath: "AGENTS.md",
        onMeta: async (meta) => {
          if (typeof meta.prompt === "string") metaPrompts.push(meta.prompt);
        },
      }));

      const realInstructionsPath = await fs.realpath(instructionsPath);
      expect(result.exitCode).toBe(0);
      expect(metaPrompts[0]).toContain("Stay inside the workspace.");
      expect(metaPrompts[0]).toContain(`loaded from ${realInstructionsPath}`);
      expect(metaPrompts[0]).toContain(`Resolve any relative file references from ${path.dirname(realInstructionsPath)}/`);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed when configured instructions cannot be read", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-instructions-"));
    const workspace = path.join(root, "workspace");
    await fs.mkdir(workspace, { recursive: true });
    const commandPath = await writeOpenCodeStub(root, ["echo should-not-run"]);

    try {
      const result = await execute(buildExecuteInput({
        runId: "run-opencode-missing-instructions",
          command: commandPath,
          cwd: workspace,
        instructionsFilePath: "missing/AGENTS.md",
      }));

      expect(result.exitCode).toBe(1);
      expect(result.errorCode).toBe("opencode_instruction_bundle_unreadable");
      expect(result.errorMessage).toContain("instruction-bundle preflight failed");
      expect(result.errorMessage).toContain(path.join(workspace, "missing", "AGENTS.md"));
      expect(result.resultJson).toMatchObject({
        preflight: "instruction_bundle",
        instructionsFilePath: path.join(workspace, "missing", "AGENTS.md"),
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects configured instruction traversal outside the workspace real path", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-instructions-traversal-"));
    const workspace = path.join(root, "workspace");
    const outsideInstructions = path.join(root, "AGENTS.md");
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(outsideInstructions, "external instructions\n", "utf8");
    const commandPath = await writeOpenCodeStub(root);

    try {
      const result = await execute(buildExecuteInput({
        runId: "run-opencode-traversal-instructions",
        command: commandPath,
        cwd: workspace,
        instructionsFilePath: "../AGENTS.md",
      }));

      expect(result.exitCode).toBe(1);
      expect(result.errorCode).toBe("opencode_instruction_bundle_unreadable");
      expect(result.errorMessage).toContain("escapes workspace root");
      expect(result.resultJson).toMatchObject({
        preflight: "instruction_bundle",
        instructionsFilePath: outsideInstructions,
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects absolute instruction paths outside the workspace real path", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-instructions-absolute-"));
    const workspace = path.join(root, "workspace");
    const outside = path.join(root, "outside");
    const outsideInstructions = path.join(outside, "AGENTS.md");
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(outside, { recursive: true });
    await fs.writeFile(outsideInstructions, "external instructions\n", "utf8");
    const commandPath = await writeOpenCodeStub(root);

    try {
      const result = await execute(buildExecuteInput({
        runId: "run-opencode-absolute-external-instructions",
        command: commandPath,
        cwd: workspace,
        instructionsFilePath: outsideInstructions,
      }));

      expect(result.exitCode).toBe(1);
      expect(result.errorCode).toBe("opencode_instruction_bundle_unreadable");
      expect(result.errorMessage).toContain("escapes workspace root");
      expect(result.resultJson).toMatchObject({
        preflight: "instruction_bundle",
        instructionsFilePath: outsideInstructions,
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects instruction symlinks that resolve outside the workspace real path", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-instructions-symlink-"));
    const workspace = path.join(root, "workspace");
    const outsideInstructions = path.join(root, "outside.md");
    const symlinkInstructions = path.join(workspace, "AGENTS.md");
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(outsideInstructions, "external instructions\n", "utf8");
    await fs.symlink(outsideInstructions, symlinkInstructions);
    const commandPath = await writeOpenCodeStub(root);

    try {
      const result = await execute(buildExecuteInput({
        runId: "run-opencode-symlink-escape-instructions",
        command: commandPath,
        cwd: workspace,
        instructionsFilePath: "AGENTS.md",
      }));

      expect(result.exitCode).toBe(1);
      expect(result.errorCode).toBe("opencode_instruction_bundle_unreadable");
      expect(result.errorMessage).toContain("escapes workspace root");
      expect(result.resultJson).toMatchObject({
        preflight: "instruction_bundle",
        instructionsFilePath: symlinkInstructions,
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects directory instruction targets", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-instructions-directory-"));
    const workspace = path.join(root, "workspace");
    await fs.mkdir(path.join(workspace, "AGENTS.md"), { recursive: true });
    const commandPath = await writeOpenCodeStub(root);

    try {
      const result = await execute(buildExecuteInput({
        runId: "run-opencode-directory-instructions",
        command: commandPath,
        cwd: workspace,
        instructionsFilePath: "AGENTS.md",
      }));

      expect(result.exitCode).toBe(1);
      expect(result.errorCode).toBe("opencode_instruction_bundle_unreadable");
      expect(result.errorMessage).toContain("not a file");
      expect(result.resultJson).toMatchObject({
        preflight: "instruction_bundle",
        instructionsFilePath: path.join(workspace, "AGENTS.md"),
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("builds terminal instruction preflight failures", () => {
    const result = createOpenCodeInstructionBundlePreflightFailure({
      instructionsFilePath: "/workspace/AGENTS.md",
      reason: "ENOENT",
    });

    expect(result).toMatchObject({
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorCode: "opencode_instruction_bundle_unreadable",
      resultJson: {
        preflight: "instruction_bundle",
        instructionsFilePath: "/workspace/AGENTS.md",
        reason: "ENOENT",
      },
    });
  });

  it("surfaces OpenCode provider rate limits as transient upstream failures", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-rate-limit-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "opencode");
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(
      commandPath,
      [
        "#!/bin/sh",
        "if [ \"$1\" = \"models\" ]; then",
        "  echo 'openai/gpt-5.1-codex-mini'",
        "  exit 0",
        "fi",
        "echo '{\"type\":\"error\",\"message\":\"Provider returned 429 Too Many Requests: rate limit exceeded\"}'",
        "exit 1",
        "",
      ].join("\n"),
      "utf8",
    );
    await fs.chmod(commandPath, 0o755);

    try {
      const result = await execute({
        runId: "run-opencode-rate-limit",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "OpenCode Coder",
          adapterType: "opencode_local",
          adapterConfig: {},
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          command: commandPath,
          cwd: workspace,
          model: "openai/gpt-5.1-codex-mini",
          promptTemplate: "Follow the paperclip heartbeat.",
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(1);
      expect(result.errorCode).toBe("opencode_transient_upstream");
      expect(result.errorFamily).toBe("transient_upstream");
      expect(result.errorMessage).toContain("rate limit exceeded");
      expect(result.resultJson?.errorFamily).toBe("transient_upstream");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
