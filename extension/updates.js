export const UPDATE_INTERVAL = 6 * 60 * 60 * 1000;
export const UPDATE_TIMEOUT = 5000;
export const MAX_UPDATE_BYTES = 8192;
const UPDATE_ERROR = "Impossible de vérifier la version pour le moment.";
const installTypes = new Set([
  "normal",
  "development",
  "admin",
  "sideload",
  "other",
]);

function own(value, key) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && Object.hasOwn(descriptor, "value")
    ? descriptor.value
    : undefined;
}

export function versionParts(value) {
  if (
    typeof value !== "string" ||
    value.length > 23 ||
    value.trim() !== value ||
    !/^(?:0|[1-9]\d{0,4})(?:\.(?:0|[1-9]\d{0,4})){2,3}$/.test(value)
  )
    throw Error("Numéro de version invalide.");
  const parts = value.split(".").map(Number);
  if (parts.some((part) => part > 65535))
    throw Error("Numéro de version invalide.");
  while (parts.length < 4) parts.push(0);
  return parts;
}

export function compareVersions(left, right) {
  const a = versionParts(left),
    b = versionParts(right);
  for (let index = 0; index < 4; index++) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  }
  return 0;
}

export function validateRelease(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("Informations de version invalides.");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    throw Error("Informations de version invalides.");
  const schemaVersion = own(value, "schemaVersion"),
    version = own(value, "version");
  if (schemaVersion !== 1) throw Error("Informations de version invalides.");
  versionParts(version);
  // Les liens, noms de fichiers et autres champs distants sont ignorés.
  return { schemaVersion: 1, version };
}

export async function readReleaseResponse(response) {
  if (!response.ok) throw Error(UPDATE_ERROR);
  if (Number(response.headers.get("content-length")) > MAX_UPDATE_BYTES)
    throw Error("Informations de version trop volumineuses.");
  const reader = response.body.getReader(),
    decoder = new TextDecoder();
  let text = "",
    length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_UPDATE_BYTES)
        throw Error("Informations de version trop volumineuses.");
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return validateRelease(JSON.parse(text));
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function cachedRelease(value) {
  try {
    return validateRelease(value);
  } catch {
    return null;
  }
}

function releaseLocation(config) {
  const match =
    /^https:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9][A-Za-z0-9_.-]{0,99})$/.exec(
      config.repoUrl,
    );
  if (
    !match ||
    match[0] !== config.repoUrl ||
    config.updatesUrl !==
      `https://raw.githubusercontent.com/${match[1]}/${match[2]}/main/updates/latest.json`
  )
    throw Error("Adresse de vérification de version invalide.");
  return (version) => config.repoUrl + "/releases/tag/v" + version;
}

function updateChannel(installType, api, manifest) {
  if (installType === "development") return "manual";
  if (installType !== "normal") return "unknown";
  const storeUpdates = new Set([
    "https://clients2.google.com/service/update2/crx",
    "https://edge.microsoft.com/extensionwebstorebase/v1/crx",
  ]);
  if (storeUpdates.has(manifest.update_url)) return "native";
  try {
    if (api.runtime.getURL("").startsWith("moz-extension://")) return "native";
  } catch {}
  return "unknown";
}

export function createUpdateChecker(
  api,
  config,
  fetcher = globalThis.fetch,
  now = Date.now,
) {
  const manifest = api.runtime.getManifest(),
    currentVersion = manifest.version,
    releaseUrl = releaseLocation(config);
  versionParts(currentVersion);
  let pending = null,
    pendingForced = false,
    checking = false,
    installation;

  function ownInstallation() {
    installation ??= (async () => {
      try {
        const self = await api.management?.getSelf?.();
        return installTypes.has(self?.installType)
          ? self.installType
          : "unknown";
      } catch {
        return "unknown";
      }
    })();
    return installation;
  }

  async function state() {
    const [stored, installType] = await Promise.all([
      api.storage.local.get([
        "latestRelease",
        "updateCheckedAt",
        "updateError",
      ]),
      ownInstallation(),
    ]);
    const latest = cachedRelease(stored.latestRelease),
      available =
        !!latest && compareVersions(latest.version, currentVersion) > 0;
    return {
      currentVersion,
      latestVersion: latest?.version || null,
      available,
      url: available ? releaseUrl(latest.version) : null,
      checkedAt:
        Number.isSafeInteger(stored.updateCheckedAt) &&
        stored.updateCheckedAt >= 0 &&
        stored.updateCheckedAt <= now()
          ? stored.updateCheckedAt
          : null,
      installType,
      channel: updateChannel(installType, api, manifest),
      checking,
      error: stored.updateError === UPDATE_ERROR ? UPDATE_ERROR : null,
    };
  }

  async function runCheck(force) {
    const stored = await api.storage.local.get([
      "latestRelease",
      "updateCheckedAt",
    ]);
    const timestamp = now();
    if (
      !force &&
      Number.isSafeInteger(stored.updateCheckedAt) &&
      stored.updateCheckedAt >= 0 &&
      timestamp >= stored.updateCheckedAt &&
      timestamp - stored.updateCheckedAt < UPDATE_INTERVAL
    )
      return state();
    checking = true;
    await api.storage.local.set({ updateCheckedAt: timestamp });
    let latestRelease = cachedRelease(stored.latestRelease),
      updateError = null;
    try {
      latestRelease = await readReleaseResponse(
        await fetcher(config.updatesUrl, {
          credentials: "omit",
          cache: "no-store",
          redirect: "error",
          signal: AbortSignal.timeout(UPDATE_TIMEOUT),
        }),
      );
    } catch {
      updateError = UPDATE_ERROR;
    } finally {
      checking = false;
    }
    await api.storage.local.set({ latestRelease, updateError });
    return state();
  }

  function check({ force = false } = {}) {
    if (pending) {
      if (force && !pendingForced)
        return pending.catch(() => {}).then(() => check({ force: true }));
      return pending;
    }
    pendingForced = force;
    pending = runCheck(force).finally(() => {
      pending = null;
      pendingForced = false;
    });
    return pending;
  }
  return { state, check };
}
