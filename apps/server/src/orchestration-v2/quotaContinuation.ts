/**
 * Same-thread continuation after a usage limit.
 *
 * The walk is a fixed cheap allowlist. The first open row wins. The current
 * provider is skipped, a provider already left is not retried, and a premium
 * model is never a row. Codex Luna and Sol share one pool, so a closed Codex
 * window has no second Codex row to escape into.
 *
 * A hop whose session actually opens is the last automatic move. A hop that
 * dies before the session opens tries the next row. A hop that itself hits a
 * usage limit stops the walk. Transport and other provider errors do not.
 *
 * Flash and Cursor Auto keep the model's own effort. Luna and Haiku are the
 * rows that take over harder work, so they run at high. That is the worker
 * level: not extra-high, max, or a premium model.
 */

export const SESSION_OPEN_FAILURE_TITLE = "Provider session failed to open";

const CHEAP_ROWS = [
  {
    driver: "opencode",
    instanceId: "opencode",
    model: "opencode-go/deepseek-v4.1-flash",
    effort: null,
  },
  { driver: "cursor", instanceId: "cursor", model: "default", effort: null },
  {
    driver: "codex",
    instanceId: "codex",
    model: "gpt-6-luna",
    effort: { id: "reasoningEffort", value: "high" },
  },
  {
    driver: "claudeAgent",
    instanceId: "claudeAgent",
    model: "claude-haiku-5-5",
    effort: { id: "effort", value: "high" },
  },
] as const;

export const CHEAP_CONTINUATION_MODELS = CHEAP_ROWS.map((row) => row.model);

export type CheapProviderSnapshot = {
  readonly instanceId: string;
  readonly driver: string;
  readonly enabled: boolean;
  readonly installed: boolean;
  readonly status: string;
  readonly models: ReadonlyArray<{ readonly slug: string }>;
};

export type CheapEffort = { readonly id: string; readonly value: "high" };

export type CheapTarget = {
  readonly instanceId: string;
  readonly model: string;
  readonly open: boolean;
  readonly effort?: CheapEffort | null;
};

export type QuotaSwitchState = {
  readonly sourceRunId: string;
  readonly sourceInstanceId: string;
  readonly pendingInstanceId: string | null;
  readonly triedInstanceIds: ReadonlyArray<string>;
  readonly opened: boolean;
};

export type ContinuationObservation = {
  readonly latestRunId: string;
  readonly latestInstanceId: string;
  readonly latestRunStarted: boolean;
  readonly sessionOpenFailure: boolean;
  readonly latestErrorClass: string | null;
};

export type CheapDecision =
  | {
      readonly type: "dispatch";
      readonly instanceId: string;
      readonly model: string;
      readonly effort: CheapEffort | null;
      readonly quotaSwitch: QuotaSwitchState;
    }
  | { readonly type: "mark-opened"; readonly quotaSwitch: QuotaSwitchState }
  | { readonly type: "none" };

/** Stop cancels an armed walk, including one whose hop run does not exist yet. */
export function stoppedQuotaSwitch<T extends QuotaSwitchState>(
  prior: T | null | undefined,
): T | null {
  if (prior == null) return null;
  if (prior.opened) return prior;
  return { ...prior, pendingInstanceId: null, opened: true };
}

export function isSessionOpenFailure(input: {
  readonly title: string | null;
  readonly errorClass: string | null;
  readonly started: boolean;
}): boolean {
  return (
    !input.started &&
    input.errorClass === "provider_error" &&
    input.title === SESSION_OPEN_FAILURE_TITLE
  );
}

/**
 * Four rows, in order. A preferred instance id wins. One other instance of
 * that driver is used when the preferred id is absent. Two instances and no
 * preferred id is skipped rather than guessed. A missing, disabled, or
 * unlisted model is not open. `closedInstanceIds` is the pool result from
 * `modelClosedUntil`; an id that was not checked is not treated as open.
 */
export function resolveCheapTargets(
  providers: ReadonlyArray<CheapProviderSnapshot>,
  closedInstanceIds: ReadonlySet<string>,
): ReadonlyArray<CheapTarget> {
  return CHEAP_ROWS.map((row) => {
    const exact = providers.find(
      (provider) => provider.instanceId === row.instanceId && provider.driver === row.driver,
    );
    const sameDriver = providers.filter((provider) => provider.driver === row.driver);
    const provider = exact ?? (sameDriver.length === 1 ? sameDriver[0] : undefined);
    const instanceId = provider?.instanceId ?? row.instanceId;
    const usable =
      provider !== undefined &&
      provider.enabled &&
      provider.installed &&
      (provider.status === "ready" || provider.status === "warning") &&
      hasCheapModel(provider, row.model);
    return {
      instanceId,
      model: row.model,
      open: usable && !closedInstanceIds.has(instanceId),
      effort: row.effort,
    };
  });
}

export function nextCheapContinuation(input: {
  readonly sourceInstanceId: string;
  readonly sourceRunId: string;
  readonly switchState: QuotaSwitchState | null;
  readonly observation: ContinuationObservation;
  readonly targets: ReadonlyArray<CheapTarget>;
  readonly snoozed: boolean;
}): CheapDecision {
  const state = input.switchState;
  if (state?.opened) return { type: "none" };
  if (input.snoozed && state?.pendingInstanceId == null) return { type: "none" };

  const sourceInstanceId = state?.sourceInstanceId ?? input.sourceInstanceId;
  const pendingId = state?.pendingInstanceId ?? null;
  if (pendingId !== null && input.observation.latestRunId === state?.sourceRunId) {
    const pending = openTarget(input.targets, pendingId);
    if (pending) {
      return {
        type: "dispatch",
        instanceId: pending.instanceId,
        model: pending.model,
        effort: pending.effort ?? null,
        quotaSwitch: state!,
      };
    }
    // The chosen row closed before its run existed. The loop below tries the next open row.
  } else if (pendingId !== null) {
    if (input.observation.latestInstanceId === pendingId) {
      if (input.observation.latestRunStarted || input.observation.latestErrorClass === "usage_limit") {
        return {
          type: "mark-opened",
          quotaSwitch: { ...state!, pendingInstanceId: null, opened: true },
        };
      }
      if (!input.observation.sessionOpenFailure) return { type: "none" };
    } else {
      return { type: "none" };
    }
  }

  const tried = new Set(state?.triedInstanceIds ?? []);
  if (state?.pendingInstanceId) tried.add(state.pendingInstanceId);
  for (const target of input.targets) {
    if (!target.open || !isAllowlistedModel(target.model)) continue;
    if (target.instanceId === sourceInstanceId) continue;
    if (tried.has(target.instanceId)) continue;
    return {
      type: "dispatch",
      instanceId: target.instanceId,
      model: target.model,
      effort: target.effort ?? null,
      quotaSwitch: {
        sourceRunId: state?.sourceRunId ?? input.sourceRunId,
        sourceInstanceId,
        pendingInstanceId: target.instanceId,
        triedInstanceIds: [...tried],
        opened: false,
      },
    };
  }
  return { type: "none" };
}

function openTarget(
  targets: ReadonlyArray<CheapTarget>,
  instanceId: string,
): CheapTarget | undefined {
  return targets.find(
    (target) =>
      target.instanceId === instanceId && target.open && isAllowlistedModel(target.model),
  );
}

function isAllowlistedModel(model: string): boolean {
  return CHEAP_CONTINUATION_MODELS.some((allowed) => allowed === model);
}

function hasCheapModel(provider: CheapProviderSnapshot, model: string): boolean {
  if (provider.models.some((item) => item.slug === model)) return true;
  return model === "default" && provider.models.some((item) => item.slug === "auto");
}
