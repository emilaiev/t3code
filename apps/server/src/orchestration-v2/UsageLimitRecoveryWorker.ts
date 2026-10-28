import {
  CommandId,
  MessageId,
  ProviderInstanceId,
  RunId,
  type OrchestrationV2Command,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { modelClosure } from "../provider/modelQuotaGate.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import {
  type CheapTarget,
  type ContinuationObservation,
  nextCheapContinuation,
  resolveCheapTargets,
} from "./quotaContinuation.ts";

export function limitRecoveryCommand(
  thread: ProjectionStore.ProjectionLimitRecoveryCandidate,
  autoResume: boolean,
  nowMs: number,
  snooze = false,
): OrchestrationV2Command | null {
  if (
    thread.status !== "failed" ||
    thread.lastErrorClass !== "usage_limit" ||
    !thread.latestRunId ||
    !thread.usageLimitResetAt ||
    thread.archivedAt !== null ||
    thread.settledOverride === "settled" ||
    thread.pendingRuntimeRequest !== null ||
    isTopLevelMcpLaunch(thread)
  )
    return null;
  const resetMs = Date.parse(thread.usageLimitResetAt);
  // An already-expired window reported with a fresh failure cannot start a retry loop.
  if (
    !Number.isFinite(resetMs) ||
    resetMs <= DateTime.toEpochMillis(thread.latestRunCompletedAt ?? thread.updatedAt)
  )
    return null;
  const identity = `${thread.id}:${thread.latestRunId}:${resetMs}`;
  const recovery = thread.limitRecovery;
  if (recovery?.runId !== thread.latestRunId || recovery.resetAt !== thread.usageLimitResetAt) {
    if (!autoResume && (!snooze || resetMs <= nowMs)) return null;
    return {
      type: "thread.metadata.update",
      commandId: CommandId.make(`limit-arm:${identity}`),
      threadId: thread.id,
      limitRecovery: {
        runId: thread.latestRunId,
        resetAt: thread.usageLimitResetAt,
        autoResume,
        snooze: snooze && resetMs > nowMs,
      },
    };
  }
  if (
    !recovery.autoResume ||
    resetMs > nowMs ||
    (thread.snoozedUntil != null && DateTime.toEpochMillis(thread.snoozedUntil) > nowMs)
  )
    return null;
  const deliveryIdentity = `${identity}:${recovery.requestId ?? "legacy"}`;
  return {
    type: "message.dispatch",
    commandId: CommandId.make(`limit-resume:${deliveryIdentity}`),
    messageId: MessageId.make(`limit-resume:${deliveryIdentity}`),
    threadId: thread.id,
    usageLimitContinuationOfRunId: thread.latestRunId,
    ...(recovery.requestId === undefined
      ? {}
      : { usageLimitRecoveryRequestId: recovery.requestId }),
    text: "Continue where you left off.",
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    createdBy: "user",
    creationSource: "server",
  };
}

export function quotaContinuationCommands(input: {
  readonly thread: Pick<
    ProjectionStore.ProjectionLimitRecoveryCandidate,
    | "id"
    | "providerInstanceId"
    | "latestRunId"
    | "usageLimitResetAt"
    | "limitRecovery"
    | "snoozedUntil"
  >;
  readonly targets: ReadonlyArray<CheapTarget>;
  readonly observation: ContinuationObservation;
  readonly nowMs: number;
}): {
  readonly metadata: OrchestrationV2Command;
  readonly message: OrchestrationV2Command | null;
} | null {
  if (!input.thread.latestRunId) return null;
  const stored = input.thread.limitRecovery;
  const decision = nextCheapContinuation({
    sourceInstanceId: stored?.quotaSwitch?.sourceInstanceId ?? input.thread.providerInstanceId,
    sourceRunId: stored?.quotaSwitch?.sourceRunId ?? input.thread.latestRunId,
    switchState: stored?.quotaSwitch ?? null,
    observation: input.observation,
    targets: input.targets,
    snoozed:
      input.thread.snoozedUntil != null &&
      DateTime.toEpochMillis(input.thread.snoozedUntil) > input.nowMs,
  });
  if (decision.type === "none") return null;
  const resetAt = stored?.resetAt ?? input.thread.usageLimitResetAt;
  if (!resetAt) return null;
  const sourceRunId = decision.quotaSwitch.sourceRunId;
  const metadata = {
    type: "thread.metadata.update" as const,
    commandId: CommandId.make(
      decision.type === "mark-opened"
        ? `quota-switch:${input.thread.id}:${sourceRunId}:opened:${input.observation.latestRunId}`
        : `quota-switch:${input.thread.id}:${sourceRunId}:${decision.instanceId}`,
    ),
    threadId: input.thread.id,
    limitRecovery: {
      runId: RunId.make(sourceRunId),
      resetAt,
      autoResume: false as const,
      snooze: false as const,
      quotaSwitch: {
        sourceRunId: RunId.make(decision.quotaSwitch.sourceRunId),
        sourceInstanceId: ProviderInstanceId.make(decision.quotaSwitch.sourceInstanceId),
        pendingInstanceId:
          decision.quotaSwitch.pendingInstanceId === null
            ? null
            : ProviderInstanceId.make(decision.quotaSwitch.pendingInstanceId),
        triedInstanceIds: decision.quotaSwitch.triedInstanceIds.map((id) =>
          ProviderInstanceId.make(id),
        ),
        opened: decision.quotaSwitch.opened,
      },
    },
  };
  if (decision.type === "mark-opened") return { metadata, message: null };
  return {
    metadata,
    message: {
      type: "message.dispatch",
      commandId: CommandId.make(
        `quota-switch-send:${input.thread.id}:${sourceRunId}:${decision.instanceId}`,
      ),
      messageId: MessageId.make(
        `quota-switch-send:${input.thread.id}:${sourceRunId}:${decision.instanceId}`,
      ),
      threadId: input.thread.id,
      text: "Continue where you left off.",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "server",
      modelSelection: {
        instanceId: ProviderInstanceId.make(decision.instanceId),
        model: decision.model,
        ...(decision.effort === null
          ? {}
          : { options: [{ id: decision.effort.id, value: decision.effort.value }] }),
      },
    },
  };
}

/** A t3x run is a top-level thread an agent started through MCP. On a server that includes this rule, detach and a timed-out wait leave nobody to settle it, so it is not resumed on the same model. The cheap-provider walk still runs. The signed Mac app does not include the same-model exclusion. A subagent still follows the normal recovery rule. */
function isTopLevelMcpLaunch(
  thread: Pick<
    ProjectionStore.ProjectionLimitRecoveryCandidate,
    "createdBy" | "creationSource" | "lineage"
  >,
): boolean {
  return (
    thread.createdBy === "agent" &&
    thread.creationSource === "mcp" &&
    thread.lineage.relationshipToParent === null
  );
}

const ignoreReplay = <A, R>(
  effect: Effect.Effect<
    A,
    | Orchestrator.OrchestratorV2Error
    | ThreadManagement.ThreadManagementProviderInstanceDisabledError,
    R
  >,
) => effect.pipe(Effect.catchTag("OrchestratorCommandIdConflictError", () => Effect.void));

const makeSweep = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const settings = yield* ServerSettings.ServerSettingsService;
  const registry = yield* ProviderRegistry.ProviderRegistry;
  return Effect.fn("UsageLimitRecoveryWorker.sweep")(function* () {
    const preferences = yield* settings.getSettings;
    const now = yield* DateTime.now;
    const nowMs = DateTime.toEpochMillis(now);
    const candidates = yield* projections.getLimitRecoveryCandidates({
      now,
      autoResume: preferences.autoResumeLimitedThreads,
      snooze: preferences.snoozeLimitedThreads,
    });
    const followUps = yield* projections.getQuotaSwitchFollowUps();
    const targets =
      candidates.length === 0 && followUps.length === 0
        ? []
        : yield* cheapTargets(registry).pipe(Effect.orElseSucceed(() => []));
    const handled = new Set<string>();
    const dispatchRecovery = <E>(threadId: string, effect: Effect.Effect<void, E>) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("orchestration-v2.limit-recovery.dispatch-failed", {
            threadId,
            cause,
          }),
        ),
      );
    for (const thread of candidates) {
      handled.add(thread.id);
      const continuation = quotaContinuationCommands({
        thread,
        targets,
        observation: {
          latestRunId: thread.latestRunId ?? "",
          latestInstanceId: thread.providerInstanceId,
          latestRunStarted: false,
          sessionOpenFailure: false,
          latestErrorClass: thread.lastErrorClass ?? null,
        },
        nowMs,
      });
      if (continuation) {
        yield* dispatchRecovery(
          thread.id,
          Effect.gen(function* () {
            if (continuation.metadata.type !== "thread.metadata.update") return;
            const recovery = continuation.metadata.limitRecovery;
            if (recovery == null) return;
            yield* ignoreReplay(
              orchestrator.autoArmLimitRecovery({
                commandId: continuation.metadata.commandId,
                threadId: continuation.metadata.threadId,
                limitRecovery: recovery,
              }),
            );
            if (continuation.message) {
              yield* ignoreReplay(threads.dispatch(continuation.message));
            }
          }),
        );
        // Same-model resume waits for the next sweep, after opened is stored.
        continue;
      }
      const command = limitRecoveryCommand(
        thread,
        preferences.autoResumeLimitedThreads,
        nowMs,
        preferences.snoozeLimitedThreads,
      );
      if (command === null) continue;
      yield* dispatchRecovery(
        thread.id,
        Effect.gen(function* () {
          if (command.type === "thread.metadata.update" && command.limitRecovery != null) {
            yield* orchestrator.autoArmLimitRecovery({
              commandId: command.commandId,
              threadId: command.threadId,
              limitRecovery: command.limitRecovery,
            });
          } else {
            yield* threads.dispatch(command);
          }
        }),
      );
    }
    for (const followUp of followUps) {
      if (handled.has(followUp.id)) continue;
      const continuation = quotaContinuationCommands({
        thread: {
          id: followUp.id,
          providerInstanceId: followUp.latestInstanceId,
          latestRunId: followUp.latestRunId,
          usageLimitResetAt: followUp.limitRecovery.resetAt,
          limitRecovery: followUp.limitRecovery,
          snoozedUntil: null,
        },
        targets,
        observation: {
          latestRunId: followUp.latestRunId,
          latestInstanceId: followUp.latestInstanceId,
          latestRunStarted: followUp.latestRunStarted,
          sessionOpenFailure: followUp.sessionOpenFailure,
          latestErrorClass: followUp.latestErrorClass,
        },
        nowMs,
      });
      if (continuation === null || continuation.metadata.type !== "thread.metadata.update") {
        continue;
      }
      const metadata = continuation.metadata;
      const recovery = metadata.limitRecovery;
      if (recovery == null) continue;
      yield* dispatchRecovery(
        followUp.id,
        Effect.gen(function* () {
          yield* ignoreReplay(
            orchestrator.autoArmLimitRecovery({
              commandId: metadata.commandId,
              threadId: metadata.threadId,
              limitRecovery: recovery,
            }),
          );
          if (continuation.message) {
            yield* ignoreReplay(threads.dispatch(continuation.message));
          }
        }),
      );
    }
  });
});

const cheapTargets = Effect.fn("UsageLimitRecoveryWorker.cheapTargets")(function* (
  registry: ProviderRegistry.ProviderRegistry["Service"],
) {
  const providers = yield* registry.getProviders;
  const present = resolveCheapTargets(
    providers.map((provider) => ({
      instanceId: provider.instanceId,
      driver: provider.driver,
      enabled: provider.enabled,
      installed: provider.installed,
      status: provider.status,
      models: provider.models,
    })),
    new Set(),
  );
  const closed = new Set<string>();
  for (const target of present) {
    if (!target.open) continue;
    const until = yield* modelClosure(
      registry,
      ProviderInstanceId.make(target.instanceId),
      target.model,
    ).pipe(Effect.orElseSucceed(() => "unreadable"));
    if (until !== undefined) closed.add(target.instanceId);
  }
  return resolveCheapTargets(
    providers.map((provider) => ({
      instanceId: provider.instanceId,
      driver: provider.driver,
      enabled: provider.enabled,
      installed: provider.installed,
      status: provider.status,
      models: provider.models,
    })),
    closed,
  );
});

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const sweep = yield* makeSweep;
    const scheduler = yield* Scheduler.Scheduler;
    yield* scheduler.register("usage-limit-recovery", sweep());
  }),
);
