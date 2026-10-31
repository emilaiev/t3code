import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, OrchestratorMcpT3xLaunchInput, RunId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { Tool } from "effect/ai";

import * as ProcessRunner from "../processRunner.ts";
import * as T3xBridgeService from "./T3xBridgeService.ts";
import { OrchestratorToolkit } from "./toolkits/orchestrator/tools.ts";

const parent = {
  environmentId: EnvironmentId.make("environment:bridge-test"),
  threadId: ThreadId.make("thread:bridge-parent"),
  runId: RunId.make("run:bridge-parent"),
};

const launch = {
  host: "win",
  cli: "codex",
  task: "Check the target checkout.",
  model: "gpt-6-luna",
  clientRequestId: "request-1",
} satisfies OrchestratorMcpT3xLaunchInput;

const successfulOutput = (stdout: string): ProcessRunner.ProcessRunOutput => ({
  stdout,
  stderr: "",
  code: ChildProcessSpawner.ExitCode(0),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});

const provideBridge = <A, E>(
  runner: ProcessRunner.ProcessRunner["Service"]["run"],
  effect: Effect.Effect<
    A,
    E | import("@t3tools/contracts").OrchestratorMcpFailure,
    T3xBridgeService.T3xBridgeService
  >,
  platform: NodeJS.Platform = "linux",
) =>
  effect.pipe(
    Effect.provide(
      T3xBridgeService.layerWith(platform, { PATH: "/test/bin" }).pipe(
        Layer.provide(
          Layer.mergeAll(
            NodeServices.layer,
            Layer.succeed(ProcessRunner.ProcessRunner, { run: runner }),
          ),
        ),
      ),
    ),
  );

const invoke = (request: unknown) =>
  Effect.gen(function* () {
    const bridge = yield* T3xBridgeService.T3xBridgeService;
    return yield* bridge.launch(request);
  });

const windowsJoin: Path.Path["join"] = (...segments) => segments.join("\\");
const posixJoin: Path.Path["join"] = (...segments) => segments.join("/");

it.effect("sends only bridge-launch on argv and the validated request on stdin", () =>
  Effect.gen(function* () {
    let observed: ProcessRunner.ProcessRunInput | undefined;
    const result = yield* provideBridge(
      (input) => {
        observed = input;
        return Effect.succeed(
          successfulOutput(
            JSON.stringify({
              jobId: "job-1",
              target: { host: "win", threadId: "thread:target", runId: "run:target" },
              state: "running",
              result: null,
            }),
          ),
        );
      },
      invoke({ requestKey: "request-1", parent, launch }),
    );

    expect(result).toEqual({
      jobId: "job-1",
      target: { host: "win", threadId: "thread:target", runId: "run:target" },
      state: "running",
      result: null,
    });
    expect(observed).toMatchObject({
      command: "t3x",
      args: ["bridge-launch"],
      timeout: "30 seconds",
    });
    expect(JSON.parse(observed!.stdin!)).toEqual({
      requestKey: "request-1",
      parent,
      launch: { host: launch.host, cli: launch.cli, task: launch.task, model: launch.model },
    });
    expect(observed!.env).toBeUndefined();
    expect(observed!.args).not.toContain(parent.environmentId);
    expect(observed!.args).not.toContain(parent.threadId);
    expect(observed!.args).not.toContain(parent.runId);
  }),
);

it.effect("turns the completion reply off when notify is false", () =>
  Effect.gen(function* () {
    let observed: ProcessRunner.ProcessRunInput | undefined;
    yield* provideBridge(
      (input) => {
        observed = input;
        return Effect.succeed(
          successfulOutput(
            JSON.stringify({
              jobId: "job-quiet",
              target: { host: "win", threadId: "thread:t", runId: "run:t" },
              state: "running",
            }),
          ),
        );
      },
      invoke({ requestKey: "request-quiet", parent, launch: { ...launch, notify: false } }),
    );

    expect(JSON.parse(observed!.stdin!)).toEqual({
      requestKey: "request-quiet",
      parent,
      launch: {
        host: launch.host,
        cli: launch.cli,
        task: launch.task,
        model: launch.model,
        replyTo: null,
      },
    });
  }),
);

it.effect("rejects malformed requests and malformed bridge results", () =>
  Effect.gen(function* () {
    let invoked = false;
    const missingRequestKey = yield* provideBridge(() => {
      invoked = true;
      return Effect.fail(new Error("must not spawn") as never);
    }, invoke({ parent, launch })).pipe(Effect.flip);
    expect(missingRequestKey.message).toContain("Invalid T3X bridge request");
    expect(invoked).toBe(false);

    const invalidRequest = yield* provideBridge(
      () => Effect.fail(new Error("must not spawn") as never),
      invoke({ requestKey: "", parent, launch }),
    ).pipe(Effect.flip);
    expect(invalidRequest.message).toContain("Invalid T3X bridge request");

    const invalidResult = yield* provideBridge(
      () => Effect.succeed(successfulOutput('{"jobId":"only"}')),
      invoke({ requestKey: "request-2", parent, launch }),
    ).pipe(Effect.flip);
    expect(invalidResult.message).toContain("malformed launch result");
  }),
);

it.effect("preserves an unbound uncertain receipt without inventing target IDs", () =>
  Effect.gen(function* () {
    const result = yield* provideBridge(
      () =>
        Effect.succeed(
          successfulOutput(
            JSON.stringify({
              jobId: "job:uncertain",
              target: null,
              state: "uncertain",
              error: "launch binding is not yet visible",
            }),
          ),
        ),
      invoke({ requestKey: "request-uncertain", parent, launch }),
    );
    expect(result).toEqual({
      jobId: "job:uncertain",
      target: null,
      state: "uncertain",
      error: "launch binding is not yet visible",
    });
    expect(result).not.toHaveProperty("threadId");
    expect(result).not.toHaveProperty("runId");
  }),
);

it.effect("returns the detached launch receipt without waiting for remote task completion", () =>
  Effect.gen(function* () {
    let processReturnedReceipt = false;
    const result = yield* provideBridge(
      () => {
        processReturnedReceipt = true;
        return Effect.succeed(
          successfulOutput(
            JSON.stringify({
              jobId: "job:detached",
              target: { host: "win", threadId: "thread:target", runId: "run:target" },
              state: "running",
            }),
          ),
        );
      },
      invoke({ requestKey: "request-detached", parent, launch }),
    );

    expect(processReturnedReceipt).toBe(true);
    expect(result).toEqual({
      jobId: "job:detached",
      target: { host: "win", threadId: "thread:target", runId: "run:target" },
      state: "running",
    });
    expect(result).not.toHaveProperty("result");
  }),
);

it.effect("reuses the same T3X job on an exact request-key retry", () =>
  Effect.gen(function* () {
    const seenKeys: string[] = [];
    const jobs = new Map<string, string>();
    const result = yield* provideBridge(
      (input) => {
        const request = JSON.parse(input.stdin ?? "{}") as { requestKey: string };
        seenKeys.push(request.requestKey);
        const jobId = jobs.get(request.requestKey) ?? "job:deduplicated";
        jobs.set(request.requestKey, jobId);
        return Effect.succeed(
          successfulOutput(
            JSON.stringify({
              jobId,
              target: { host: "win", threadId: "thread:target", runId: "run:target" },
              state: "running",
            }),
          ),
        );
      },
      Effect.gen(function* () {
        const bridge = yield* T3xBridgeService.T3xBridgeService;
        const request = { requestKey: "request-exact-retry", parent, launch };
        const first = yield* bridge.launch(request);
        const retried = yield* bridge.launch(request);
        return [first, retried] as const;
      }),
    );
    expect(seenKeys).toEqual(["request-exact-retry", "request-exact-retry"]);
    expect(new Set(result.map((receipt) => receipt.jobId))).toEqual(new Set(["job:deduplicated"]));
    expect(jobs.size).toBe(1);
  }),
);

it.effect("fails closed on process errors, timeout, and non-zero exit", () =>
  Effect.gen(function* () {
    const processFailure = yield* provideBridge(
      () =>
        Effect.fail(
          new ProcessRunner.ProcessSpawnError({
            command: "t3x",
            argumentCount: 1,
            cause: new Error("ENOENT"),
          }),
        ),
      invoke({ requestKey: "request-3", parent, launch }),
    ).pipe(Effect.flip);
    expect(processFailure.message).toContain("missing or could not be started");

    const timeout = yield* provideBridge(
      () =>
        Effect.fail(
          new ProcessRunner.ProcessTimeoutError({
            command: "t3x",
            argumentCount: 1,
            timeoutMs: 30_000,
          }),
        ),
      invoke({ requestKey: "request-4", parent, launch }),
    ).pipe(Effect.flip);
    expect(timeout.message).toContain("timed out");

    const nonZero = yield* provideBridge(
      () => Effect.succeed({ ...successfulOutput(""), code: ChildProcessSpawner.ExitCode(2) }),
      invoke({ requestKey: "request-5", parent, launch }),
    ).pipe(Effect.flip);
    expect(nonZero.message).toContain("exited with code 2");

    // A refused launch names its reason; an agent must see that, not the exit code.
    const refused = yield* provideBridge(
      () =>
        Effect.succeed({
          ...successfulOutput(
            JSON.stringify({
              ok: false,
              state: "rejected",
              jobId: null,
              error: "no runnable instance matches 'antigravity'",
            }),
          ),
          code: ChildProcessSpawner.ExitCode(2),
        }),
      invoke({ requestKey: "request-6", parent, launch }),
    ).pipe(Effect.flip);
    expect(refused.message).toContain("no runnable instance matches 'antigravity'");

    // A runner-level refusal exits 0 with `ok:false`; the reason must survive too.
    const runnerRefusal = yield* provideBridge(
      () =>
        Effect.succeed(
          successfulOutput(
            JSON.stringify({
              ok: false,
              state: "rejected",
              jobId: null,
              error: "model 'gemini-3.8-flash-low' is not in antigravity's list",
            }),
          ),
        ),
      invoke({ requestKey: "request-7", parent, launch }),
    ).pipe(Effect.flip);
    expect(runnerRefusal.message).toContain("is not in antigravity's list");
  }),
);

it.effect.each([
  { platform: "linux" as const, targetHost: "wsl" as const },
  { platform: "win32" as const, targetHost: "win" as const },
])("refuses same-host launch on $platform before spawning", ({ platform, targetHost }) =>
  Effect.gen(function* () {
    let invoked = false;
    const error = yield* provideBridge(
      () => {
        invoked = true;
        return Effect.fail(new Error("bridge must not spawn") as never);
      },
      invoke({
        requestKey: "request-same-host",
        parent,
        launch: { ...launch, host: targetHost },
      }),
      platform,
    ).pipe(Effect.flip);

    expect(error).toMatchObject({ _tag: "OrchestratorMcpFailure", code: "invalid_request" });
    expect(error.message).toContain("Use native delegate_task");
    expect(invoked).toBe(false);
  }),
);

it.effect("resolves the Windows shim sidecar and Python launcher without a shell", () =>
  Effect.gen(function* () {
    const existing = new Set([
      String.raw`C:\t3\bin\t3x.cmd`,
      String.raw`C:\t3\bin\t3x_win.py`,
      String.raw`C:\Python\python.exe`,
    ]);
    const command = yield* T3xBridgeService.resolveT3xCommand(
      "win32",
      { PATH: String.raw`C:\t3\bin;C:\Python` },
      (path) => Effect.succeed(existing.has(path)),
      windowsJoin,
    );
    expect(command).toEqual({
      command: String.raw`C:\Python\python.exe`,
      args: [String.raw`C:\t3\bin\t3x_win.py`, "bridge-launch"],
    });

    const missing = yield* T3xBridgeService.resolveT3xCommand(
      "win32",
      { PATH: "" },
      () => Effect.succeed(false),
      windowsJoin,
    ).pipe(Effect.flip);
    expect(missing.message).toContain("t3x.cmd was not found on PATH");
  }),
);

it.effect("does not provide a Mac-origin bridge route", () =>
  Effect.gen(function* () {
    const error = yield* T3xBridgeService.resolveT3xCommand(
      "darwin",
      {},
      () => Effect.succeed(false),
      posixJoin,
    ).pipe(Effect.flip);
    expect(error.message).toContain("unavailable from this Mac T3 server build");
  }),
);

it("registers the T3X tool without caller-supplied parent IDs", () => {
  const tool = OrchestratorToolkit.tools.t3x_bridge_launch;
  const schema = Tool.getJsonSchema(tool) as {
    readonly properties: Readonly<Record<string, unknown>>;
    readonly required?: ReadonlyArray<string>;
  };
  expect(schema.properties).toHaveProperty("host");
  expect(schema.properties).toHaveProperty("task");
  expect(schema.properties).not.toHaveProperty("parent");
  expect(schema.properties).not.toHaveProperty("environmentId");
  expect(schema.properties).not.toHaveProperty("threadId");
  expect(schema.properties).not.toHaveProperty("runId");
  expect(schema.required).toContain("clientRequestId");
});
