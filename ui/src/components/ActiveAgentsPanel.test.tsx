// @vitest-environment jsdom

import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveRunForIssue } from "../api/heartbeats";
import { ActiveAgentsPanel } from "./ActiveAgentsPanel";

const mockHeartbeatsApi = vi.hoisted(() => ({
  liveRunsForCompany: vi.fn(),
}));

const mockIssuesApi = vi.hoisted(() => ({
  get: vi.fn(),
}));

const mockLiveRunTranscripts = vi.hoisted(() => ({
  transcriptByRun: new Map(),
  hasOutputForRun: vi.fn(() => false),
}));

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));

vi.mock("../api/heartbeats", () => ({
  heartbeatsApi: mockHeartbeatsApi,
}));

vi.mock("../api/issues", () => ({
  issuesApi: mockIssuesApi,
}));

vi.mock("./Identity", () => ({
  Identity: ({ name }: { name: string }) => <span>{name}</span>,
}));

vi.mock("./RunChatSurface", () => ({
  RunChatSurface: () => <div>Run output</div>,
}));

vi.mock("./transcript/useLiveRunTranscripts", () => ({
  useLiveRunTranscripts: () => mockLiveRunTranscripts,
}));

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
  await Promise.resolve();
}

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

async function waitForMicrotaskAssertion(assertion: () => void, attempts = 20) {
  let lastError: unknown;
  for (let index = 0; index < attempts; index += 1) {
    await flushReact();
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

function createRun(index: number, overrides: Partial<LiveRunForIssue> = {}): LiveRunForIssue {
  return {
    id: `run-${index}`,
    status: "running",
    invocationSource: "assignment",
    triggerDetail: null,
    startedAt: "2026-04-24T12:00:00.000Z",
    finishedAt: null,
    createdAt: `2026-04-24T12:00:0${index}.000Z`,
    agentId: `agent-${index}`,
    agentName: `Agent ${index}`,
    adapterType: "codex_local",
    issueId: null,
    logBytes: 256,
    lastOutputBytes: 128,
    lastUsefulActionAt: "2026-04-24T12:00:01.000Z",
    ...overrides,
  };
}

function createIssueRun(index: number, issueId: string) {
  return {
    ...createRun(index),
    issueId,
  };
}

function createIssue(id: string, identifier: string, title: string) {
  return {
    id,
    companyId: "company-1",
    identifier,
    title,
    description: null,
    status: "in_progress",
    priority: "medium",
    assigneeAgentId: null,
    assigneeUserId: null,
    parentId: null,
    projectId: null,
    projectWorkspaceId: null,
    executionWorkspaceId: null,
    goalId: null,
    labels: [],
    blockedByIssueIds: [],
    blocksIssueIds: [],
    createdAt: "2026-04-24T12:00:00.000Z",
    updatedAt: "2026-04-24T12:00:00.000Z",
  };
}

describe("ActiveAgentsPanel", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockHeartbeatsApi.liveRunsForCompany.mockResolvedValue(
      Array.from({ length: 5 }, (_, index) => createRun(index + 1)),
    );
    mockIssuesApi.get.mockRejectedValue(new Error("Issue not found"));
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
    mockLiveRunTranscripts.transcriptByRun = new Map();
    mockLiveRunTranscripts.hasOutputForRun = vi.fn(() => false);
  });

  it("links hidden active/recent runs to the full live dashboard", async () => {
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ActiveAgentsPanel companyId="company-1" />
        </QueryClientProvider>,
      );
    });
    await flushReact();

    expect(mockHeartbeatsApi.liveRunsForCompany).toHaveBeenCalledWith("company-1", {
      minCount: 4,
      limit: undefined,
    });

    const moreLink = [...container.querySelectorAll("a")].find((anchor) =>
      anchor.textContent?.includes("more dashboard"),
    );
    expect(moreLink?.getAttribute("href")).toBe("/dashboard/live");

    await act(async () => {
      root.unmount();
    });
  });

  it("can request the full live dashboard page limit without a hidden-runs link", async () => {
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ActiveAgentsPanel
            companyId="company-1"
            minRunCount={50}
            fetchLimit={50}
            cardLimit={50}
            queryScope="dashboard-live"
            showMoreLink={false}
          />
        </QueryClientProvider>,
      );
    });
    await flushReact();

    expect(mockHeartbeatsApi.liveRunsForCompany).toHaveBeenCalledWith("company-1", {
      minCount: 50,
      limit: 50,
    });
    expect(container.textContent).not.toContain("more dashboard");

    await act(async () => {
      root.unmount();
    });
  });

  it("loads exact visible run issues so task names render even when the issue list page would miss them", async () => {
    mockHeartbeatsApi.liveRunsForCompany.mockResolvedValue([
      createIssueRun(1, "65274215-0000-4000-8000-000000000000"),
    ]);
    mockIssuesApi.get.mockResolvedValue(createIssue(
      "65274215-0000-4000-8000-000000000000",
      "PAP-3562",
      "Phase 4B: Implement LLM Wiki distillation UI",
    ));

    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ActiveAgentsPanel companyId="company-1" />
        </QueryClientProvider>,
      );
    });
    await flushReact();

    await waitForMicrotaskAssertion(() => {
      expect(mockIssuesApi.get).toHaveBeenCalledWith("65274215-0000-4000-8000-000000000000");
      const issueLink = [...container.querySelectorAll("a")].find((anchor) =>
        anchor.textContent?.includes("Phase 4B"),
      );
      expect(issueLink?.textContent).toBe("PAP-3562 - Phase 4B: Implement LLM Wiki distillation UI");
      expect(issueLink?.getAttribute("href")).toBe("/issues/PAP-3562");
    });

    await act(async () => {
      root.unmount();
    });
  });

  it("labels useful labor separately from queued capacity and padded terminal history", async () => {
    mockHeartbeatsApi.liveRunsForCompany.mockResolvedValue([
      createRun(1, { status: "running", lastOutputBytes: 64, logBytes: 128 }),
      createRun(2, {
        status: "queued",
        startedAt: null,
        logBytes: 0,
        lastOutputBytes: 0,
        lastUsefulActionAt: null,
      }),
      createRun(3, {
        status: "cancelled",
        issueId: null,
        finishedAt: "2026-04-24T12:05:00.000Z",
        logBytes: 0,
        lastOutputBytes: 0,
        lastUsefulActionAt: null,
      }),
    ]);

    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ActiveAgentsPanel companyId="company-1" />
        </QueryClientProvider>,
      );
    });
    await flushReact();

    expect(container.textContent).toContain("Useful labor now");
    expect(container.textContent).toContain("Queued capacity");
    expect(container.textContent).toContain("Canceled");
    expect(container.textContent).not.toContain("Live now");

    await act(async () => {
      root.unmount();
    });
  });

  it("classifies detached, queued, no-output, stale-output, terminal, and comment-woken runs", async () => {
    mockHeartbeatsApi.liveRunsForCompany.mockResolvedValue([
      createRun(1, {
        id: "detached-useful-run",
        issueId: null,
        status: "running",
        lastOutputBytes: 64,
        logBytes: 128,
        lastUsefulActionAt: "2026-04-24T12:00:01.000Z",
      }),
      createRun(2, {
        id: "queued-run",
        status: "queued",
        startedAt: null,
        logBytes: 0,
        lastOutputBytes: 0,
        lastUsefulActionAt: null,
      }),
      createRun(3, {
        id: "no-output-run",
        status: "running",
        logBytes: 0,
        lastOutputBytes: 0,
        lastUsefulActionAt: null,
        lastAssistantSnippet: null,
      }),
      createRun(4, {
        id: "stale-output-terminal-run",
        status: "failed",
        finishedAt: "2026-04-24T12:05:00.000Z",
        logBytes: 4096,
        lastOutputBytes: 2048,
        lastUsefulActionAt: "2026-04-24T11:55:00.000Z",
      }),
      createRun(5, {
        id: "comment-woken-replacement-run",
        status: "running",
        triggerDetail: "comment",
        contextWakeCommentId: "comment-wake-1",
        logBytes: 0,
        lastOutputBytes: 0,
        lastUsefulActionAt: null,
        lastAssistantSnippet: null,
      }),
    ]);

    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ActiveAgentsPanel companyId="company-1" cardLimit={5} />
        </QueryClientProvider>,
      );
    });
    await flushReact();

    expect(container.textContent?.match(/Useful labor now/g)).toHaveLength(1);
    expect(container.textContent).toContain("Queued capacity");
    expect(container.textContent?.match(/No output yet/g)).toHaveLength(2);
    expect(container.textContent).toContain("Finished");

    await act(async () => {
      root.unmount();
    });
  });

  it("deduplicates issue lookups for duplicate visible issue runs", async () => {
    mockHeartbeatsApi.liveRunsForCompany.mockResolvedValue([
      createIssueRun(1, "65274215-0000-4000-8000-000000000000"),
      createIssueRun(2, "65274215-0000-4000-8000-000000000000"),
    ]);
    mockIssuesApi.get.mockResolvedValue(createIssue(
      "65274215-0000-4000-8000-000000000000",
      "PAP-3562",
      "Phase 4B: Implement LLM Wiki distillation UI",
    ));

    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ActiveAgentsPanel companyId="company-1" />
        </QueryClientProvider>,
      );
    });
    await flushReact();

    await waitForMicrotaskAssertion(() => {
      expect(mockIssuesApi.get).toHaveBeenCalledTimes(1);
      expect(mockIssuesApi.get).toHaveBeenCalledWith("65274215-0000-4000-8000-000000000000");
      expect(container.textContent?.match(/PAP-3562 - Phase 4B/g)).toHaveLength(2);
    });

    await act(async () => {
      root.unmount();
    });
  });

  it("does not present comment-woken zero-output replacement runs as useful live labor", async () => {
    mockHeartbeatsApi.liveRunsForCompany.mockResolvedValue([
      createRun(1, {
        status: "running",
        triggerDetail: "comment",
        contextWakeCommentId: "comment-wake-1",
        logBytes: 0,
        lastOutputBytes: 0,
        lastUsefulActionAt: null,
        lastAssistantSnippet: null,
      }),
    ]);

    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ActiveAgentsPanel companyId="company-1" />
        </QueryClientProvider>,
      );
    });
    await flushReact();

    expect(container.textContent).toContain("No output yet");
    expect(container.textContent).not.toContain("Useful labor now");

    await act(async () => {
      root.unmount();
    });
  });
});
