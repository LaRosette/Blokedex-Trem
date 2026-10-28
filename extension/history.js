export const MAX_HISTORY_USERS = 5;
export const MAX_HISTORY_IDS = 10_000;

const keyPattern = /^[a-f0-9]{64}$/;
const usernamePattern = /^[A-Za-z0-9_]{1,15}$/;
const idPattern = /^[1-9]\d{0,24}$/;

// Ne lit que les propriétés de données propres, jamais un accesseur hérité.
function own(value, name) {
  const descriptor = Object.getOwnPropertyDescriptor(value, name);
  return descriptor && Object.hasOwn(descriptor, "value")
    ? descriptor.value
    : undefined;
}

function arrayValues(value) {
  if (!Array.isArray(value)) return null;
  const length = own(value, "length");
  return Object.keys(value)
    .filter((key) => /^(0|[1-9]\d*)$/.test(key) && Number(key) < length)
    .map((key) => own(value, key));
}

function boundedIds(values) {
  const ids = new Set();
  for (const id of values) {
    if (typeof id !== "string" || !idPattern.test(id)) continue;
    // Une nouvelle occurrence devient la plus récente dans ce compte.
    ids.delete(id);
    ids.add(id);
    if (ids.size > MAX_HISTORY_IDS) ids.delete(ids.values().next().value);
  }
  return [...ids];
}

function entry(value, timeField) {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value))
      return null;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const key = own(value, "key");
    const username = own(value, "username");
    const updatedAt = own(value, timeField);
    const ids = arrayValues(own(value, "ids"));
    if (
      typeof key !== "string" ||
      !keyPattern.test(key) ||
      typeof username !== "string" ||
      !usernamePattern.test(username) ||
      !Number.isSafeInteger(updatedAt) ||
      updatedAt < 0 ||
      !ids
    )
      return null;
    return { key, username, ids: boundedIds(ids), updatedAt };
  } catch {
    return null;
  }
}

// Il s’agit de comptes déjà traités localement, pas d’un état garanti sur X.
export function normalizeHistory(value) {
  let values;
  try {
    values = arrayValues(value);
  } catch {
    return [];
  }
  if (!values) return [];
  const ordered = values
    .map((value) => entry(value, "updatedAt"))
    .filter(Boolean)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const keys = new Set();
  const result = [];
  for (const row of ordered) {
    if (keys.has(row.key)) continue;
    keys.add(row.key);
    result.push(row);
    if (result.length === MAX_HISTORY_USERS) break;
  }
  return result;
}

export function getKnown(history, key) {
  if (typeof key !== "string" || !keyPattern.test(key)) return new Set();
  const row = normalizeHistory(history).find((row) => row.key === key);
  return new Set(row?.ids || []);
}

export function remember(history, value) {
  const rows = normalizeHistory(history);
  const next = entry(value, "now");
  if (!next) return rows;
  const previous = rows.find((row) => row.key === next.key);
  next.ids = boundedIds([...(previous?.ids || []), ...next.ids]);
  return normalizeHistory([
    next,
    ...rows.filter((row) => row.key !== next.key),
  ]);
}
