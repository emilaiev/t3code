import { OpenCode, type OpenCodeClient } from "@opencode/client/effect";
import { OpenCodeEvent } from "@opencode/protocol/groups/event";
import { collectUint8StreamText } from "@t3tools/provider-core/server/collectStreamText";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Sse from "effect/encoding/Sse";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

/** OpenCode 2 accepts only HTTP Basic auth, always with this user name. */
const OPENCODE_USERNAME = "opencode";

export interface OpenCode2UnreadableTerminal {
  readonly type: "unreadable.execution.ended";
  readonly executionType: (typeof EXECUTION_ENDS)[number];
  readonly sessionID: string;
}

export interface OpenCode2UnreadableStart {
  readonly type: "unreadable.execution.started";
  readonly sessionID: string;
}

const EXECUTION_ENDS = [
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
] as const;
const isExecutionEnd = (type: string): type is (typeof EXECUTION_ENDS)[number] =>
  (EXECUTION_ENDS as ReadonlyArray<string>).includes(type);

export class OpenCode2SilentStreamError extends Schema.TaggedError<OpenCode2SilentStreamError>()(
  "OpenCode2SilentStreamError",
  {},
) {
  override get message(): string {
    return "The OpenCode server stopped sending events.";
  }
}

export type OpenCode2StreamEvent =
  | OpenCodeEvent
  | OpenCode2UnreadableTerminal
  | OpenCode2UnreadableStart;

/**
 * `events` succeeds once the server accepted the subscription: the stream is
 * volatile, so callers subscribe before they start work whose events they need.
 */
export interface OpenCode2Api {
  readonly client: OpenCodeClient;
  /**
   * A client on the same authenticated transport that reads each answer whole, up
   * to `maxBytes`, before the protocol decodes it. A body cut at the cap or not
   * UTF-8 fails here rather than decoding as something shorter, and `bytes`
   * holds the wire size of the answer it rebuilt: the protocol drops fields it
   * does not know, so its own values cannot say how much actually arrived.
   */
  readonly cappedClient: (options: {
    readonly maxBytes: number;
    readonly bytes: Ref.Ref<number>;
  }) => Effect.Effect<OpenCodeClient>;
  readonly events: Effect.Effect<
    Stream.Stream<
      OpenCode2StreamEvent,
      HttpClientError.HttpClientError | Sse.Retry | Sse.SseError | OpenCode2SilentStreamError
    >,
    HttpClientError.HttpClientError
  >;
}

export class OpenCode2Client extends Context.Service<
  OpenCode2Client,
  {
    readonly connect: (input: {
      readonly baseUrl: string;
      readonly password: string | Redacted.Redacted;
    }) => Effect.Effect<OpenCode2Api>;
  }
>()("@t3tools/provider-opencode/server/v2/OpenCode2Client") {}

/**
 * OpenCode writes a `: heartbeat` comment every 10 to 15 seconds, so this long
 * without a single byte means the server is stuck, not idle.
 */
const SILENT_STREAM_TIMEOUT = "45 seconds";

const decodeEvent = Schema.decodeUnknownResult(Schema.fromJsonString(OpenCodeEvent));
const decodeEnvelope = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      type: Schema.String,
      data: Schema.optional(Schema.Struct({ sessionID: Schema.optional(Schema.String) })),
    }),
  ),
);

// Rejected stream frames can be frequent when the server introduces new event types.
const undecodable = Effect.fnUntraced(function* (data: string) {
  const envelope = decodeEnvelope(data);
  const type = envelope._tag === "Some" ? envelope.value.type.slice(0, 80) : "<unreadable>";
  const sessionID = envelope._tag === "Some" ? envelope.value.data?.sessionID : undefined;
  if (isExecutionEnd(type) && sessionID !== undefined) {
    yield* Effect.logWarning(
      "Ended an OpenCode execution from an event this build cannot decode.",
      {
        type,
      },
    );
    return Result.succeed<OpenCode2StreamEvent>({
      type: "unreadable.execution.ended",
      executionType: type,
      sessionID,
    });
  }
  if (type === "session.execution.started" && sessionID !== undefined) {
    yield* Effect.logDebug("Read an OpenCode execution start this build cannot decode.");
    return Result.succeed<OpenCode2StreamEvent>({
      type: "unreadable.execution.started",
      sessionID,
    });
  }
  yield* Effect.logDebug("Skipped an OpenCode event this build cannot decode.", { type });
  return Result.failVoid;
});

const readEvents = HttpClient.get("/api/event", {
  headers: { accept: "text/event-stream" },
}).pipe(
  Effect.flatMap(HttpClientResponse.filterStatusOk),
  Effect.map((response) =>
    response.stream.pipe(
      Stream.timeoutOrElse({
        duration: SILENT_STREAM_TIMEOUT,
        orElse: () => Stream.fail(new OpenCode2SilentStreamError()),
      }),
      Stream.decodeText,
      Stream.pipeThroughChannel(Sse.decode()),
      Stream.filterMapEffect((frame) => {
        const decoded = decodeEvent(frame.data);
        return Result.isSuccess(decoded)
          ? Effect.succeed(Result.succeed<OpenCode2StreamEvent>(decoded.success))
          : undecodable(frame.data);
      }),
    ),
  ),
);

/**
 * OpenCode decodes Basic credentials as UTF-8. `HttpClientRequest.basicAuth`
 * encodes them as Latin-1 (`btoa`), which gets non-ASCII passwords rejected.
 */
const basicAuthorization = (password: string | Redacted.Redacted) => {
  const plain = Redacted.isRedacted(password) ? Redacted.value(password) : password;
  return `Basic ${Buffer.from(`${OPENCODE_USERNAME}:${plain}`, "utf8").toString("base64")}`;
};

/**
 * Reads each answer whole, up to `maxBytes`, and hands the protocol a body built
 * from exactly those bytes. `collectUint8StreamText` keeps draining past the cap
 * without buffering more, so callers must still bound the whole request.
 */
const capResponseBody = (
  client: HttpClient.HttpClient,
  options: { readonly maxBytes: number; readonly bytes: Ref.Ref<number> },
) =>
  HttpClient.transformResponse(client, (effect) =>
    Effect.flatMap(effect, (response) =>
      collectUint8StreamText({ stream: response.stream, maxBytes: options.maxBytes }).pipe(
        Effect.catchIf(
          (error) => error.reason._tag === "EmptyBodyError",
          () => Effect.succeed({ text: "", truncated: false, bytes: 0, invalidUtf8: false }),
        ),
        Effect.flatMap((collected) =>
          collected.truncated || collected.invalidUtf8
            ? Effect.fail(
                new HttpClientError.HttpClientError({
                  reason: new HttpClientError.DecodeError({
                    request: response.request,
                    response,
                    description: collected.truncated
                      ? `The answer is longer than ${options.maxBytes} bytes.`
                      : "The answer is not UTF-8 text.",
                  }),
                }),
              )
            : Ref.set(options.bytes, collected.bytes).pipe(
                Effect.as(
                  HttpClientResponse.fromWeb(
                    response.request,
                    new Response(collected.text === "" ? null : collected.text, {
                      status: response.status,
                      headers: response.headers,
                    }),
                  ),
                ),
              ),
        ),
      ),
    ),
  );

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const httpClient = yield* HttpClient.HttpClient;
  return OpenCode2Client.of({
    connect: ({ baseUrl, password }) => {
      const authenticated = HttpClient.mapRequest(
        httpClient,
        HttpClientRequest.setHeader("Authorization", basicAuthorization(password)),
      );
      const makeClient = (transport: HttpClient.HttpClient) =>
        OpenCode.make({ baseUrl }).pipe(Effect.provideService(HttpClient.HttpClient, transport));
      return makeClient(authenticated).pipe(
        Effect.map((client) => ({
          client,
          cappedClient: (options) => makeClient(capResponseBody(authenticated, options)),
          events: readEvents.pipe(
            Effect.provideService(
              HttpClient.HttpClient,
              HttpClient.mapRequest(authenticated, HttpClientRequest.prependUrl(baseUrl)),
            ),
          ),
        })),
      );
    },
  });
});

export const layer = Layer.effect(OpenCode2Client, make);

/**
 * The first request carries the caller's input (including `order`); later
 * requests send only the cursor, because OpenCode rejects a cursor combined
 * with `order`.
 */
export const paginate = <Input extends { readonly cursor?: unknown }, Item, E, R>(
  input: Input,
  list: (
    input: Input,
  ) => Effect.Effect<
    { readonly data: ReadonlyArray<Item>; readonly cursor: { readonly next?: Input["cursor"] } },
    E,
    R
  >,
): Stream.Stream<Item, E, R> =>
  Stream.paginate(input, (request) =>
    list(request).pipe(
      Effect.map(
        (page) =>
          [
            page.data,
            page.data.length === 0 || page.cursor.next === undefined
              ? Option.none()
              : Option.some({ ...request, order: undefined, cursor: page.cursor.next }),
          ] as const,
      ),
    ),
  );
