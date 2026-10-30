import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  OrchestratorMcpDelegateTaskInput,
  OrchestratorMcpDelegateTaskResult,
  OrchestratorMcpT3xLaunchInput,
  OrchestratorMcpT3xLaunchResult,
} from "./orchestratorMcp.ts";

const decodeDelegateTaskInput = Schema.decodeUnknownSync(OrchestratorMcpDelegateTaskInput);
const decodeDelegateTaskResult = Schema.decodeUnknownSync(OrchestratorMcpDelegateTaskResult);
const decodeT3xLaunchInput = Schema.decodeUnknownSync(OrchestratorMcpT3xLaunchInput);
const decodeT3xLaunchResult = Schema.decodeUnknownSync(OrchestratorMcpT3xLaunchResult);

describe("orchestrator MCP contracts", () => {
  it("decodes cross-provider delegated task requests and durable results", () => {
    const request = decodeDelegateTaskInput({
      task: "Inspect the workspace and report the result.",
      target: {
        providerInstanceId: "claudeAgent",
        model: "claude-sonnet-4-6",
      },
      mode: "wait",
      timeoutMs: 5_000,
      clientRequestId: "delegate-1",
      runtimeMode: "inherit",
      interactionMode: "inherit",
    });
    const result = decodeDelegateTaskResult({
      taskId: "node-task-1",
      childThreadId: "thread-child-1",
      childRunId: "run-child-1",
      childNodeId: "node-task-1",
      status: "completed",
      workState: "result_available",
      hasPendingChildRuns: false,
      providerInstanceId: "claudeAgent",
      model: "claude-sonnet-4-6",
      summary: "Workspace inspected.",
      resultContextTransferId: "context-transfer-result-1",
      latestTerminalRunId: "run-child-1",
      latestTerminalStatus: "completed",
      latestTerminalSummary: "Workspace inspected.",
      latestTerminalResultContextTransferId: "context-transfer-result-1",
      hasPendingQuestion: false,
      pendingApproval: null,
      waitTimedOut: false,
    });

    expect(request.target?.providerInstanceId).toBe("claudeAgent");
    expect(result.status).toBe("completed");
    expect(result.summary).toBe("Workspace inspected.");
    expect(result.pendingApproval).toBeNull();
    const pendingApproval = {
      requestId: "request-approval-1",
      kind: "command",
      runId: "run-child-1",
    };
    expect(
      decodeDelegateTaskResult({
        ...result,
        pendingApproval: { ...pendingApproval, input: { command: "private command" } },
      }).pendingApproval,
    ).toEqual(pendingApproval);
    expect(() =>
      decodeDelegateTaskResult({
        ...result,
        pendingApproval: { ...pendingApproval, kind: "user_input" },
      }),
    ).toThrow();
  });

  it("keeps T3X launch input free of server-derived parent identity", () => {
    const launch = decodeT3xLaunchInput({
      host: "win",
      cli: "codex",
      task: "Run the task.",
      model: "gpt-6-luna",
      clientRequestId: "t3x-logical-request-1",
      parent: { environmentId: "forged-env", threadId: "forged-thread", runId: "forged-run" },
      environmentId: "forged-env",
      threadId: "forged-thread",
      runId: "forged-run",
    });
    expect(launch).not.toHaveProperty("parent");
    expect(launch).not.toHaveProperty("environmentId");
    expect(launch).not.toHaveProperty("threadId");
    expect(launch).not.toHaveProperty("runId");
    expect(() =>
      decodeT3xLaunchInput({ host: "win", cli: "codex", task: "Run it", model: "m" }),
    ).toThrow();
    expect(() => decodeT3xLaunchInput({ ...launch, host: "invalid-host" })).toThrow();
  });

  it("decodes unbound T3X receipts and requires exact IDs when a target is bound", () => {
    const uncertain = decodeT3xLaunchResult({
      jobId: "job:uncertain",
      target: null,
      state: "uncertain",
      error: "launch binding is not yet visible",
    });
    expect(uncertain).toEqual({
      jobId: "job:uncertain",
      target: null,
      state: "uncertain",
      error: "launch binding is not yet visible",
    });

    const bound = decodeT3xLaunchResult({
      jobId: "job:bound",
      target: { host: "win", threadId: "thread:target", runId: "run:target" },
    });
    expect(bound.target).toEqual({ host: "win", threadId: "thread:target", runId: "run:target" });
    for (const host of ["wsl", "win", "mac"] as const) {
      expect(
        decodeT3xLaunchResult({
          jobId: `job:${host}`,
          target: { host, threadId: "thread:target", runId: "run:target" },
        }).target,
      ).toEqual({ host, threadId: "thread:target", runId: "run:target" });
    }
    expect(() =>
      decodeT3xLaunchResult({
        jobId: "job:bound",
        target: { host: "other", threadId: "thread:target", runId: "run:target" },
      }),
    ).toThrow();
    expect(() =>
      decodeT3xLaunchResult({
        jobId: "job:bound",
        target: { host: "win", threadId: "thread:target" },
      }),
    ).toThrow();
  });
});
