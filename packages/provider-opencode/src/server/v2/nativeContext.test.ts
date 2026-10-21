import { describe, it } from "@effect/vitest";
import { assert } from "@effect/vitest";
import * as SessionMessageSchema from "@opencode/schema/session-message";
import * as Schema from "effect/Schema";
import type { SessionMessage } from "@opencode/schema/session-message";

import { estimateNativeContext } from "./nativeContext.ts";

const decodeInfo = Schema.decodeUnknownSync(SessionMessageSchema.Info);
const decodeMessages = Schema.decodeUnknownSync(Schema.Array(SessionMessageSchema.Info));

const at = 1_790_656_600_000;

const checkpoint = (overrides: Record<string, unknown> = {}) => ({
  id: "msg_checkpoint",
  type: "compaction",
  status: "completed",
  reason: "manual",
  summary: "Earlier work is summarised here.",
  recent: "The retained recent tail.",
  time: { created: at },
  ...overrides,
});

const user = (overrides: Record<string, unknown> = {}) => ({
  id: "msg_user",
  type: "user",
  text: "Continue the work",
  time: { created: at + 1 },
  ...overrides,
});

const assistant = (content: ReadonlyArray<unknown>) => ({
  id: "msg_assistant",
  type: "assistant",
  agent: "build",
  model: { id: "big-pickle", providerID: "opencode" },
  content,
  time: { created: at + 2 },
});

const estimate = (messages: ReadonlyArray<unknown>, wireBytes = 1_000) =>
  estimateNativeContext(decodeMessages(messages), wireBytes);

describe("native active-context estimate", () => {
  it("counts the answer's wire bytes when the window starts at a plaintext compaction", () => {
    assert.equal(
      estimate([checkpoint(), user(), assistant([{ type: "text", text: "Done" }])]),
      1_000,
    );
  });

  it("keeps bytes a newer server sends but this build's schema drops", () => {
    const decoded = decodeMessages([checkpoint(), user()]);
    // 2.0.32 can add fields 2.0.28 does not know; only the wire size sees them.
    const wire = Buffer.byteLength(
      JSON.stringify({ data: [checkpoint(), user()], serverRevision: "x".repeat(5_000) }),
    );
    assert.equal(estimateNativeContext(decoded, wire), wire);
    assert.isAbove(wire, Buffer.byteLength(JSON.stringify({ data: [checkpoint(), user()] })));
  });

  it("declines a transcript that does not start at a completed plaintext compaction", () => {
    assert.isUndefined(estimate([user(), assistant([{ type: "text", text: "Done" }])]));
    assert.isUndefined(estimate([]));
    assert.isUndefined(estimate([checkpoint({ status: "running" })]));
    assert.isUndefined(
      estimate([checkpoint({ status: "failed", error: { type: "x", message: "" } })]),
    );
  });

  it("declines a provider-native checkpoint instead of sizing encrypted text", () => {
    assert.isUndefined(
      estimate([
        checkpoint({
          providerContext: {
            version: 1,
            provenance: {
              providerID: "anthropic",
              provider: "anthropic",
              modelID: "claude",
              route: "messages",
              protocol: "anthropic",
              endpoint: "https://example.invalid",
            },
            messages: [],
          },
        }),
      ]),
    );
    assert.isUndefined(estimate([checkpoint({ providerState: { ciphertext: "AAAA" } })]));
  });

  it("declines steps whose window this build cannot follow", () => {
    const switched = [
      { id: "msg_agent", type: "agent-switched", agent: "build", time: { created: at + 5 } },
      {
        id: "msg_model",
        type: "model-switched",
        model: { id: "big-pickle", providerID: "opencode" },
        time: { created: at + 5 },
      },
      {
        id: "msg_location",
        type: "location-switched",
        location: { directory: "/work" },
        time: { created: at + 5 },
      },
    ];
    for (const message of switched) assert.isUndefined(estimate([checkpoint(), message]));
    assert.isUndefined(
      estimate([
        checkpoint(),
        assistant([
          {
            type: "tool",
            id: "t",
            name: "read",
            providerState: {},
            time: { created: at + 6 },
            state: { status: "streaming", input: "{}" },
          },
        ]),
      ]),
    );
    // A message type from a newer server is not in the allowlist either.
    assert.isUndefined(
      estimateNativeContext(
        [
          { ...decodeInfo(user()), type: "future-message" },
        ] as unknown as ReadonlyArray<SessionMessage.Info>,
        1_000,
      ),
    );
  });

  it("reserves more for native images than for other files, counting duplicates", () => {
    const withFiles = estimate([
      checkpoint(),
      user({
        files: [
          { data: "aGVsbG8=", mime: "image/png", source: { type: "inline" } },
          { data: "aGVsbG8=", mime: "application/pdf", source: { type: "uri", uri: "file:///x" } },
          { data: "aGVsbG8=", mime: "image/png", source: { type: "inline" } },
        ],
      }),
      assistant([
        {
          type: "tool",
          id: "call_1",
          name: "read",
          time: { created: at + 7 },
          state: {
            status: "completed",
            input: {},
            content: [
              { type: "text", text: "read 1 file" },
              { type: "file", uri: "file:///shot.png", mime: "image/png" },
              { type: "file", uri: "file:///log.txt", mime: "text/plain" },
            ],
          },
        },
      ]),
    ]);
    // 3 images x 8192 + 2 other files x 4096, on top of the wire bytes.
    assert.equal(withFiles, 1_000 + 3 * 8_192 + 2 * 4_096);
  });

  it("declines opaque provider state on any message or part", () => {
    assert.isUndefined(
      estimate([
        checkpoint(),
        {
          ...assistant([{ type: "text", text: "answer" }]),
          providerState: { ciphertext: "AAAA" },
        },
      ]),
    );
    // A text or reasoning part's own `state` is provider-native, like a tool's.
    assert.isUndefined(
      estimate([
        checkpoint(),
        assistant([{ type: "text", text: "answer", state: { ciphertext: "AAAA" } }]),
      ]),
    );
    assert.isUndefined(
      estimate([
        checkpoint(),
        assistant([{ type: "reasoning", text: "thinking", state: { encrypted: true } }]),
      ]),
    );
    // A later compaction is held to the same predicate as the boundary.
    assert.isUndefined(
      estimate([
        checkpoint(),
        user(),
        {
          ...checkpoint({ id: "msg_checkpoint_2" }),
          providerState: { ciphertext: "AAAA" },
          time: { created: at + 8 },
        },
      ]),
    );
    assert.isUndefined(
      estimate([
        checkpoint(),
        assistant([
          {
            type: "tool",
            id: "t",
            name: "read",
            providerResultState: { encrypted: "AAAA" },
            time: { created: at + 9 },
            state: { status: "streaming", input: "{}" },
          },
        ]),
      ]),
    );
  });

  it("declines a file reference whose MIME string it cannot place", () => {
    assert.isUndefined(
      estimate([
        checkpoint(),
        user({ files: [{ data: "AAAA", mime: "not a mime", source: { type: "inline" } }] }),
      ]),
    );
    assert.isUndefined(
      estimate([
        checkpoint(),
        assistant([
          {
            type: "tool",
            id: "call_1",
            name: "read",
            time: { created: at + 7 },
            state: {
              status: "completed",
              input: {},
              content: [{ type: "file", uri: "file:///x", mime: "" }],
            },
          },
        ]),
      ]),
    );
    // An error tool result may carry files too; the same mapping applies.
    assert.equal(
      estimate([
        checkpoint(),
        assistant([
          {
            type: "tool",
            id: "call_1",
            name: "read",
            time: { created: at + 7 },
            state: {
              status: "error",
              input: {},
              error: { type: "too_large", message: "file too large" },
              content: [{ type: "file", uri: "file:///x.png", mime: "image/png" }],
            },
          },
        ]),
      ]),
      1_000 + 8_192,
    );
  });

  it("accepts the plaintext window the allowlist names", () => {
    assert.equal(
      estimate([
        checkpoint(),
        { ...user(), id: "msg_synthetic", type: "synthetic", text: "reminder" },
        { ...user(), id: "msg_system", type: "system", text: "system note" },
        {
          ...user(),
          id: "msg_skill",
          type: "skill",
          skill: "review",
          name: "review",
          text: "skill body",
        },
        {
          ...user(),
          id: "msg_shell",
          type: "shell",
          shellID: "sh_1",
          command: "ls",
          status: "exited",
          time: { created: at + 3 },
        },
        { ...user(), id: "msg_idle", type: "idle", outcome: "succeeded" },
        { ...checkpoint({ id: "msg_checkpoint_2" }), time: { created: at + 4 } },
        assistant([
          { type: "reasoning", text: "thinking" },
          { type: "text", text: "answer" },
        ]),
      ]),
      1_000,
    );
  });

  it("declines an answer with no bytes or a size it cannot hold", () => {
    assert.isUndefined(estimate([checkpoint()], 0));
    assert.isUndefined(estimate([checkpoint()], 1.5));
    assert.isUndefined(estimate([checkpoint()], Number.MAX_SAFE_INTEGER + 2));
  });
});
