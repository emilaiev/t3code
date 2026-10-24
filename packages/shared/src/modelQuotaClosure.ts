import type { ProviderDriverKind, ServerProviderUsageLimits } from "@t3tools/contracts";

/**
 * One future reset time, or nothing. A missing result means the model can be
 * started. Percentages and window names stay inside this function.
 *
 * A full window whose reset is still in the future stays closed however old
 * the reading is. A full window with no reset time does not close anything.
 * An unsupported account does not close anything. An unrecognised window does
 * not close anything.
 */
export function modelClosedUntil(input: {
  readonly driver: ProviderDriverKind;
  readonly modelId: string;
  readonly limits: ServerProviderUsageLimits | undefined;
  readonly nowMs: number;
}): string | undefined {
  const limits = input.limits;
  if (limits === undefined || limits.unavailable?.reason === "unsupported") return undefined;
  let soonestMs: number | undefined;
  let soonestIso: string | undefined;
  for (const window of limits.windows) {
    if (!windowApplies(input.driver, input.modelId, window.id)) continue;
    if (window.usedPercent < 100 || window.resetsAt === undefined) continue;
    const at = Date.parse(window.resetsAt);
    if (!Number.isFinite(at) || at <= input.nowMs) continue;
    if (soonestMs === undefined || at < soonestMs) {
      soonestMs = at;
      soonestIso = window.resetsAt;
    }
  }
  return soonestIso;
}

function windowApplies(driver: ProviderDriverKind, modelId: string, windowId: string): boolean {
  if (driver === "opencode") {
    return windowId.startsWith("go_") && modelId.startsWith("opencode-go/");
  }
  if (driver === "cursor") return cursorWindowApplies(modelId, windowId);
  if (driver === "claudeAgent") return claudeWindowApplies(modelId, windowId);
  if (driver === "codex") {
    return windowId === "primary" || windowId === "secondary" || windowId === "individual";
  }
  if (driver === "grok") return windowId === "subscription";
  return false;
}

function cursorWindowApplies(modelId: string, windowId: string): boolean {
  const family = cursorFamily(modelId);
  if (windowId === "autoPercentUsed") return false;
  if (windowId === "totalPercentUsed") {
    return family === "auto" || family === "grok" || family === "composer";
  }
  if (windowId === "apiPercentUsed") return family === "api";
  return false;
}

function cursorFamily(modelId: string): "auto" | "grok" | "composer" | "api" | "other" {
  const id = modelId.toLowerCase();
  if (id === "default" || id === "auto") return "auto";
  if (id.includes("composer")) return "composer";
  if (id.includes("grok")) return "grok";
  if (id.includes("claude") || id.includes("gpt") || id.includes("gemini")) return "api";
  return "other";
}

function claudeWindowApplies(modelId: string, windowId: string): boolean {
  if (windowId === "five_hour" || windowId === "seven_day") return true;
  if (!windowId.startsWith("seven_day_")) return false;
  const slug = windowId.slice("seven_day_".length);
  if (slug.length === 0) return false;
  return modelId
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((segment) => segment.length > 0)
    .includes(slug);
}
