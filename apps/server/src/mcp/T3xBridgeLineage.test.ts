import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  OrchestratorMcpT3xLaunchInput,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as T3xBridgeService from "./T3xBridgeService.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";

const threadId = ThreadId.make("thread:t3x-parent");
const runId = RunId.make("run:t3x-parent");
const providerInstanceId = ProviderInstanceId.make("codex");
const environmentId = EnvironmentId.make("environment:t3x-parent");
const projectId = ProjectId.make("project:t3x-parent");

const input = {
  host: "win",
  cli: "codex",
  task: "Run the requested task.",
  model: "gpt-6-luna",
  clientRequestId: "t3x-bridge-test",
} satisfies OrchestratorMcpT3xLaunchInput;

const scope: McpInvocationScope = {
  environmentId,
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
  requestNamespace: "provider-session:t3x-parent",
  thread: {
    threadId,
    providerSessionId: "provider-session:t3x-parent",
    providerInstanceId,
  },
  client: undefined,
};

const projection = (runs: ReadonlyArray<unknown>) =>
  ({
    thread: { id: threadId, projectId },
    runs,
    messages: [],
    subagents: [],
    providerThreads: [],
    contextTransfers: [],
    runtimeRequests: [],
    turnItems: [],
  }) as unknown as OrchestrationV2ThreadProjection;

const activeRun = (overrides: Record<string, unknown> = {}) => ({
  id: runId,
  ordinal: 1,
  status: "running",
  rootNodeId: "node:root",
  providerInstanceId,
  ...overrides,
});

const makeServiceLayer = (
  parentProjection: OrchestrationV2ThreadProjection,
  bridgeLaunch: T3xBridgeService.T3xBridgeService["Service"]["launch"],
) => {
  const dependencies = Layer.mergeAll(
    NodeServices.layer,
    Layer.mock(ThreadManagementService.ThreadManagementService)({
      getThreadRecords: () => Effect.succeed(parentProjection),
    }),
    Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
    Layer.mock(GitVcsDriver.GitVcsDriver)({}),
    Layer.mock(T3xBridgeService.T3xBridgeService)({ launch: bridgeLaunch }),
    ServerSettings.layerTest(),
    Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
    Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
      list: () => Effect.succeed([]),
    }),
    Layer.mock(ProjectService.ProjectService)({}),
    Layer.mock(SecretRequests.SecretRequests)({}),
    Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
  );
  return OrchestratorMcpService.layer.pipe(Layer.provide(dependencies));
};

const launchWith = (caller: McpInvocationScope, request: OrchestratorMcpT3xLaunchInput) =>
  Effect.gen(function* () {
    const service = yield* OrchestratorMcpService.OrchestratorMcpService;
    return yield* service.launchT3x(caller, request);
  });

it.effect("derives parent IDs from invocation scope and the active run projection", () =>
  Effect.gen(function* () {
    const seen = yield* Ref.make<unknown>(null);
    const serviceLayer = makeServiceLayer(projection([activeRun()]), (request) =>
      Ref.set(seen, request).pipe(
        Effect.as({
          jobId: "job:t3x",
          target: {
            host: "win",
            threadId: ThreadId.make("thread:t3x-target"),
            runId: RunId.make("run:t3x-target"),
          },
          state: "running",
        }),
      ),
    );
    const forged = {
      ...input,
      environmentId: "environment:forged",
      threadId: "thread:forged",
      runId: "run:forged",
      parent: {
        environmentId: "environment:forged",
        threadId: "thread:forged",
        runId: "run:forged",
      },
    } as unknown as OrchestratorMcpT3xLaunchInput;

    const result = yield* launchWith(scope, forged).pipe(Effect.provide(serviceLayer));
    const request = yield* Ref.get(seen);
    expect(result.jobId).toBe("job:t3x");
    expect(request).toMatchObject({
      requestKey: input.clientRequestId,
      parent: { environmentId, threadId, runId },
    });
  }),
);

it.effect("requires a clientRequestId before reading parent state or calling T3X", () =>
  Effect.gen(function* () {
    let called = false;
    const serviceLayer = makeServiceLayer(projection([activeRun()]), () => {
      called = true;
      return Effect.fail(new Error("bridge must not run") as never);
    });
    const missingKey = {
      ...input,
      clientRequestId: undefined,
    } as unknown as OrchestratorMcpT3xLaunchInput;
    const error = yield* launchWith(scope, missingKey).pipe(
      Effect.provide(serviceLayer),
      Effect.flip,
    );
    expect(error).toMatchObject({ _tag: "OrchestratorMcpFailure", code: "invalid_request" });
    expect(error.message).toContain("requires a stable clientRequestId");
    expect(called).toBe(false);
  }),
);

it.effect("refuses OAuth/client scopes without a calling thread", () =>
  Effect.gen(function* () {
    let called = false;
    const clientScope: McpInvocationScope = {
      ...scope,
      thread: undefined,
      client: {
        sessionId: "client-session",
        label: "read-only client",
        access: "read-only",
      },
    };
    const serviceLayer = makeServiceLayer(projection([activeRun()]), () => {
      called = true;
      return Effect.succeed({
        jobId: "job:should-not-start",
        target: {
          host: "win",
          threadId: ThreadId.make("thread:target"),
          runId: RunId.make("run:target"),
        },
      });
    });
    const error = yield* launchWith(clientScope, input).pipe(
      Effect.provide(serviceLayer),
      Effect.flip,
    );
    expect(error).toMatchObject({
      _tag: "OrchestratorMcpFailure",
      code: "thread_credential_required",
    });
    expect(called).toBe(false);
  }),
);

it.effect.each([
  { name: "no active run", runs: [] },
  { name: "null root", runs: [activeRun({ rootNodeId: null })] },
  {
    name: "provider mismatch",
    runs: [activeRun({ providerInstanceId: ProviderInstanceId.make("claudeAgent") })],
  },
])("refuses parent lineage with $name", ({ runs }) =>
  Effect.gen(function* () {
    let called = false;
    const serviceLayer = makeServiceLayer(projection(runs), () => {
      called = true;
      return Effect.fail(new Error("bridge must not run") as never);
    });
    const error = yield* launchWith(scope, input).pipe(Effect.provide(serviceLayer), Effect.flip);
    expect(error).toMatchObject({ _tag: "OrchestratorMcpFailure", code: "parent_not_active" });
    expect(called).toBe(false);
  }),
);

it.effect("reuses the same request key for an exact retry and returns the same job", () =>
  Effect.gen(function* () {
    const seenKeys: string[] = [];
    const serviceLayer = makeServiceLayer(projection([activeRun()]), (request) => {
      const key = (request as { requestKey: string }).requestKey;
      seenKeys.push(key);
      return Effect.succeed({
        jobId: "job:retry-safe",
        target: {
          host: "win",
          threadId: ThreadId.make("thread:t3x-target"),
          runId: RunId.make("run:t3x-target"),
        },
        state: "running",
      });
    });
    const results = yield* Effect.gen(function* () {
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      const first = yield* service.launchT3x(scope, input);
      const retried = yield* service.launchT3x(scope, input);
      return [first, retried] as const;
    }).pipe(Effect.provide(serviceLayer));
    expect(seenKeys).toEqual([input.clientRequestId, input.clientRequestId]);
    expect(results[0].jobId).toBe(results[1].jobId);
  }),
);
