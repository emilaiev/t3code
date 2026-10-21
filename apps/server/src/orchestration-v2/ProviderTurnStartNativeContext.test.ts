import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect } from "vite-plus/test";
import { it as effectIt } from "@effect/vitest";
import {
  CheckpointScopeId,
  ContextHandoffId,
  MessageId,
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ContextHandoff,
  OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderAuthService from "../provider/ProviderAuthService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ContextHandoffService from "./ContextHandoffService.ts";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ProviderTurnStart from "./ProviderTurnStartService.ts";
import * as RunExecutionService from "./RunExecutionService.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";

const isDomainEvent = Schema.is(OrchestrationV2DomainEvent);

const now = DateTime.makeUnsafe("2026-10-22T00:00:00Z");
const threadId = ThreadId.make("thread:native-context");
const runId = RunId.make("run:native-context");
const rootNodeId = NodeId.make("node:native-context");
const attemptId = RunAttemptId.make("attempt:native-context");
const providerThreadId = ProviderThreadId.make("provider-thread:native-context");
const providerSessionId = ProviderSessionId.make("provider-session:native-context");
const messageId = MessageId.make("message:native-context");
const checkpointScopeId = CheckpointScopeId.make("scope:native-context");
const driver = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex");
const nativeId = "native:native-context";

const historyText = "Earlier partial work that the next turn must recover.";

const handoff: OrchestrationV2ContextHandoff = {
  id: ContextHandoffId.make("handoff:native-context"),
  threadId,
  targetRunId: runId,
  fromProviderThreadIds: [],
  toProviderThreadId: providerThreadId,
  coveredRunOrdinals: { from: 1, to: 1 },
  strategy: "full_thread_summary",
  status: "ready",
  summaryMessageId: null,
  summaryText: "",
  history: {
    messages: [
      {
        itemId: TurnItemId.make("item:native-context:user"),
        role: "user",
        text: historyText,
        threadId,
        runId: null,
        providerThreadId: null,
        status: "completed",
        kind: "user_message",
      },
      {
        itemId: TurnItemId.make("item:native-context:assistant"),
        role: "assistant",
        text: "And the answer that followed.",
        threadId,
        runId: null,
        providerThreadId: null,
        status: "completed",
        kind: "assistant_message",
      },
    ],
    coverage: "Historical context; retrieve thread:native-context with t3_thread_read.",
    omittedItems: 0,
  },
  createdByProviderInstanceId: null,
  createdAt: now,
  updatedAt: now,
};

function makeHarness(input: {
  readonly contextUsage: {
    usedTokens: number;
    maxTokens?: number;
    autoCompactThreshold?: number;
  } | null;
  /** `null` omits the adapter method entirely; undefined resolves to no estimate. */
  readonly estimate?: number | null | "hang" | undefined;
  readonly replacedNativeThread?: boolean | undefined;
  readonly invocation?: "start" | "compact" | undefined;
  readonly handoff?: OrchestrationV2ContextHandoff | null | undefined;
  /** OpenCode has no `injectHistory`; Claude does. Inline is the OpenCode path. */
  readonly injectHistory?: boolean | undefined;
  readonly userText?: string | undefined;
}) {
  const userText = input.userText ?? "Continue the work";
  const run: OrchestrationV2ThreadProjection["runs"][number] = {
    id: runId,
    threadId,
    ordinal: 2,
    providerInstanceId: instanceId,
    modelSelection: { instanceId, model: "gpt-5.4" },
    providerThreadId,
    userMessageId: messageId,
    rootNodeId,
    activeAttemptId: attemptId,
    status: "starting",
    requestedAt: now,
    startedAt: null,
    completedAt: null,
    checkpointId: null,
    contextHandoffId: null,
  };
  const providerThread: OrchestrationV2ThreadProjection["providerThreads"][number] = {
    id: providerThreadId,
    driver,
    providerInstanceId: instanceId,
    providerSessionId,
    appThreadId: threadId,
    ownerNodeId: null,
    nativeThreadRef: { driver, nativeId, strength: "strong" },
    nativeConversationHeadRef: null,
    status: "idle",
    firstRunOrdinal: 2,
    lastRunOrdinal: 2,
    handoffIds: [],
    contextUsage: input.contextUsage,
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
  };
  const message: OrchestrationV2ThreadProjection["messages"][number] = {
    id: messageId,
    threadId,
    runId,
    nodeId: rootNodeId,
    role: "user",
    text: userText,
    attachments: [],
    streaming: false,
    createdBy: "user",
    creationSource: "web",
    createdAt: now,
    updatedAt: now,
  };
  let projection: OrchestrationV2ThreadProjection = {
    thread: {
      id: threadId,
      activeProviderThreadId: providerThreadId,
      projectId: "project:native-context",
      branch: null,
      worktreePath: null,
    } as OrchestrationV2ThreadProjection["thread"],
    runs: [run],
    attempts: [
      {
        id: attemptId,
        runId,
        rootNodeId,
        attemptOrdinal: 1,
        providerInstanceId: instanceId,
        providerThreadId,
        providerTurnId: null,
        reason: "initial",
        status: "pending",
        startedAt: null,
        completedAt: null,
      },
    ],
    nodes: [
      {
        id: rootNodeId,
        threadId,
        runId,
        parentNodeId: null,
        rootNodeId,
        kind: "root_turn",
        status: "pending",
        countsForRun: true,
        providerThreadId,
        providerTurnId: null,
        nativeItemRef: null,
        runtimeRequestId: null,
        checkpointScopeId,
        startedAt: null,
        completedAt: null,
      },
    ],
    providerThreads: [providerThread],
    messages: [message],
    checkpointScopes: [
      {
        id: checkpointScopeId,
        threadId,
        runId,
        nodeId: rootNodeId,
        parentScopeId: null,
        providerThreadId,
        kind: "root_run",
        ordinalWithinParent: 0,
        advancesAppRunCount: true,
        cwd: "/tmp/native-context",
        createdAt: now,
      },
    ],
    providerSessions: [],
    providerTurns: [],
    contextHandoffs: input.handoff === null ? [] : [input.handoff ?? handoff],
    contextTransfers: [],
    turnItems: [],
    visibleTurnItems: [],
    runtimeRequests: [],
    subagents: [],
    plans: [],
    checkpoints: [],
    updatedAt: now,
  };
  const events: Array<OrchestrationV2DomainEvent> = [];
  const estimateCalls: Array<{ readonly maxBytes: number }> = [];
  const startedTurns: Array<{
    readonly text: string;
    readonly runId: RunId;
    readonly threadId: ThreadId;
    readonly providerThreadId: ProviderThreadId;
    readonly attemptId: RunAttemptId;
  }> = [];
  const compactions: Array<string> = [];
  const injected: Array<{ readonly context: string; readonly text: string }> = [];

  const resumedThread = input.replacedNativeThread
    ? {
        ...providerThread,
        nativeThreadRef: { driver, nativeId: "native:replacement", strength: "strong" as const },
        contextUsage: null,
      }
    : providerThread;

  const session = {
    driver,
    providerSession: {
      id: providerSessionId,
      driver,
      providerInstanceId: instanceId,
      status: "ready",
      cwd: "/tmp/native-context",
      model: null,
      capabilities: CodexProviderCapabilitiesV2,
      createdAt: now,
      updatedAt: now,
      lastError: null,
    },
    resumeThread: () => Effect.succeed(resumedThread),
    ensureThread: () => Effect.succeed(resumedThread),
    ...(input.injectHistory === true
      ? {
          injectHistory: (history: ProviderAdapter.ProviderAdapterV2HistoricalContext) =>
            Effect.sync(() => {
              injected.push({
                context: history.context,
                text: history.messages.map((message) => message.text).join("\n"),
              });
              return true;
            }),
        }
      : {}),
    startTurn: (turn: ProviderAdapter.ProviderAdapterV2TurnInput) =>
      Effect.sync(() => {
        startedTurns.push({
          text: turn.message.text,
          runId: turn.runId,
          threadId: turn.threadId,
          providerThreadId: turn.providerThread.id,
          attemptId: turn.attemptId,
        });
      }),
    compactThread: (turn: ProviderAdapter.ProviderAdapterV2TurnInput) =>
      Effect.sync(() => {
        compactions.push(turn.message.text);
      }),
    ...(input.estimate === null
      ? {}
      : {
          estimateNativeContext: (estimateInput: { readonly maxBytes: number }) => {
            estimateCalls.push({ maxBytes: estimateInput.maxBytes });
            return input.estimate === "hang"
              ? Effect.never
              : Effect.succeed(input.estimate as number | undefined);
          },
        }),
  };

  const writeIfRunCurrent = ({
    events: incoming,
    activeAttemptId,
    expectedStatus,
  }: {
    events: ReadonlyArray<OrchestrationV2DomainEvent>;
    activeAttemptId: RunAttemptId;
    expectedStatus: OrchestrationV2ThreadProjection["runs"][number]["status"];
  }) =>
    Effect.sync(() => {
      const current = projection.runs.find((candidate) => candidate.id === runId);
      const committed =
        current !== undefined &&
        current.activeAttemptId === activeAttemptId &&
        current.status === expectedStatus;
      if (committed) {
        for (const event of incoming) {
          expect(isDomainEvent(event)).toBe(true);
          events.push(event);
          projection = ProjectionStore.applyToProjection(projection, event);
        }
      }
      return { committed, storedEvents: [] };
    });

  const startFailures: Array<unknown> = [];
  const startRootRun = ({
    session: deliverySession,
  }: RunExecutionService.RunExecutionServiceV2StartRootRunInput) =>
    Effect.gen(function* () {
      const turn = {
        appThread: projection.thread,
        threadId,
        runId,
        runOrdinal: 2,
        providerTurnOrdinal: 1,
        attemptId,
        rootNodeId,
        providerThread: resumedThread,
        message: {
          messageId,
          text: message.text,
          attachments: [],
          createdBy: "user",
          creationSource: "web",
        },
        modelSelection: run.modelSelection,
        runtimePolicy: { runtimeMode: "full-access", interactionMode: "default", cwd: "/tmp" },
      } as ProviderAdapter.ProviderAdapterV2TurnInput;
      // The real RunExecutionService turns a refused start into a failed run;
      // here the refusal itself is what the assertions need.
      const attempted =
        input.invocation === "compact"
          ? yield* deliverySession.compactThread!(turn).pipe(Effect.result)
          : yield* deliverySession.startTurn(turn).pipe(Effect.result);
      if (attempted._tag === "Failure") startFailures.push(attempted.failure);
    });

  const project = () => ({
    ...projection,
    hasConversation: true,
  });

  const layer = ProviderTurnStart.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ContextHandoffService.ContextHandoffServiceV2)({
          prepareProviderHandoff: () => Effect.die("no missed runs in this scenario"),
        }),
        Layer.mock(EventSink.EventSinkV2)({
          writeIfRunCurrent,
          write: ((writeInput: { readonly events: ReadonlyArray<OrchestrationV2DomainEvent> }) =>
            Effect.sync(() => {
              for (const event of writeInput.events) {
                events.push(event);
                projection = ProjectionStore.applyToProjection(projection, event);
              }
            })) as never,
        }),
        IdAllocator.layer,
        NodeServices.layer,
        Layer.mock(ServerConfig.ServerConfig)({ worktreesDir: "/tmp" } as never),
        ServerSettings.layerTest(),
        FileSystem.layerNoop({ exists: () => Effect.succeed(true) }),
        Layer.mock(GitWorkflow.GitWorkflowService)({
          pruneWorktrees: () => Effect.void,
          createWorktree: () => Effect.succeed({} as never),
        }),
        Layer.mock(ProjectService.ProjectService)({
          getById: () => Effect.succeed(Option.none()),
        }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadRecords: () => Effect.succeed(projection),
          getTurnStartContext: () => Effect.succeed(project()),
          getRuntimeRecoveryProjection: () => Effect.succeed(project()),
          getTurnStartHistory: () => Effect.succeed([]),
        }),
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
          open: () => Effect.succeed(session as never),
        }),
        Layer.mock(ProviderAuthService.ProviderAuthService)({
          tryHandlePromptCommand: () => Effect.succeed(false),
        }),
        Layer.mock(RunExecutionService.RunExecutionServiceV2)({ startRootRun }),
        Layer.mock(RuntimePolicy.RuntimePolicyV2)({
          resolve: () => Effect.succeed({ cwd: "/tmp/native-context" } as never),
        }),
      ),
    ),
  );

  return {
    estimateCalls,
    startFailures,
    startedTurns,
    compactions,
    injected,
    events,
    projection: () => projection,
    /** The handoff delivery statuses the delivery persisted, in order. */
    deliveryStatuses: () =>
      events.flatMap((event) =>
        event.type === "context-handoff.updated" && event.payload.delivery !== undefined
          ? [event.payload.delivery.status]
          : [],
      ),
    start: Effect.gen(function* () {
      yield* (yield* ProviderTurnStart.ProviderTurnStartServiceV2).start({ threadId, runId });
    }).pipe(Effect.provide(layer)),
    startForked: Effect.gen(function* () {
      return yield* (yield* ProviderTurnStart.ProviderTurnStartServiceV2)
        .start({ threadId, runId })
        .pipe(Effect.forkScoped);
    }).pipe(Effect.provide(layer)),
  };
}

/** The tags this error wraps, outermost first: delivery failures arrive wrapped. */
const failureTags = (error: unknown): ReadonlyArray<string> => {
  const tags: Array<string> = [];
  let current: unknown = error;
  while (typeof current === "object" && current !== null) {
    const tag = (current as { _tag?: string })._tag;
    if (tag === undefined) break;
    tags.push(tag);
    current = (current as { cause?: unknown }).cause;
  }
  return tags;
};

const userText =
  "Keep every line of this request.\n\n  Preserve indentation, 日本語 and 🧪 exactly.\nFinal instruction: continue the work.";

effectIt.effect(
  "refuses a stale 375228 of 500000 before any compaction, on OpenCode's inline path",
  () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        contextUsage: { usedTokens: 375_228, maxTokens: 500_000 },
        estimate: undefined,
        userText,
      });
      yield* harness.start;
      expect(failureTags(harness.startFailures[0])).toContain("ContextHandoffBudgetError");
      expect(harness.estimateCalls).toHaveLength(1);
      expect(harness.estimateCalls[0]!.maxBytes).toBe(500_000);
      expect(harness.startedTurns).toEqual([]);
      expect(harness.deliveryStatuses()).toEqual([]);
      expect(harness.projection().contextHandoffs[0]!.delivery).toBeUndefined();
    }),
);

effectIt.effect("does not read a native estimate when the adapter has none", () =>
  Effect.gen(function* () {
    const harness = makeHarness({
      contextUsage: { usedTokens: 375_228, maxTokens: 500_000 },
      estimate: null,
      userText,
    });
    yield* harness.start;
    expect(failureTags(harness.startFailures[0])).toContain("ContextHandoffBudgetError");
    expect(harness.startedTurns).toEqual([]);
  }),
);

effectIt.effect("delivers inline once from a small completed post-compaction snapshot", () =>
  Effect.gen(function* () {
    // The primary regression: OpenCode has no history injection, so the whole
    // handoff arrives in the prompt of the original run.
    const harness = makeHarness({
      contextUsage: { usedTokens: 375_228, maxTokens: 500_000 },
      estimate: 30_000,
      userText,
    });
    yield* harness.start;
    expect(harness.estimateCalls).toHaveLength(1);
    expect(harness.estimateCalls[0]!.maxBytes).toBe(500_000);
    expect(harness.injected).toEqual([]);
    expect(harness.deliveryStatuses()).toEqual(["pending", "inline"]);
    expect(harness.startedTurns).toHaveLength(1);
    const turn = harness.startedTurns[0]!;
    // The current input is never shortened, and the recovered history precedes it.
    expect(turn.text.endsWith(`User message:\n${userText}`)).toBe(true);
    expect(turn.text).toContain(historyText);
    expect(turn.text).toContain("Selected 2 intact items");
    expect(turn.runId).toBe(runId);
    expect(turn.threadId).toBe(threadId);
    expect(turn.providerThreadId).toBe(providerThreadId);
    expect(turn.attemptId).toBe(attemptId);
    expect(harness.compactions).toEqual([]);
    const delivered = harness.projection().contextHandoffs[0]!;
    expect(delivered.targetRunId).toBe(runId);
    expect(delivered.delivery?.status).toBe("inline");
    expect(delivered.delivery?.nativeThreadId).toBe(nativeId);
    expect(delivered.delivery?.itemIds).toEqual([
      "item:native-context:user",
      "item:native-context:assistant",
    ]);
  }),
);

effectIt.effect("injects once when the adapter supports history injection", () =>
  Effect.gen(function* () {
    const harness = makeHarness({
      contextUsage: { usedTokens: 375_228, maxTokens: 500_000 },
      estimate: 30_000,
      injectHistory: true,
      userText,
    });
    yield* harness.start;
    expect(harness.estimateCalls).toHaveLength(1);
    expect(harness.injected).toHaveLength(1);
    expect(harness.injected[0]!.text).toContain(historyText);
    expect(harness.deliveryStatuses()).toEqual(["pending", "injected"]);
    expect(harness.startedTurns).toHaveLength(1);
    // Injected history is not repeated inline; the user's own words still are.
    expect(harness.startedTurns[0]!.text).toBe(userText);
    expect(harness.startedTurns[0]!.runId).toBe(runId);
  }),
);

effectIt.effect("keeps refusing a context that regrew to two megabytes", () =>
  Effect.gen(function* () {
    const harness = makeHarness({
      contextUsage: { usedTokens: 375_228, maxTokens: 500_000 },
      estimate: 2_500_000,
      userText,
    });
    yield* harness.start;
    expect(failureTags(harness.startFailures[0])).toContain("ContextHandoffBudgetError");
    expect(harness.estimateCalls).toHaveLength(1);
    expect(harness.startedTurns).toEqual([]);
    expect(harness.deliveryStatuses()).toEqual([]);
  }),
);

effectIt.effect("keeps the auto-compaction threshold over a fresh estimate", () =>
  Effect.gen(function* () {
    const harness = makeHarness({
      contextUsage: { usedTokens: 375_228, maxTokens: 500_000, autoCompactThreshold: 40_000 },
      estimate: 30_000,
      userText,
    });
    yield* harness.start;
    expect(failureTags(harness.startFailures[0])).toContain("ContextHandoffBudgetError");
    expect(harness.startedTurns).toEqual([]);
  }),
);

effectIt.effect("performs no estimate read for manual compaction", () =>
  Effect.gen(function* () {
    const harness = makeHarness({
      contextUsage: { usedTokens: 375_228, maxTokens: 500_000 },
      estimate: 30_000,
      invocation: "compact",
      userText,
    });
    yield* harness.start;
    expect(harness.estimateCalls).toEqual([]);
    expect(harness.compactions).toHaveLength(1);
    expect(harness.startedTurns).toEqual([]);
    // Compaction cannot carry an inline transcript, so nothing is marked delivered.
    expect(harness.events.some((event) => event.type === "context-handoff.updated")).toBe(false);
    expect(harness.projection().contextHandoffs[0]!.delivery).toBeUndefined();
  }),
);

effectIt.effect("does not read an estimate for a thread whose native session was replaced", () =>
  Effect.gen(function* () {
    const harness = makeHarness({
      contextUsage: { usedTokens: 375_228, maxTokens: 500_000 },
      estimate: 30_000,
      replacedNativeThread: true,
      userText,
    });
    yield* harness.start;
    // A different native thread has no measured occupancy to correct, and the
    // stale row's 375228 must not decide its budget either.
    expect(harness.estimateCalls).toEqual([]);
    expect(harness.deliveryStatuses()).toEqual(["pending", "inline"]);
    expect(harness.startedTurns).toHaveLength(1);
    expect(harness.startedTurns[0]!.text).toContain(historyText);
    expect(harness.startedTurns[0]!.text.endsWith(`User message:\n${userText}`)).toBe(true);
  }),
);

effectIt.effect("starts no turn when the estimate read is cancelled", () =>
  Effect.gen(function* () {
    const harness = makeHarness({
      contextUsage: { usedTokens: 375_228, maxTokens: 500_000 },
      estimate: "hang",
      userText,
    });
    const fiber = yield* harness.startForked;
    yield* Effect.yieldNow;
    expect(harness.estimateCalls).toHaveLength(1);
    yield* Fiber.interrupt(fiber);
    expect(harness.startedTurns).toEqual([]);
    expect(harness.injected).toEqual([]);
    expect(harness.compactions).toEqual([]);
    expect(harness.deliveryStatuses()).toEqual([]);
  }),
);
