import { CONFIG } from "./config.js";
import { allowsMessage } from "./messages.js";
import { createUpdateChecker } from "./updates.js";
import { createFilterStore, isXPage, LIST_ALARM } from "./filter-state.js";
const api = globalThis.browser ?? globalThis.chrome;
const store = createFilterStore(api, CONFIG);
const updates = createUpdateChecker(api, CONFIG);
async function state() {
  const [data, updateInfo] = await Promise.all([
    store.snapshot(),
    updates.state(),
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
  return { ...data, updateInfo, stats, needsReload };
}
async function dispatch(message) {
  if (message.type === "filterConfig") {
    store.refresh().catch(() => {});
    return store.contentConfig();
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
  dispatch(message).then(
    (data) => respond({ ok: true, data }),
    () =>
      respond({
        ok: false,
        error: "L’extension ne répond pas. Fermez puis rouvrez son menu.",
      }),
  );
  return true;
});
api.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === LIST_ALARM) store.refresh().catch(() => {});
});
async function startup() {
  await store.initialize();
  await store.broadcast();
  store.refresh().catch(() => {});
  updates.check().catch(() => {});
}
api.runtime.onStartup.addListener(() => startup().catch(() => {}));
api.runtime.onInstalled.addListener(() => startup().catch(() => {}));
startup().catch(() => {});
