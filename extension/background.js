import { CONFIG } from "./config.js";
import { allowsMessage } from "./messages.js";
import { createUpdateChecker } from "./updates.js";
import { createFilterStore, isXPage, LIST_ALARM } from "./filter-state.js";
import { createRunner } from "./runner.js";
const api = globalThis.browser ?? globalThis.chrome;
const store = createFilterStore(api, CONFIG);
const updates = createUpdateChecker(api, CONFIG);
const runner = createRunner(
  api,
  CONFIG,
  globalThis.fetch,
  setTimeout,
  async () => {
    await store.refresh();
    return (await store.snapshot()).list;
  },
);
const blockCommands = new Set([
  "start",
  "rescan",
  "cancel",
  "inspect",
  "forgetBlockHistory",
  "ready",
  "navigateFailed",
  "sessionResult",
  "blockResult",
]);
async function state() {
  const [data, updateInfo, job] = await Promise.all([
    store.snapshot(),
    updates.state(),
    runner.snapshot(),
  ]);
  let stats = null,
    needsReload = false;
  try {
    const [tab] = await api.tabs.query({ active: true, currentWindow: true });
    if (Number.isInteger(tab?.id) && isXPage(tab.url)) {
      needsReload = true;
      const reply = await api.tabs.sendMessage(
        tab.id,
        { type: "filterStats" },
        { frameId: 0 },
      );
      if (
        reply?.version === 3 &&
        Number.isSafeInteger(reply.hidden) &&
        reply.hidden >= 0 &&
        reply.hidden <= 10000
      ) {
        stats = { hidden: reply.hidden, active: reply.active === true };
        needsReload = false;
      }
    }
  } catch {}
  return { ...data, updateInfo, stats, needsReload, job };
}
async function dispatch(message, sender) {
  if (blockCommands.has(message.type)) {
    await store.initialize();
    await runner.dispatch(message, sender);
    return sender.tab ? null : state();
  }
  if (message.type === "filterConfig") {
    store.refresh().catch(() => {});
    return store.contentConfig();
  }
  if (message.type === "pauseFilter") {
    await store.setEnabled(false);
    return { enabled: false };
  }
  if (message.type === "checkUpdate") return updates.check({ force: true });
  if (message.type === "setEnabled") await store.setEnabled(message.enabled);
  if (message.type === "refresh") await store.refresh({ force: true });
  if (message.type === "acknowledge") await store.acknowledge();
  if (message.type === "state") {
    store.refresh().catch(() => {});
    updates.check().catch(() => {});
  }
  return state();
}
api.runtime.onMessage.addListener((message, sender, respond) => {
  if (!allowsMessage(message, sender, api.runtime)) return;
  dispatch(message, sender).then(
    (data) => respond({ ok: true, data }),
    (error) =>
      respond({
        ok: false,
        error:
          typeof error?.message === "string"
            ? error.message.slice(0, 500)
            : "L’extension ne répond pas. Fermez puis rouvrez son menu.",
      }),
  );
  return true;
});
api.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === LIST_ALARM) store.refresh().catch(() => {});
  if (alarm.name === "block-next") runner.tick().catch(() => {});
});
async function startup() {
  await store.initialize();
  await runner.startup();
  await store.broadcast();
  store.refresh().catch(() => {});
  updates.check().catch(() => {});
}
api.runtime.onStartup.addListener(() => startup().catch(() => {}));
api.runtime.onInstalled.addListener(() => startup().catch(() => {}));
startup().catch(() => {});
