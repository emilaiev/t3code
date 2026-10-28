import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import type { ProjectionLimitRecoveryCandidate } from "./ProjectionStore.ts";
import type { CheapTarget } from "./quotaContinuation.ts";
import { limitRecoveryCommand, quotaContinuationCommands } from "./UsageLimitRecoveryWorker.ts";

const NOW = Date.parse("2026-10-24T12:00:00.000Z");

function candidate(
  overrides: Partial<ProjectionLimitRecoveryCandidate> = {},
): ProjectionLimitRecoveryCandidate {
  return {
    id: "thread-1" as ProjectionLimitRecoveryCandidate["id"],
    providerInstanceId: "codex" as ProjectionLimitRecoveryCandidate["providerInstanceId"],
    status: "failed",
    lastErrorClass: "usage_limit",
    latestRunId: "run-1" as ProjectionLimitRecoveryCandidate["latestRunId"],
    usageLimitResetAt: "2026-10-24T17:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    pendingRuntimeRequest: null,
    latestRunCompletedAt: DateTime.makeUnsafe("2026-10-24T11:00:00.000Z"),
    updatedAt: DateTime.makeUnsafe("2026-10-24T11:00:00.000Z"),
    limitRecovery: null,
    snoozedUntil: null,
    createdBy: "user",
    creationSource: "web",
    lineage: {
      parentThreadId: null,
      relationshipToParent: null,
      rootThreadId: "thread-1" as ProjectionLimitRecoveryCandidate["id"],
    },
    ...overrides,
  };
}

describe("limitRecoveryCommand", () => {
  it("does not resume a top-level thread an agent started through MCP", () => {
    expect(
      limitRecoveryCommand(candidate({ createdBy: "agent", creationSource: "mcp" }), true, NOW),
    ).toBeNull();
  });

  it("still resumes a subagent and a thread the user started", () => {
    expect(limitRecoveryCommand(candidate(), true, NOW)?.type).toBe("thread.metadata.update");
    expect(
      limitRecoveryCommand(
        candidate({
          createdBy: "agent",
          creationSource: "mcp",
          lineage: {
            parentThreadId: "parent" as ProjectionLimitRecoveryCandidate["id"],
            relationshipToParent: "subagent",
            rootThreadId: "parent" as ProjectionLimitRecoveryCandidate["id"],
          },
        }),
        true,
        NOW,
      )?.type,
    ).toBe("thread.metadata.update");
  });
});

const OPEN_ROWS: ReadonlyArray<CheapTarget> = [
  { instanceId: "opencode", model: "opencode-go/deepseek-v4.1-flash", open: true },
  { instanceId: "cursor", model: "default", open: true },
  { instanceId: "codex", model: "gpt-6-luna", open: true },
  { instanceId: "claudeAgent", model: "claude-haiku-5-5", open: true },
];

describe("quotaContinuationCommands", () => {
  it("continues on OpenCode Go flash without the same-model resume flag", () => {
    const commands = quotaContinuationCommands({
      thread: candidate(),
      targets: OPEN_ROWS,
      observation: {
        latestRunId: "run-1",
        latestInstanceId: "codex",
        latestRunStarted: true,
        sessionOpenFailure: false,
        latestErrorClass: "usage_limit",
      },
      nowMs: NOW,
    });
    expect(commands?.message).toMatchObject({
      type: "message.dispatch",
      modelSelection: { instanceId: "opencode", model: "opencode-go/deepseek-v4.1-flash" },
      text: "Continue where you left off.",
    });
    expect(commands?.message).not.toHaveProperty("usageLimitContinuationOfRunId");
    expect(commands?.message?.type).toBe("message.dispatch");
    if (commands?.message?.type === "message.dispatch") {
      expect(commands.message.modelSelection).not.toHaveProperty("options");
    }
    expect(commands?.metadata).toMatchObject({
      type: "thread.metadata.update",
      limitRecovery: {
        runId: "run-1",
        autoResume: false,
        quotaSwitch: { pendingInstanceId: "opencode", opened: false },
      },
    });
  });

  it("leaves a top-level MCP thread for the cheap walk and still refuses same-model resume", () => {
    const thread = candidate({ createdBy: "agent", creationSource: "mcp" });
    expect(limitRecoveryCommand(thread, true, NOW)).toBeNull();
    expect(
      quotaContinuationCommands({
        thread,
        targets: OPEN_ROWS,
        observation: {
          latestRunId: "run-1",
          latestInstanceId: "codex",
          latestRunStarted: true,
          sessionOpenFailure: false,
          latestErrorClass: "usage_limit",
        },
        nowMs: NOW,
      })?.message,
    ).toMatchObject({
      modelSelection: { model: "opencode-go/deepseek-v4.1-flash" },
    });
  });

  it("does not build a continuation when the other cheap rows are closed", () => {
    expect(
      quotaContinuationCommands({
        thread: candidate(),
        targets: OPEN_ROWS.map((row) =>
          row.instanceId === "codex" ? row : { ...row, open: false },
        ),
        observation: {
          latestRunId: "run-1",
          latestInstanceId: "codex",
          latestRunStarted: true,
          sessionOpenFailure: false,
          latestErrorClass: "usage_limit",
        },
        nowMs: NOW,
      }),
    ).toBeNull();
  });

  it("sends high reasoning only on Luna and Haiku", () => {
    const observation = {
      latestRunId: "run-1",
      latestInstanceId: "codex",
      latestRunStarted: true,
      sessionOpenFailure: false,
      latestErrorClass: "usage_limit",
    };
    const rows = OPEN_ROWS.map((row, index) => ({
      ...row,
      effort:
        index === 2
          ? { id: "reasoningEffort", value: "high" as const }
          : index === 3
            ? { id: "effort", value: "high" as const }
            : null,
    }));
    expect(
      quotaContinuationCommands({
        thread: candidate({ providerInstanceId: "opencode" as ProjectionLimitRecoveryCandidate["providerInstanceId"] }),
        targets: rows.map((row) =>
          row.instanceId === "opencode" || row.instanceId === "cursor" ? { ...row, open: false } : row,
        ),
        observation: { ...observation, latestInstanceId: "opencode" },
        nowMs: NOW,
      })?.message,
    ).toMatchObject({
      modelSelection: {
        model: "gpt-6-luna",
        options: [{ id: "reasoningEffort", value: "high" }],
      },
    });
    expect(
      quotaContinuationCommands({
        thread: candidate(),
        targets: rows.map((row) => (row.instanceId === "claudeAgent" ? row : { ...row, open: false })),
        observation,
        nowMs: NOW,
      })?.message,
    ).toMatchObject({
      modelSelection: {
        model: "claude-haiku-5-5",
        options: [{ id: "effort", value: "high" }],
      },
    });
  });
});
