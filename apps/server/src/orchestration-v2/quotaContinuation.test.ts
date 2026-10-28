import { describe, expect, it } from "vite-plus/test";

import {
  type CheapProviderSnapshot,
  type CheapTarget,
  type ContinuationObservation,
  type QuotaSwitchState,
  isSessionOpenFailure,
  nextCheapContinuation,
  resolveCheapTargets,
  stoppedQuotaSwitch,
} from "./quotaContinuation.ts";

const OPEN = ["opencode", "cursor", "codex", "claudeAgent"];

function provider(
  instanceId: string,
  driver: string,
  models: ReadonlyArray<string>,
  overrides: Partial<CheapProviderSnapshot> = {},
): CheapProviderSnapshot {
  return {
    instanceId,
    driver,
    enabled: true,
    installed: true,
    status: "ready",
    models: models.map((slug) => ({ slug })),
    ...overrides,
  };
}

function targets(closed: ReadonlyArray<string> = []): ReadonlyArray<CheapTarget> {
  return resolveCheapTargets(
    [
      provider("opencode", "opencode", ["opencode-go/deepseek-v4.1-flash", "xai/grok-4.7"]),
      provider("cursor", "cursor", ["default", "claude-opus-5-5", "grok-4.7"]),
      provider("codex", "codex", ["gpt-6-luna", "gpt-6-astra", "gpt-6.1-sol"]),
      provider("claudeAgent", "claudeAgent", [
        "claude-haiku-5-5",
        "claude-sonnet-5-5",
        "claude-opus-5-5",
      ]),
    ],
    new Set(closed),
  );
}

function observation(overrides: Partial<ContinuationObservation> = {}): ContinuationObservation {
  return {
    latestRunId: "run-1",
    latestInstanceId: "codex",
    latestRunStarted: true,
    sessionOpenFailure: false,
    latestErrorClass: "usage_limit",
    ...overrides,
  };
}

function decide(input: {
  readonly sourceInstanceId?: string;
  readonly closed?: ReadonlyArray<string>;
  readonly switchState?: QuotaSwitchState | null;
  readonly observation?: Partial<ContinuationObservation>;
  readonly snoozed?: boolean;
  readonly rows?: ReadonlyArray<CheapTarget>;
}) {
  return nextCheapContinuation({
    sourceInstanceId: input.sourceInstanceId ?? "codex",
    sourceRunId: "run-1",
    switchState: input.switchState ?? null,
    observation: observation(input.observation),
    targets: input.rows ?? targets(input.closed),
    snoozed: input.snoozed ?? false,
  });
}

describe("resolveCheapTargets", () => {
  it("offers only the four cheap models, in order", () => {
    expect(targets().map((row) => [row.instanceId, row.model, row.open])).toEqual([
      ["opencode", "opencode-go/deepseek-v4.1-flash", true],
      ["cursor", "default", true],
      ["codex", "gpt-6-luna", true],
      ["claudeAgent", "claude-haiku-5-5", true],
    ]);
  });

  it("treats a missing, disabled, or unready provider as closed", () => {
    const rows = resolveCheapTargets(
      [
        provider("opencode", "opencode", ["opencode-go/deepseek-v4.1-flash"], { enabled: false }),
        provider("cursor", "cursor", ["default"], { status: "error" }),
        provider("codex", "codex", ["gpt-6.1-sol"]),
      ],
      new Set(),
    );
    expect(rows.map((row) => row.open)).toEqual([false, false, false, false]);
  });

  it("uses the single instance of a driver when the preferred id is absent", () => {
    const rows = resolveCheapTargets(
      [provider("opencode-home", "opencode", ["opencode-go/deepseek-v4.1-flash"])],
      new Set(),
    );
    expect(rows[0]).toEqual({
      instanceId: "opencode-home",
      model: "opencode-go/deepseek-v4.1-flash",
      open: true,
      effort: null,
    });
  });

  it("does not guess when two instances share a driver", () => {
    const rows = resolveCheapTargets(
      [
        provider("opencode-a", "opencode", ["opencode-go/deepseek-v4.1-flash"]),
        provider("opencode-b", "opencode", ["opencode-go/deepseek-v4.1-flash"]),
      ],
      new Set(),
    );
    expect(rows[0]?.open).toBe(false);
  });

  it("accepts Cursor auto as the cheap default row and still names that row default", () => {
    const rows = resolveCheapTargets([provider("cursor", "cursor", ["auto"])], new Set());
    expect(rows[1]).toEqual({ instanceId: "cursor", model: "default", open: true, effort: null });
  });

  it("keeps volume rows on the model default and raises Luna and Haiku to high", () => {
    const rows = targets();
    expect(rows.map((row) => row.effort)).toEqual([
      null,
      null,
      { id: "reasoningEffort", value: "high" },
      { id: "effort", value: "high" },
    ]);
    expect(JSON.stringify(rows)).not.toMatch(/xhigh|ultrathink|ultra|max/);
  });
});

describe("nextCheapContinuation", () => {
  it("continues a Codex limit on OpenCode Go flash in the same decision", () => {
    expect(decide({})).toMatchObject({
      type: "dispatch",
      instanceId: "opencode",
      model: "opencode-go/deepseek-v4.1-flash",
      effort: null,
    });
  });

  it("gives Luna and Haiku high effort only when the cheaper rows are closed", () => {
    expect(decide({ sourceInstanceId: "opencode", closed: ["opencode", "cursor"] })).toMatchObject({
      type: "dispatch",
      model: "gpt-6-luna",
      effort: { id: "reasoningEffort", value: "high" },
    });
    expect(decide({ sourceInstanceId: "codex", closed: ["opencode", "cursor", "codex"] })).toMatchObject({
      type: "dispatch",
      model: "claude-haiku-5-5",
      effort: { id: "effort", value: "high" },
    });
  });

  it("waits for the Codex reset when every other row is closed and never picks Sol", () => {
    const decision = decide({ closed: OPEN.filter((id) => id !== "codex") });
    expect(decision).toEqual({ type: "none" });
    expect(targets().some((row) => row.model.includes("sol"))).toBe(false);
  });

  it("walks to Cursor default when the OpenCode session fails to open", () => {
    const pending: QuotaSwitchState = {
      sourceRunId: "run-1",
      sourceInstanceId: "codex",
      pendingInstanceId: "opencode",
      triedInstanceIds: [],
      opened: false,
    };
    expect(
      decide({
        switchState: pending,
        observation: {
          latestRunId: "run-2",
          latestInstanceId: "opencode",
          latestRunStarted: false,
          sessionOpenFailure: true,
          latestErrorClass: "provider_error",
        },
      }),
    ).toMatchObject({ type: "dispatch", instanceId: "cursor", model: "default", effort: null });
  });

  it("stops the walk when the continuation itself hits a usage limit", () => {
    const pending: QuotaSwitchState = {
      sourceRunId: "run-1",
      sourceInstanceId: "codex",
      pendingInstanceId: "opencode",
      triedInstanceIds: [],
      opened: false,
    };
    expect(
      decide({
        switchState: pending,
        observation: {
          latestRunId: "run-2",
          latestInstanceId: "opencode",
          latestRunStarted: true,
          latestErrorClass: "usage_limit",
        },
      }),
    ).toMatchObject({ type: "mark-opened", quotaSwitch: { opened: true } });
  });

  it("does not switch provider on a transport error", () => {
    const pending: QuotaSwitchState = {
      sourceRunId: "run-1",
      sourceInstanceId: "codex",
      pendingInstanceId: "opencode",
      triedInstanceIds: [],
      opened: false,
    };
    expect(
      decide({
        switchState: pending,
        observation: {
          latestRunId: "run-2",
          latestInstanceId: "opencode",
          latestRunStarted: false,
          sessionOpenFailure: false,
          latestErrorClass: "transport_error",
        },
      }),
    ).toEqual({ type: "none" });
  });

  it("tries the next open row when the pending row closes before its run exists", () => {
    const pending: QuotaSwitchState = {
      sourceRunId: "run-1",
      sourceInstanceId: "codex",
      pendingInstanceId: "opencode",
      triedInstanceIds: [],
      opened: false,
    };
    expect(
      decide({
        switchState: pending,
        closed: ["opencode"],
        observation: { latestRunId: "run-1", latestInstanceId: "codex" },
      }),
    ).toMatchObject({ type: "dispatch", instanceId: "cursor", model: "default", effort: null });
  });

  it("retries the same cheap row until that run exists", () => {
    const pending: QuotaSwitchState = {
      sourceRunId: "run-1",
      sourceInstanceId: "codex",
      pendingInstanceId: "opencode",
      triedInstanceIds: [],
      opened: false,
    };
    expect(
      decide({
        switchState: pending,
        observation: { latestRunId: "run-1", latestInstanceId: "codex" },
      }),
    ).toMatchObject({ type: "dispatch", instanceId: "opencode", model: "opencode-go/deepseek-v4.1-flash" });
  });

  it("does not start a walk for a snoozed thread", () => {
    expect(decide({ snoozed: true })).toEqual({ type: "none" });
  });

  it("does not dispatch a model that is not on the allowlist", () => {
    expect(
      decide({
        rows: [{ instanceId: "codex", model: "gpt-6.1-sol", open: true }],
      }),
    ).toEqual({ type: "none" });
  });
});

describe("stoppedQuotaSwitch", () => {
  it("cancels an armed walk even when the hop run does not exist yet", () => {
    expect(
      stoppedQuotaSwitch({
        sourceRunId: "run-1",
        sourceInstanceId: "codex",
        pendingInstanceId: "opencode",
        triedInstanceIds: [],
        opened: false,
      }),
    ).toEqual({
      sourceRunId: "run-1",
      sourceInstanceId: "codex",
      pendingInstanceId: null,
      triedInstanceIds: [],
      opened: true,
    });
    expect(
      stoppedQuotaSwitch({
        sourceRunId: "run-1",
        sourceInstanceId: "codex",
        pendingInstanceId: null,
        triedInstanceIds: ["opencode"],
        opened: true,
      })?.opened,
    ).toBe(true);
  });
});

describe("isSessionOpenFailure", () => {
  it("matches only the session-open title before the run starts", () => {
    expect(
      isSessionOpenFailure({
        title: "Provider session failed to open",
        errorClass: "provider_error",
        started: false,
      }),
    ).toBe(true);
    expect(
      isSessionOpenFailure({
        title: "Provider error",
        errorClass: "transport_error",
        started: false,
      }),
    ).toBe(false);
    expect(
      isSessionOpenFailure({
        title: "Provider session failed to open",
        errorClass: "provider_error",
        started: true,
      }),
    ).toBe(false);
  });
});
