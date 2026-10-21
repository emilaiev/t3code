import type { SessionMessage } from "@opencode/schema/session-message";
import { nativeAttachmentTokenAllowance } from "@t3tools/provider-core/server/handoffBudget";

/**
 * A compaction this build can read: its retained summary and recent tail are
 * plaintext in the answer. A provider-native checkpoint instead carries an
 * encrypted transcript whose tokens cannot be counted from here, so it declines.
 */
const isPlaintextCheckpoint = (message: SessionMessage.Info): boolean =>
  message.type === "compaction" &&
  message.status === "completed" &&
  typeof message.summary === "string" &&
  typeof message.recent === "string" &&
  message.providerContext === undefined &&
  message.providerState === undefined;

/**
 * What one message's native file references reserve, or undefined for a shape
 * whose cost this build cannot account for. Wire bytes already include their
 * payloads; a base64 length says nothing about what a provider bills for a
 * decoded image, so every reference is priced separately.
 *
 * Every message keeps its optional `metadata`; that field is this build's own
 * message metadata, not the provider-native context that `providerContext` and
 * the parts' `state`/`providerState` carry, and its bytes are already counted.
 */
const fileAllowances = (message: SessionMessage.Info): number | undefined => {
  switch (message.type) {
    case "user": {
      let allowance = 0;
      for (const file of message.files ?? []) {
        const price = nativeAttachmentTokenAllowance(file.mime);
        if (price === undefined) return undefined;
        allowance += price;
      }
      return allowance;
    }
    case "assistant": {
      if (message.providerState !== undefined) return undefined;
      let allowance = 0;
      for (const part of message.content) {
        if (part.type === "text" || part.type === "reasoning") {
          // A part's own provider state is opaque, exactly like a tool's: what the
          // provider kept there is not plaintext this build can size.
          if (part.state !== undefined) return undefined;
          continue;
        }
        if (part.type !== "tool") return undefined;
        // Provider-native tool state is opaque to this build.
        if (part.providerState !== undefined || part.providerResultState !== undefined)
          return undefined;
        const state = part.state;
        // A tool still streaming has no settled content; its bytes are on the wire.
        if (state.status === "streaming" || state.status === "running") continue;
        for (const content of state.content ?? []) {
          if (content.type === "text") continue;
          if (content.type !== "file") return undefined;
          const price = nativeAttachmentTokenAllowance(content.mime);
          if (price === undefined) return undefined;
          allowance += price;
        }
      }
      return allowance;
    }
    case "synthetic":
    case "system":
    case "skill":
    case "shell":
    case "idle":
      return 0;
    case "compaction":
      return isPlaintextCheckpoint(message) ? 0 : undefined;
    // Agent, model and location switches mean the active window was reshaped by a
    // step this read cannot see; anything newer is simply unknown.
    default:
      return undefined;
  }
};

/**
 * The active context the native session holds now, counted from the answer's wire
 * bytes plus one allowance per native file reference. The answer must start at a
 * completed plaintext compaction: that boundary is what makes the returned window
 * the active context rather than an arbitrary prefix, and an unreadable or
 * unsupported shape declines instead of being under-counted.
 */
export const estimateNativeContext = (
  messages: ReadonlyArray<SessionMessage.Info>,
  wireBytes: number,
): number | undefined => {
  const checkpoint = messages.at(0);
  if (checkpoint === undefined || !isPlaintextCheckpoint(checkpoint)) return undefined;
  if (!Number.isSafeInteger(wireBytes) || wireBytes <= 0) return undefined;
  let files = 0;
  for (const message of messages) {
    const allowance = fileAllowances(message);
    if (allowance === undefined) return undefined;
    files += allowance;
  }
  return wireBytes + files;
};
