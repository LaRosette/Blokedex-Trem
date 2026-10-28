import { validateList } from "./core.js";
import { normalizeHistory } from "./history.js";

export const LIST_CHECK_INTERVAL = 6 * 60 * 60 * 1000;
export const LIST_CHECK_ALARM = "check-list-additions";

function own(value, name) {
  if (!value || typeof value !== "object") return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, name);
  return descriptor && Object.hasOwn(descriptor, "value")
    ? descriptor.value
    : undefined;
}

function account(value) {
  try {
    const normalized = normalizeHistory([
      {
        key: own(value, "key"),
        username: own(value, "username"),
        ids: [],
        updatedAt: 0,
      },
    ])[0];
    return normalized
      ? { key: normalized.key, username: normalized.username }
      : null;
  } catch {
    return null;
  }
}

function jobAccount(job) {
  return account({
    key: own(job, "ownerKey"),
    username: own(job, "owner"),
  });
}

function matches(row, selected) {
  return (
    row?.key === selected?.key &&
    row?.username.toLowerCase() === selected?.username.toLowerCase()
  );
}

function idsOf(value) {
  return [...new Set(validateList(value).accounts.map((row) => row.id))].sort();
}

function baseline(job, selected, currentIds) {
  if (matches(jobAccount(job), selected)) {
    try {
      return idsOf({
        schemaVersion: 1,
        version: "baseline",
        accounts: own(job, "accounts"),
      });
    } catch {}
  }
  // Sans ancien lot exploitable, on ne présente pas toute la liste comme neuve.
  return currentIds;
}

function replace(rows, selected, ids, now) {
  return normalizeHistory([
    { ...selected, ids, updatedAt: now },
    ...rows.filter((row) => row.key !== selected.key),
  ]);
}

export function calculateListUpdates(stored, now = Date.now()) {
  const seenRows = normalizeHistory(own(stored, "listAlertSeen")),
    pendingRows = normalizeHistory(own(stored, "listAlertPending")),
    marker = own(stored, "lastConfirmedAccount"),
    job = own(stored, "job"),
    selected = marker === undefined ? jobAccount(job) : account(marker),
    checkedAt = own(stored, "checkedAt");
  const result = {
    listUpdates: {
      available: false,
      count: 0,
      username: null,
      checkedAt:
        Number.isSafeInteger(checkedAt) && checkedAt >= 0 && checkedAt <= now
          ? checkedAt
          : null,
    },
    listAlertSeen: seenRows,
    listAlertPending: pendingRows,
    changed: false,
  };
  if (!selected) return result;
  let currentIds;
  try {
    currentIds = idsOf(own(stored, "list"));
  } catch {
    return result;
  }
  const history = normalizeHistory(own(stored, "processedHistory")).find(
    (row) => matches(row, selected),
  );
  const seen = seenRows.find((row) => matches(row, selected)),
    pending = pendingRows.find((row) => matches(row, selected)),
    before = new Set(seen?.ids || baseline(job, selected, currentIds)),
    known = new Set(history?.ids || []),
    candidates = new Set(pending?.ids || []);
  for (const id of currentIds) if (!before.has(id)) candidates.add(id);
  const remaining = currentIds.filter(
    (id) => candidates.has(id) && !known.has(id),
  );
  if (!seen || JSON.stringify(seen.ids) !== JSON.stringify(currentIds)) {
    result.listAlertSeen = replace(seenRows, selected, currentIds, now);
    result.changed = true;
  }
  if (!pending || JSON.stringify(pending.ids) !== JSON.stringify(remaining)) {
    result.listAlertPending = replace(pendingRows, selected, remaining, now);
    result.changed = true;
  }
  // Le cache décrit les opérations locales de ce compte, jamais l’état distant X.
  if (history?.ids.length) {
    result.listUpdates.username = selected.username;
    result.listUpdates.count = remaining.length;
    result.listUpdates.available = remaining.length > 0;
  }
  return result;
}

const storageKeys = [
  "list",
  "checkedAt",
  "job",
  "processedHistory",
  "lastConfirmedAccount",
  "listAlertSeen",
  "listAlertPending",
];

export function createListMonitor(api, refreshList, now = Date.now) {
  let syncRequest,
    syncAgain = false,
    checkRequest,
    checkForced = false,
    initialization,
    badgeStamp;

  async function showBadge(info) {
    const stamp = JSON.stringify([info.count, info.username]);
    if (stamp === badgeStamp) return;
    const manifest = api.runtime.getManifest(),
      title =
        manifest.action?.default_title || manifest.name || "Blokedex-Trem";
    const results = await Promise.allSettled([
      api.action?.setBadgeText?.({
        text: info.available
          ? info.count > 99
            ? "99+"
            : String(info.count)
          : "",
      }),
      api.action?.setTitle?.({
        title: info.available
          ? `${title} — ${info.count} nouveau(x) profil(s) à traiter pour @${info.username} (historique local)`
          : title,
      }),
      api.action?.setBadgeBackgroundColor?.({ color: "#a53535" }),
    ]);
    if (results.every((result) => result.status === "fulfilled"))
      badgeStamp = stamp;
  }

  async function synchronize() {
    const stored = await api.storage.local.get(storageKeys),
      result = calculateListUpdates(stored, now());
    if (result.changed)
      await api.storage.local.set({
        listAlertSeen: result.listAlertSeen,
        listAlertPending: result.listAlertPending,
      });
    await showBadge(result.listUpdates);
    return result.listUpdates;
  }

  function sync() {
    syncAgain = true;
    if (!syncRequest)
      syncRequest = (async () => {
        let result;
        do {
          syncAgain = false;
          result = await synchronize();
        } while (syncAgain);
        return result;
      })().finally(() => {
        syncRequest = null;
      });
    return syncRequest;
  }

  async function checkList(force) {
    const stored = await api.storage.local.get([
        "checkedAt",
        "listCheckAttemptAt",
      ]),
      timestamp = now();
    const recent = [stored.checkedAt, stored.listCheckAttemptAt].some(
      (value) =>
        Number.isSafeInteger(value) &&
        value >= 0 &&
        timestamp >= value &&
        timestamp - value < LIST_CHECK_INTERVAL,
    );
    if (!force && recent) return sync();
    await api.storage.local.set({ listCheckAttemptAt: timestamp });
    try {
      await refreshList();
    } finally {
      await sync();
    }
    return sync();
  }

  function check({ force = false } = {}) {
    if (checkRequest) {
      // Une lecture de cache en cours ne doit pas absorber la demande explicite.
      if (force && !checkForced)
        return checkRequest.catch(() => {}).then(() => check({ force: true }));
      return checkRequest;
    }
    checkForced = force;
    checkRequest = checkList(force).finally(() => {
      checkRequest = null;
      checkForced = false;
    });
    return checkRequest;
  }

  return {
    sync,
    check,
    initialize() {
      if (!initialization)
        initialization = (async () => {
          const existing = await api.alarms?.get?.(LIST_CHECK_ALARM);
          if (!existing)
            await api.alarms?.create?.(LIST_CHECK_ALARM, {
              periodInMinutes: LIST_CHECK_INTERVAL / 60000,
            });
        })();
      return initialization;
    },
  };
}
