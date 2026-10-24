import type { ProviderInstanceId, ServerProvider } from "@t3tools/contracts";
import { modelClosedUntil } from "@t3tools/shared/modelQuotaClosure";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

const STALE_MS = 5 * 60 * 1000;

type ProviderSnapshotSource = {
  readonly getProviders: Effect.Effect<ReadonlyArray<ServerProvider>>;
  readonly refreshInstance: (
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<ReadonlyArray<ServerProvider>>;
};

/**
 * OpenCode and Cursor do not publish a reset time on the failed run, so a
 * fresh "open" snapshot can be wrong until the next probe. Those drivers are
 * read again before a launch. The others are read again when the snapshot is
 * already closed, failed, or older than five minutes.
 */
const PROBE_BEFORE_LAUNCH = new Set(["opencode", "cursor"]);

export const modelClosure = (
  registry: ProviderSnapshotSource,
  instanceId: ProviderInstanceId,
  modelId: string,
) =>
  Effect.gen(function* () {
    const initial = yield* registry.getProviders;
    let provider = initial.find((item) => item.instanceId === instanceId);
    const nowMs = yield* DateTime.now.pipe(Effect.map(DateTime.toEpochMillis));
    const closedUntil = (item: ServerProvider | undefined) =>
      item === undefined
        ? undefined
        : modelClosedUntil({
            driver: item.driver,
            modelId,
            limits: item.usageLimits,
            nowMs,
          });
    if (
      provider !== undefined &&
      shouldProbe(provider, closedUntil(provider) !== undefined, nowMs)
    ) {
      const refreshed = yield* registry
        .refreshInstance(instanceId)
        .pipe(Effect.orElseSucceed(() => initial));
      provider = refreshed.find((item) => item.instanceId === instanceId) ?? provider;
    }
    return closedUntil(provider);
  });

function shouldProbe(provider: ServerProvider, closed: boolean, nowMs: number): boolean {
  if (PROBE_BEFORE_LAUNCH.has(provider.driver) || closed) return true;
  const limits = provider.usageLimits;
  if (limits === undefined) return false;
  if (limits.unavailable?.reason === "probeFailed") return true;
  if (limits.unavailable?.reason === "unsupported") return false;
  const checked = Date.parse(limits.checkedAt);
  return !Number.isFinite(checked) || nowMs - checked > STALE_MS;
}
