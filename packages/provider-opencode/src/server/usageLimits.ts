import * as NodeSqlite from "node:sqlite";

import type { ServerProviderUsageWindow } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Hex from "effect/encoding/Hex";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import {
  clampPercent,
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "@t3tools/provider-core/server/usageLimits";
import * as HostProcess from "@t3tools/shared/HostProcess";

const AuthFile = Schema.Struct({ "opencode-go": Schema.optionalKey(Schema.Unknown) });
const ApiAuth = Schema.Struct({ type: Schema.Literal("api"), key: Schema.String });
const decodeAuthFile = Schema.decodeEffect(Schema.fromJsonString(AuthFile));
const decodeApiAuth = Schema.decodeUnknownOption(ApiAuth);
// OpenCode 2's database tags a stored key "key"; auth.json tags it "api".
const StoredKey = Schema.Struct({
  type: Schema.Literal("key"),
  key: Schema.String,
  metadata: Schema.optionalKey(
    Schema.NullOr(Schema.Struct({ server: Schema.optionalKey(Schema.Unknown) })),
  ),
});
const decodeStoredKey = Schema.decodeOption(Schema.fromJsonString(StoredKey));
const UsageWindow = Schema.Struct({
  percent: Schema.Finite,
  resetsAt: Schema.DateTimeUtcFromString,
});
const UsageResponse = Schema.Struct({
  usage: Schema.Struct({ rolling: UsageWindow, weekly: UsageWindow, monthly: UsageWindow }),
});

// A missing row and an unreadable database both yield "no key here", but only
// the first may fall through to another account: a read failure is not
// evidence that this account has no credential.
type StoredKeyRead =
  | { readonly _tag: "key"; readonly key: string }
  | { readonly _tag: "missing" }
  | { readonly _tag: "unreadable" };

// OpenCode 2 tags the Console connection "opencode" and a local Go login
// "opencode-go"; either can hold the key this probe needs. Select before
// decoding so an OAuth or self-hosted connection cannot fall through to
// another stored account. NULL-active rows predate the selection flag.
const readStoredApiKey = (databasePath: string, integrationId: "opencode" | "opencode-go") =>
  Effect.try(() => {
    const database = new NodeSqlite.DatabaseSync(databasePath, { readOnly: true });
    try {
      database.exec("PRAGMA busy_timeout = 100");
      const row = database
        .prepare(
          `SELECT value FROM credential
           WHERE integration_id = ? AND active IS NOT 0
           ORDER BY active DESC, time_created DESC, id DESC LIMIT 1`,
        )
        .get(integrationId);
      const stored =
        typeof row?.value === "string"
          ? Option.getOrUndefined(decodeStoredKey(row.value))
          : undefined;
      const server = stored?.metadata?.server;
      if (typeof server === "string") {
        const url = new URL(server);
        if (`${url.origin}${url.pathname.replace(/\/+$/, "")}` !== "https://opencode.ai/console")
          return undefined;
      }
      return stored?.key.trim();
    } finally {
      database.close();
    }
  }).pipe(
    Effect.map((key): StoredKeyRead => (key ? { _tag: "key", key } : { _tag: "missing" })),
    Effect.orElseSucceed((): StoredKeyRead => ({ _tag: "unreadable" })),
  );

/** External OpenCode servers own their credentials; never read the host's account for them. */
export const readOpenCodeGoUsageLimits = Effect.fn("readOpenCodeGoUsageLimits")(function* (input: {
  readonly enabled: boolean;
  readonly serverUrl: string;
  readonly environment: NodeJS.ProcessEnv;
}) {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const unsupported = makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" });
  if (!input.enabled || input.serverUrl.trim()) return unsupported;

  return yield* Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const env = input.environment;
    const dataHome =
      env.XDG_DATA_HOME ||
      path.join(
        env.HOME || env.USERPROFILE || (yield* HostProcess.HomeDirectory),
        ".local",
        "share",
      );
    const authPath = path.join(dataHome, "opencode", "auth.json");
    // A Go model request is served by the "opencode-go" credential and that is
    // the one rotation switches, so it answers the snapshot; the Console key
    // only speaks when no Go login is stored.
    const databaseFile = env.OPENCODE_DB ?? "opencode.db";
    const databasePath =
      env.OPENCODE_AUTH_CONTENT || databaseFile === ":memory:"
        ? undefined
        : path.resolve(dataHome, "opencode", databaseFile);
    // No database means no stored credential; an unreadable one is a failure,
    // not an empty account.
    const databaseExists = databasePath ? yield* fs.exists(databasePath) : false;
    const goRead: StoredKeyRead =
      databasePath && databaseExists
        ? yield* readStoredApiKey(databasePath, "opencode-go")
        : { _tag: "missing" };
    const consoleRead: StoredKeyRead =
      databasePath && databaseExists
        ? yield* readStoredApiKey(databasePath, "opencode")
        : { _tag: "missing" };
    // The stored account is the only one that reflects what the CLI will spend.
    // Publishing another source's numbers after a failed read is how a closed
    // window gets attributed to the wrong account.
    if (goRead._tag === "unreadable" || consoleRead._tag === "unreadable")
      return makeUnavailableUsageLimits({
        checkedAt,
        reason: "probeFailed",
        message: "OpenCode Go could not read its stored credential.",
      });
    const storedKeys = [goRead, consoleRead].flatMap((read) =>
      read._tag === "key" ? [read.key] : [],
    );
    // The file is the last resort, so a missing, unreadable or malformed one
    // must not stop the stored account from being reported.
    const goKey = yield* Effect.gen(function* () {
      const contents =
        env.OPENCODE_AUTH_CONTENT ||
        (yield* fs.readFileString(authPath).pipe(
          Effect.catchTags({
            PlatformError: (error) =>
              error.reason._tag === "NotFound" ? Effect.succeed("{}") : Effect.fail(error),
          }),
        ));
      const auth = yield* decodeAuthFile(contents);
      const apiAuth = decodeApiAuth(auth["opencode-go"]);
      // OpenCode overlays stored API credentials after environment credentials.
      return (Option.isSome(apiAuth) ? apiAuth.value.key : env.OPENCODE_API_KEY)?.trim();
    }).pipe(Effect.orElseSucceed(() => env.OPENCODE_API_KEY?.trim()));
    const [firstKey, ...otherKeys] = [...storedKeys, goKey].filter((key): key is string =>
      Boolean(key),
    );
    if (!firstKey) return unsupported;

    const client = yield* HttpClient.HttpClient;
    const readUsage = (key: string) =>
      client.execute(
        HttpClientRequest.get("https://opencode.ai/zen/go/v1/usage").pipe(
          HttpClientRequest.bearerToken(key),
        ),
      );
    // 401 rejects this credential and 403 rejects Go entitlement; a later
    // source can still hold a usable key, so only a decisive answer stops.
    let apiKey = firstKey;
    let response = yield* readUsage(apiKey);
    for (const key of otherKeys) {
      if (response.status !== 401 && response.status !== 403) break;
      if (key === apiKey) continue;
      apiKey = key;
      response = yield* readUsage(apiKey);
    }
    // A valid Zen key can exist without a Go subscription.
    if (response.status === 403) return unsupported;
    const body = yield* HttpClientResponse.filterStatusOk(response).pipe(
      Effect.flatMap(HttpClientResponse.schemaBodyJson(UsageResponse)),
    );
    const windows: ServerProviderUsageWindow[] = [
      {
        id: "go_rolling",
        kind: "session",
        label: "Go · Session",
        windowDurationMins: 5 * 60,
        usedPercent: clampPercent(body.usage.rolling.percent),
        resetsAt: DateTime.formatIso(body.usage.rolling.resetsAt),
      },
      {
        id: "go_weekly",
        kind: "weekly",
        label: "Go · Weekly",
        windowDurationMins: 7 * 24 * 60,
        usedPercent: clampPercent(body.usage.weekly.percent),
        resetsAt: DateTime.formatIso(body.usage.weekly.resetsAt),
      },
      {
        id: "go_monthly",
        kind: "monthly",
        label: "Go · Monthly",
        usedPercent: clampPercent(body.usage.monthly.percent),
        resetsAt: DateTime.formatIso(body.usage.monthly.resetsAt),
      },
    ];
    const crypto = yield* Crypto.Crypto;
    // An unkeyed hash matches across environments without a shared secret. It
    // permits offline guesses, but Go keys are randomly generated.
    const credentialFingerprint = yield* crypto
      .digest("SHA-256", new TextEncoder().encode(`opencode-go\0${apiKey}`))
      .pipe(Effect.map(Hex.encode), Effect.orDie);
    return {
      ...makeUsageLimits({ checkedAt, windows }),
      credentialFingerprint,
    };
  }).pipe(
    Effect.timeout("5 seconds"),
    Effect.orElseSucceed(() =>
      makeUnavailableUsageLimits({
        checkedAt,
        reason: "probeFailed",
        message: "OpenCode Go could not read usage.",
      }),
    ),
  );
});
