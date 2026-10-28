const popupCommands = new Set([
  "state",
  "refresh",
  "start",
  "rescan",
  "cancel",
  "inspect",
  "checkUpdate",
]);
const contentResults = new Set([
  "ready",
  "navigateFailed",
  "sessionResult",
  "blockResult",
]);

export function allowsMessage(message, sender, runtime) {
  if (!sender || sender.id !== runtime.id) return false;
  if (sender.url === runtime.getURL("popup.html"))
    return popupCommands.has(message?.type);
  if (!Number.isInteger(sender.tab?.id) || sender.frameId !== 0) return false;
  let url;
  try {
    url = new URL(sender.url);
  } catch {
    return false;
  }
  return (
    url.protocol === "https:" &&
    !url.username &&
    !url.password &&
    ["x.com", "twitter.com"].includes(url.hostname) &&
    !url.port &&
    contentResults.has(message?.type)
  );
}
