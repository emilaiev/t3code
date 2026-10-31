import {
  EnvironmentId,
  OrchestratorMcpFailure,
  OrchestratorMcpT3xLaunchInput,
  OrchestratorMcpT3xLaunchResult,
  RunId,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as FileSystem from "effect/FileSystem";

import * as ProcessRunner from "../processRunner.ts";

const T3xBridgeRequest = Schema.Struct({
  requestKey: TrimmedNonEmptyString,
  parent: Schema.Struct({
    environmentId: EnvironmentId,
    threadId: ThreadId,
    runId: RunId,
  }),
  launch: OrchestratorMcpT3xLaunchInput,
});

export interface ResolvedT3xCommand {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

export const resolveT3xCommand = (
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
  exists: (path: string) => Effect.Effect<boolean>,
  joinPath: Path.Path["join"],
): Effect.Effect<ResolvedT3xCommand, OrchestratorMcpFailure> => {
  if (platform === "darwin") {
    return Effect.fail(
      new OrchestratorMcpFailure({
        code: "provider_unavailable",
        message: "T3X bridge launch is unavailable from this Mac T3 server build.",
      }),
    );
  }
  if (platform !== "win32") return Effect.succeed({ command: "t3x", args: ["bridge-launch"] });

  const pathEntries = (environment.PATH ?? "").split(";").filter(Boolean);
  return Effect.gen(function* () {
    let shimDirectory: string | undefined;
    for (const entry of pathEntries) {
      if (yield* exists(joinPath(entry, "t3x.cmd"))) {
        shimDirectory = entry;
        break;
      }
    }
    if (shimDirectory === undefined) {
      return yield* new OrchestratorMcpFailure({
        code: "orchestration_error",
        message: "T3X bridge launch is unavailable because t3x.cmd was not found on PATH.",
      });
    }
    const pythonShimPath = joinPath(shimDirectory, "t3x_win.py");
    if (!(yield* exists(pythonShimPath))) {
      return yield* new OrchestratorMcpFailure({
        code: "orchestration_error",
        message: "T3X bridge launch is unavailable because t3x_win.py is missing beside t3x.cmd.",
      });
    }
    let pythonDirectory: string | undefined;
    for (const entry of pathEntries) {
      if (yield* exists(joinPath(entry, "python.exe"))) {
        pythonDirectory = entry;
        break;
      }
    }
    if (pythonDirectory === undefined) {
      return yield* new OrchestratorMcpFailure({
        code: "orchestration_error",
        message: "T3X bridge launch is unavailable because python.exe was not found on PATH.",
      });
    }
    // Deliberately bypass cmd.exe: the Python shim receives argv and forwards stdin.
    return {
      command: joinPath(pythonDirectory, "python.exe"),
      args: [pythonShimPath, "bridge-launch"],
    };
  });
};

export class T3xBridgeService extends Context.Service<
  T3xBridgeService,
  {
    readonly launch: (
      request: unknown,
    ) => Effect.Effect<OrchestratorMcpT3xLaunchResult, OrchestratorMcpFailure>;
  }
>()("t3/mcp/T3xBridgeService") {}

const fail = (message: string) =>
  new OrchestratorMcpFailure({ code: "orchestration_error", message });

// A refused launch still prints one JSON receipt with `ok:false`. Surface its
// reason instead of only an exit code, so an unreachable catalog entry is
// actionable. T3X exits 2 for input refusals and 0 for a launch that failed
// inside the runner, so both paths read the same field.
const refusalMessage = (stdout: string): string | undefined => {
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "ok" in parsed &&
      parsed.ok === false &&
      "error" in parsed &&
      typeof parsed.error === "string" &&
      parsed.error.trim().length > 0
    ) {
      return parsed.error;
    }
    return undefined;
  } catch {
    return undefined;
  }
};

const cleanLaunch = (input: OrchestratorMcpT3xLaunchInput) => ({
  host: input.host,
  cli: input.cli,
  task: input.task,
  model: input.model,
  ...(input.effort === undefined ? {} : { effort: input.effort }),
  ...(input.role === undefined ? {} : { role: input.role }),
  ...(input.goal === undefined ? {} : { goal: input.goal }),
  ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
  ...(input.titleSource === undefined ? {} : { titleSource: input.titleSource }),
  ...(input.keepOpen === undefined ? {} : { keepOpen: input.keepOpen }),
  ...(input.workspace === undefined ? {} : { workspace: input.workspace }),
});

const make = (platform: NodeJS.Platform, environment: NodeJS.ProcessEnv) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const processRunner = yield* ProcessRunner.ProcessRunner;

    const isFile = (filePath: string) =>
      fileSystem.stat(filePath).pipe(
        Effect.map((info) => info.type === "File"),
        Effect.orElseSucceed(() => false),
      );

    const launch = Effect.fn("T3xBridgeService.launch")(function* (
      rawRequest: unknown,
    ): Effect.fn.Return<OrchestratorMcpT3xLaunchResult, OrchestratorMcpFailure> {
      const request = yield* Schema.decodeUnknownEffect(T3xBridgeRequest)(rawRequest).pipe(
        Effect.mapError(() => fail("Invalid T3X bridge request.")),
      );
      const isSameHostLaunch =
        (platform === "linux" && request.launch.host === "wsl") ||
        (platform === "win32" && request.launch.host === "win");
      if (isSameHostLaunch) {
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message:
            "T3X bridge launch is for cross-host work. Use native delegate_task for same-host child work.",
        });
      }
      const command = yield* resolveT3xCommand(platform, environment, isFile, path.join);
      const stdin = yield* Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Json))({
        requestKey: request.requestKey,
        parent: request.parent,
        launch: cleanLaunch(request.launch),
      }).pipe(Effect.mapError(() => fail("T3X bridge request is not valid JSON.")));
      const processResult = yield* processRunner
        .run({
          command: command.command,
          args: command.args,
          stdin: `${stdin}\n`,
          // This bounds only the local launch/bind handshake. The T3X bridge must
          // start remote work detached and return its receipt without waiting for it.
          timeout: "30 seconds",
          maxOutputBytes: 1024 * 1024,
        })
        .pipe(
          Effect.mapError((error) =>
            error._tag === "ProcessTimeoutError"
              ? fail("T3X bridge launch timed out.")
              : error._tag === "ProcessSpawnError"
                ? fail("T3X bridge executable is missing or could not be started.")
                : fail("T3X bridge process failed while reading or writing its result."),
          ),
        );
      const refusal = refusalMessage(processResult.stdout.trim());
      if (processResult.code !== 0) {
        return yield* fail(refusal ?? `T3X bridge exited with code ${String(processResult.code)}.`);
      }
      if (processResult.stdoutInvalidUtf8) {
        return yield* fail("T3X bridge returned malformed UTF-8 output.");
      }
      if (refusal !== undefined) {
        return yield* fail(refusal);
      }

      return yield* Schema.decodeEffect(Schema.fromJsonString(OrchestratorMcpT3xLaunchResult))(
        processResult.stdout.trim(),
      ).pipe(
        Effect.mapError(() =>
          fail("T3X bridge returned malformed JSON or a malformed launch result."),
        ),
      );
    });

    return T3xBridgeService.of({ launch });
  });

/** Test seam: the host platform and environment decide the launch command only. */
export const layerWith = (
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
): Layer.Layer<
  T3xBridgeService,
  never,
  Path.Path | FileSystem.FileSystem | ProcessRunner.ProcessRunner
> => Layer.effect(T3xBridgeService, make(platform, environment));

export const layer: Layer.Layer<
  T3xBridgeService,
  never,
  Path.Path | FileSystem.FileSystem | ProcessRunner.ProcessRunner
> = layerWith(process.platform, process.env);
