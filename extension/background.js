import { CONFIG } from "./config.js";
import { createRunner } from "./runner.js";
import { allowsMessage } from "./messages.js";
import { createUpdateChecker } from "./updates.js";
import { createListMonitor, LIST_CHECK_ALARM } from "./list-alerts.js";
const api = globalThis.browser ?? globalThis.chrome;
// Seuls le fond et le popup ont besoin de la progression et de l’historique.
api.storage.local
  .setAccessLevel?.({ accessLevel: "TRUSTED_CONTEXTS" })
  .catch(() => {});
const runner = createRunner(api, CONFIG);
const updates = createUpdateChecker(api, CONFIG);
const listMonitor = createListMonitor(api, () =>
  runner.dispatch({ type: "refresh" }),
);
listMonitor.initialize().catch(() => {});
listMonitor.sync().catch(() => {});
async function dispatch(message, sender) {
  if (message.type === "checkUpdate") return updates.check({ force: true });
  if (message.type === "refresh") {
    await listMonitor.check({ force: true });
    return (await runner.dispatch({ type: "state" })).list;
  }
  if (message.type === "state") {
    updates.check().catch(() => {});
    listMonitor.check().catch(() => {});
    const [data, updateInfo, listUpdates] = await Promise.all([
      runner.dispatch(message, sender),
      updates.state(),
      listMonitor.sync(),
    ]);
    return { ...data, updateInfo, listUpdates };
  }
  const result = await runner.dispatch(message, sender);
  await listMonitor.sync();
  return result;
}
api.runtime.onMessage.addListener((message, sender, respond) => {
  if (!allowsMessage(message, sender, api.runtime)) return;
  dispatch(message, sender).then(
    (data) => respond({ ok: true, data }),
    (error) => respond({ ok: false, error: error.message }),
  );
  return true;
});
api.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "block-next") runner.tick().catch(() => {});
  if (alarm.name === LIST_CHECK_ALARM) listMonitor.check().catch(() => {});
});
api.storage.onChanged?.addListener((changes, area) => {
  if (
    area === "local" &&
    [
      "list",
      "checkedAt",
      "job",
      "processedHistory",
      "lastConfirmedAccount",
    ].some((key) => Object.hasOwn(changes, key))
  )
    listMonitor.sync().catch(() => {});
});
api.tabs.onUpdated.addListener((id, change) => {
  if (change.status === "complete") runner.tick().catch(() => {});
});
const startup = () => {
  runner.startup().catch(() => {});
  updates.check().catch(() => {});
  listMonitor.initialize().catch(() => {});
  listMonitor.check().catch(() => {});
};
api.runtime.onStartup.addListener(startup);
api.runtime.onInstalled.addListener(startup);
