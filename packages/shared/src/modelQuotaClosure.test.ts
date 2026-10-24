import type { ProviderDriverKind, ServerProviderUsageLimits } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { modelClosedUntil } from "./modelQuotaClosure.ts";

const driver = (value: string) => value as ProviderDriverKind;
const NOW = Date.parse("2026-10-24T12:00:00.000Z");
const LATER = "2026-10-24T17:00:00.000Z";
const WEEK = "2026-10-31T12:00:00.000Z";

function limits(
  windows: ServerProviderUsageLimits["windows"],
  unavailable?: ServerProviderUsageLimits["unavailable"],
): ServerProviderUsageLimits {
  return {
    checkedAt: "2026-10-01T00:00:00.000Z",
    windows,
    ...(unavailable === undefined ? {} : { unavailable }),
  };
}

function window(
  id: string,
  usedPercent: number,
  resetsAt?: string,
): ServerProviderUsageLimits["windows"][number] {
  return {
    id,
    kind: "weekly",
    label: id,
    usedPercent,
    ...(resetsAt === undefined ? {} : { resetsAt }),
  };
}

describe("modelClosedUntil", () => {
  it("keeps a future full window closed however old the reading is", () => {
    expect(
      modelClosedUntil({
        driver: driver("codex"),
        modelId: "gpt-6-luna",
        limits: limits([window("primary", 100, LATER)]),
        nowMs: NOW,
      }),
    ).toBe(LATER);
  });

  it("opens a full window whose reset has passed", () => {
    expect(
      modelClosedUntil({
        driver: driver("codex"),
        modelId: "gpt-6-luna",
        limits: limits([window("primary", 100, "2026-10-24T11:00:00.000Z")]),
        nowMs: NOW,
      }),
    ).toBeUndefined();
  });

  it("does not close a full window that has no reset time", () => {
    expect(
      modelClosedUntil({
        driver: driver("claudeAgent"),
        modelId: "claude-haiku-5-5",
        limits: limits([window("five_hour", 100)]),
        nowMs: NOW,
      }),
    ).toBeUndefined();
  });

  it("closes only OpenCode Go models from Go windows", () => {
    const go = limits([window("go_weekly", 100, WEEK)]);
    expect(
      modelClosedUntil({
        driver: driver("opencode"),
        modelId: "opencode-go/deepseek-v4.1-flash",
        limits: go,
        nowMs: NOW,
      }),
    ).toBe(WEEK);
    expect(
      modelClosedUntil({
        driver: driver("opencode"),
        modelId: "xai/grok-4.7",
        limits: go,
        nowMs: NOW,
      }),
    ).toBeUndefined();
  });

  it("closes Cursor Auto, Grok and Composer from the overall pool only", () => {
    const overall = limits([window("totalPercentUsed", 100, WEEK)]);
    expect(
      modelClosedUntil({
        driver: driver("cursor"),
        modelId: "default",
        limits: overall,
        nowMs: NOW,
      }),
    ).toBe(WEEK);
    expect(
      modelClosedUntil({
        driver: driver("cursor"),
        modelId: "grok-4.7",
        limits: overall,
        nowMs: NOW,
      }),
    ).toBe(WEEK);
    expect(
      modelClosedUntil({
        driver: driver("cursor"),
        modelId: "claude-opus-5-5",
        limits: overall,
        nowMs: NOW,
      }),
    ).toBeUndefined();
  });

  it("does not close anything from the Cursor Auto pool alone", () => {
    const auto = limits([window("autoPercentUsed", 100, WEEK)]);
    expect(
      modelClosedUntil({ driver: driver("cursor"), modelId: "default", limits: auto, nowMs: NOW }),
    ).toBeUndefined();
    expect(
      modelClosedUntil({ driver: driver("cursor"), modelId: "grok-4.7", limits: auto, nowMs: NOW }),
    ).toBeUndefined();
  });

  it("closes Cursor Claude, GPT and Gemini from the API pool", () => {
    const api = limits([window("apiPercentUsed", 100, WEEK)]);
    expect(
      modelClosedUntil({
        driver: driver("cursor"),
        modelId: "claude-opus-5-5",
        limits: api,
        nowMs: NOW,
      }),
    ).toBe(WEEK);
    expect(
      modelClosedUntil({ driver: driver("cursor"), modelId: "grok-4.7", limits: api, nowMs: NOW }),
    ).toBeUndefined();
  });

  it("matches a Claude display-name window to the model id", () => {
    const fable = limits([window("seven_day_fable", 100, WEEK)]);
    expect(
      modelClosedUntil({
        driver: driver("claudeAgent"),
        modelId: "claude-fable-5",
        limits: fable,
        nowMs: NOW,
      }),
    ).toBe(WEEK);
    expect(
      modelClosedUntil({
        driver: driver("claudeAgent"),
        modelId: "claude-haiku-5-5",
        limits: fable,
        nowMs: NOW,
      }),
    ).toBeUndefined();
  });

  it("closes every Claude model from the account session window", () => {
    expect(
      modelClosedUntil({
        driver: driver("claudeAgent"),
        modelId: "claude-haiku-5-5",
        limits: limits([window("five_hour", 100, LATER)]),
        nowMs: NOW,
      }),
    ).toBe(LATER);
  });

  it("ignores an unsupported account and an unrecognised window", () => {
    expect(
      modelClosedUntil({
        driver: driver("codex"),
        modelId: "gpt-6-luna",
        limits: limits([window("primary", 100, LATER)], { reason: "unsupported" }),
        nowMs: NOW,
      }),
    ).toBeUndefined();
    expect(
      modelClosedUntil({
        driver: driver("codex"),
        modelId: "gpt-6-luna",
        limits: limits([window("mystery", 100, LATER)]),
        nowMs: NOW,
      }),
    ).toBeUndefined();
  });

  it("keeps a full window visible when an earlier probe failed", () => {
    expect(
      modelClosedUntil({
        driver: driver("codex"),
        modelId: "gpt-6-luna",
        limits: limits([window("secondary", 100, WEEK)], { reason: "probeFailed" }),
        nowMs: NOW,
      }),
    ).toBe(WEEK);
  });
});
