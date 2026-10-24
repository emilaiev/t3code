import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import type { ProjectionLimitRecoveryCandidate } from "./ProjectionStore.ts";
import { limitRecoveryCommand } from "./UsageLimitRecoveryWorker.ts";

const NOW = Date.parse("2026-10-24T12:00:00.000Z");

function candidate(
  overrides: Partial<ProjectionLimitRecoveryCandidate> = {},
): ProjectionLimitRecoveryCandidate {
  return {
    id: "thread-1" as ProjectionLimitRecoveryCandidate["id"],
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
