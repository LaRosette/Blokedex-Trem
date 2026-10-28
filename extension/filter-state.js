import { readListResponse, validateList } from "./core.js";
export const LIST_ALARM = "refresh-filter-list";
export const LIST_INTERVAL = 6 * 60 * 60 * 1000;
const OLD_KEYS = [
  "job",
  "processedHistory",
  "lastConfirmedAccount",
  "listAlertSeen",
  "listAlertPending",
  "listAlertBaseline",
];
export function isXPage(value) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      ["x.com", "twitter.com"].includes(url.hostname)
    );
  } catch {
    return false;
  }
}
export function createFilterStore(
  api,
  config,
  fetcher = globalThis.fetch,
  now = Date.now,
) {
  let initialization,
    pending,
    pendingForced = false,
    serial = Promise.resolve();
  const locked = (fn) => {
    const result = serial.then(fn);
    serial = result.catch(() => {});
    return result;
  };
  const read = () =>
    api.storage.local.get([
      "filterEnabled",
      "filterRevision",
      "list",
      "checkedAt",
      "listAttemptedAt",
      "filterIssue",
      "filterAdded",
    ]);
  async function initialize() {
    if (initialization) return initialization;
    initialization = (async () => {
      await api.storage.local.setAccessLevel?.({
        accessLevel: "TRUSTED_CONTEXTS",
      });
      const old = await api.storage.local.get(["job", "filterSchema"]);
      await Promise.all([
        api.alarms.clear("block-next"),
        api.alarms.clear("check-list-additions"),
      ]);
      if (old.filterSchema !== 3) {
        if (
          Number.isInteger(old.job?.tabId) &&
          typeof old.job?.id === "string"
        ) {
          let timeout;
          await Promise.race([
            api.tabs
              .sendMessage(old.job.tabId, {
                type: "abort",
                jobId: old.job.id,
                attempt: old.job.attempt,
              })
              .catch(() => {}),
            new Promise((resolve) => {
              timeout = setTimeout(resolve, 1200);
            }),
          ]).finally(() => clearTimeout(timeout));
        }
        await api.storage.local.remove(OLD_KEYS);
        await api.storage.local.set({
          filterSchema: 3,
          filterEnabled: false,
          filterRevision: 0,
          filterAdded: [],
        });
      }
      const current = await read();
      try {
        validateList(current.list);
      } catch {
        const list = await readListResponse(
          await fetcher(api.runtime.getURL("catalog.json"), {
            credentials: "omit",
            redirect: "error",
            signal: AbortSignal.timeout(5000),
          }),
        );
        await api.storage.local.set({ list, checkedAt: 0 });
      }
      await api.alarms.create(LIST_ALARM, { periodInMinutes: 360 });
    })();
    initialization.catch(() => {
      initialization = null;
    });
    return initialization;
  }
  async function snapshot() {
    await initialize();
    const data = await read();
    return {
      enabled: data.filterEnabled === true,
      revision:
        Number.isSafeInteger(data.filterRevision) && data.filterRevision >= 0
          ? data.filterRevision
          : 0,
      list: validateList(data.list),
      checkedAt: Number.isFinite(data.checkedAt) ? data.checkedAt : 0,
      issue: typeof data.filterIssue === "string" ? data.filterIssue : "",
      addedCount: Array.isArray(data.filterAdded)
        ? Math.min(10000, data.filterAdded.length)
        : 0,
    };
  }
  async function contentConfig() {
    const state = await snapshot();
    return {
      enabled: state.enabled,
      revision: state.revision,
      usernames: state.list.accounts.map((a) => a.username),
    };
  }
  async function badge() {
    const state = await snapshot();
    await api.action.setBadgeText({
      text: state.addedCount
        ? state.addedCount > 99
          ? "99+"
          : String(state.addedCount)
        : "",
    });
    await api.action.setBadgeBackgroundColor({ color: "#173e35" });
    await api.action.setTitle({
      title:
        "Blokedex-Trem — " +
        (state.enabled ? "filtre actif" : "filtre en pause"),
    });
  }
  async function broadcast() {
    const settings = await contentConfig();
    const tabs = await api.tabs.query({
      url: ["https://x.com/*", "https://twitter.com/*"],
    });
    await Promise.allSettled(
      tabs
        .filter((tab) => Number.isInteger(tab.id) && isXPage(tab.url))
        .map((tab) =>
          api.tabs.sendMessage(
            tab.id,
            { type: "applyFilter", settings },
            { frameId: 0 },
          ),
        ),
    );
    await badge();
  }
  async function refresh({ force = false } = {}) {
    await initialize();
    if (pending) {
      if (force && !pendingForced)
        return pending.then(() => refresh({ force: true }));
      return pending;
    }
    pendingForced = force;
    pending = (async () => {
      const current = await read();
      if (
        !force &&
        Number.isFinite(current.listAttemptedAt) &&
        now() - current.listAttemptedAt < LIST_INTERVAL &&
        now() >= current.listAttemptedAt
      )
        return;
      await api.storage.local.set({ listAttemptedAt: now() });
      try {
        const list = await readListResponse(
          await fetcher(config.listUrl, {
            credentials: "omit",
            redirect: "error",
            cache: "no-store",
            signal: AbortSignal.timeout(8000),
          }),
        );
        await locked(async () => {
          const data = await read(),
            previous = validateList(data.list);
          const known = new Set(previous.accounts.map((a) => a.id));
          const valid = new Set(list.accounts.map((a) => a.id));
          const pendingIds = Array.isArray(data.filterAdded)
            ? data.filterAdded.filter(
                (id) => typeof id === "string" && valid.has(id),
              )
            : [];
          const additions =
            data.checkedAt > 0
              ? list.accounts.filter((a) => !known.has(a.id)).map((a) => a.id)
              : [];
          await api.storage.local.set({
            list,
            checkedAt: now(),
            filterIssue: "",
            filterAdded: [...new Set([...pendingIds, ...additions])],
            filterRevision:
              (Number.isSafeInteger(data.filterRevision)
                ? data.filterRevision
                : 0) + 1,
          });
        });
        await broadcast();
      } catch {
        await api.storage.local.set({
          filterIssue:
            "Liste en ligne indisponible. Le filtre utilise la dernière liste conservée sur cet appareil.",
        });
      }
    })();
    try {
      await pending;
    } finally {
      pending = null;
      pendingForced = false;
    }
  }
  async function setEnabled(enabled) {
    if (typeof enabled !== "boolean") throw Error("Réglage invalide.");
    await initialize();
    await locked(async () => {
      const data = await read();
      await api.storage.local.set({
        filterEnabled: enabled,
        filterRevision:
          (Number.isSafeInteger(data.filterRevision)
            ? data.filterRevision
            : 0) + 1,
      });
    });
    await broadcast();
  }
  async function acknowledge() {
    await initialize();
    await locked(() => api.storage.local.set({ filterAdded: [] }));
    await badge();
  }
  return {
    initialize,
    snapshot,
    contentConfig,
    refresh,
    setEnabled,
    acknowledge,
    broadcast,
  };
}
