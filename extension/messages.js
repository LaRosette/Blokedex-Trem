import { isXPage } from "./filter-state.js";
const commands = new Set([
  "state",
  "refresh",
  "setEnabled",
  "acknowledge",
  "checkUpdate",
  "start",
  "rescan",
  "cancel",
  "inspect",
  "forgetBlockHistory",
]);
export function allowsMessage(message, sender, runtime) {
  if (
    !sender ||
    sender.id !== runtime.id ||
    !message ||
    typeof message !== "object"
  )
    return false;
  if (sender.url === runtime.getURL("popup.html")) {
    return (
      commands.has(message.type) &&
      (message.type !== "setEnabled" || typeof message.enabled === "boolean")
    );
  }
  return (
    Number.isInteger(sender.tab?.id) &&
    sender.frameId === 0 &&
    isXPage(sender.url) &&
    [
      "filterConfig",
      "pauseFilter",
      "ready",
      "navigateFailed",
      "sessionResult",
      "blockResult",
    ].includes(message.type)
  );
}
