import { describe, expect, it } from "vitest";
import { isOpenCodeTransientUpstreamError, parseOpenCodeJsonl, isOpenCodeUnknownSessionError } from "./parse.js";

describe("parseOpenCodeJsonl", () => {
  it("parses assistant text, usage, cost, and errors", () => {
    const stdout = [
      JSON.stringify({
        type: "text",
        sessionID: "session_123",
        part: { text: "Hello from OpenCode" },
      }),
      JSON.stringify({
        type: "step_finish",
        sessionID: "session_123",
        part: {
          reason: "done",
          cost: 0.0025,
          tokens: {
            input: 120,
            output: 40,
            reasoning: 10,
            cache: { read: 20, write: 0 },
          },
        },
      }),
      JSON.stringify({
        type: "error",
        sessionID: "session_123",
        error: { message: "model unavailable" },
      }),
    ].join("\n");

    const parsed = parseOpenCodeJsonl(stdout);
    expect(parsed.sessionId).toBe("session_123");
    expect(parsed.summary).toBe("Hello from OpenCode");
    expect(parsed.usage).toEqual({
      inputTokens: 120,
      cachedInputTokens: 20,
      outputTokens: 50,
    });
    expect(parsed.costUsd).toBeCloseTo(0.0025, 6);
    expect(parsed.errorMessage).toContain("model unavailable");
    expect(parsed.toolErrors).toEqual([]);
  });

  it("keeps failed tool calls separate from fatal run errors", () => {
    const stdout = [
      JSON.stringify({
        type: "tool_use",
        sessionID: "session_123",
        part: {
          state: {
            status: "error",
            error: "File not found: e2b-adapter-result.txt",
          },
        },
      }),
      JSON.stringify({
        type: "text",
        sessionID: "session_123",
        part: { text: "Recovered and completed the task" },
      }),
    ].join("\n");

    const parsed = parseOpenCodeJsonl(stdout);
    expect(parsed.sessionId).toBe("session_123");
    expect(parsed.summary).toBe("Recovered and completed the task");
    expect(parsed.errorMessage).toBeNull();
    expect(parsed.toolErrors).toEqual(["File not found: e2b-adapter-result.txt"]);
  });

  it("detects unknown session errors", () => {
    expect(isOpenCodeUnknownSessionError("Session not found: s_123", "")).toBe(true);
    expect(isOpenCodeUnknownSessionError("", "unknown session id")).toBe(true);
    expect(isOpenCodeUnknownSessionError("all good", "")).toBe(false);
  });

  it("classifies OpenCode provider rate limits as transient upstream failures", () => {
    expect(
      isOpenCodeTransientUpstreamError({
        stderr: "exceeded retry limit, last status: 429 Too Many Requests",
      }),
    ).toBe(true);
    expect(
      isOpenCodeTransientUpstreamError({
        errorMessage: "Provider returned rate_limit_exceeded. Try again later.",
      }),
    ).toBe(true);
    expect(
      isOpenCodeTransientUpstreamError({
        stdout: JSON.stringify({ type: "error", error: { message: "server overloaded" } }),
      }),
    ).toBe(true);
  });

  it("does not route rate limits through the stale-session retry path", () => {
    const stderr = "exceeded retry limit, last status: 429 Too Many Requests";
    expect(isOpenCodeTransientUpstreamError({ stderr })).toBe(true);
    expect(isOpenCodeUnknownSessionError("", stderr)).toBe(false);
  });

  it("does not classify deterministic preflight or config failures as transient", () => {
    expect(
      isOpenCodeTransientUpstreamError({
        errorMessage: "OpenCode instruction-bundle preflight failed: ENOENT: no such file or directory",
      }),
    ).toBe(false);
    expect(
      isOpenCodeTransientUpstreamError({
        errorMessage: "OpenCode requires `adapterConfig.model` in provider/model format.",
      }),
    ).toBe(false);
  });
});
