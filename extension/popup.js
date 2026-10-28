import { CONFIG } from "./config.js";

const api = globalThis.browser ?? globalThis.chrome;
const $ = (id) => document.getElementById(id);
const currentVersion = api.runtime.getManifest().version;
let state,
  busy = false,
  checkingUpdate = false,
  checkedUpdate = false;
let actionError = "",
  updateError = "",
  signature,
  displayedAdditions = 0;
let reading = Promise.resolve(),
  acknowledgement;

async function send(type, fields = {}) {
  const reply = await api.runtime.sendMessage({ type, ...fields });
  if (!reply?.ok)
    throw Error(
      reply?.error ||
        "Le filtre ne répond pas. Rouvrez l’extension pour réessayer.",
    );
  return reply.data;
}

const versionParts = (value) =>
  typeof value === "string" && /^\d{1,5}(?:\.\d{1,5}){1,3}$/.test(value)
    ? value.split(".").map(Number)
    : null;
function newerVersion(value) {
  const next = versionParts(value),
    current = versionParts(currentVersion);
  if (!next || !current) return false;
  for (let index = 0; index < Math.max(next.length, current.length); index++) {
    const difference = (next[index] || 0) - (current[index] || 0);
    if (difference) return difference > 0;
  }
  return false;
}
function checkedRelease(info) {
  if (!info?.available || !newerVersion(info.latestVersion)) return null;
  try {
    const repository = new URL(CONFIG.repoUrl);
    if (
      repository.protocol !== "https:" ||
      repository.hostname !== "github.com" ||
      repository.username ||
      repository.password ||
      repository.port ||
      repository.search ||
      repository.hash ||
      !/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?$/.test(repository.pathname)
    )
      return null;
    const expected =
      repository.href.replace(/\/$/, "") +
      "/releases/tag/v" +
      info.latestVersion;
    return info.url === expected ? expected : null;
  } catch {
    return null;
  }
}
function renderUpdate() {
  const info = state?.updateInfo,
    release = checkedRelease(info);
  const checking = checkingUpdate || info?.checking;
  $("currentVersion").textContent = "v" + currentVersion;
  $("updateNotice").hidden = !release;
  $("updateLink").removeAttribute("href");
  $("updateLink").textContent = "";
  if (release) {
    $("updateLink").href = release;
    $("updateLink").textContent = "Voir la version " + info.latestVersion;
  }
  $("updateHint").textContent =
    info?.channel === "manual"
      ? "Installation manuelle : suivez les instructions de la version pour remplacer les fichiers de l’extension."
      : info?.channel === "native"
        ? "Votre navigateur gère les mises à jour de cette installation."
        : "Suivez les instructions de la version pour votre navigateur.";
  $("checkUpdate").disabled = !!checking;
  $("checkUpdate").textContent = checking
    ? "Vérification en cours…"
    : "Vérifier les mises à jour de l’extension";
  $("updateStatus").textContent = checking
    ? ""
    : updateError ||
      (checkedUpdate && (info?.error || (info?.available && !release))
        ? "Vérification indisponible. Réessayez plus tard."
        : checkedUpdate && !release && !info?.error
          ? "Aucune nouvelle version publiée."
          : "");
}

function renderAccounts() {
  const accounts = Array.isArray(state?.list?.accounts)
    ? state.list.accounts
    : [];
  const query = $("search").value.trim().replace(/^@/, "").toLowerCase();
  const visible = accounts.filter(
    (account) =>
      typeof account?.username === "string" &&
      /^[A-Za-z0-9_]{1,15}$/.test(account.username) &&
      account.username.toLowerCase().includes(query),
  );
  const next = JSON.stringify(visible);
  if (signature !== next) {
    signature = next;
    $("accounts").replaceChildren(
      ...visible.map((account) => {
        const li = document.createElement("li"),
          link = document.createElement("a");
        link.href = "https://x.com/" + encodeURIComponent(account.username);
        link.textContent = "@" + account.username;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        li.append(link);
        return li;
      }),
    );
  }
  $("listInfo").textContent =
    "Voir la liste" + (state?.list ? " (" + accounts.length + ")" : "");
  $("noResults").hidden = !query || visible.length > 0;
  $("refreshListe").disabled = busy;
  const checkedAt = state?.checkedAt;
  $("listChecked").textContent =
    Number.isSafeInteger(checkedAt) && checkedAt > 0 && checkedAt <= Date.now()
      ? "Vérifiée le " +
        new Intl.DateTimeFormat("fr-FR", {
          day: "numeric",
          month: "short",
        }).format(checkedAt)
      : "";
}

function validAdditions() {
  return (
    Number.isSafeInteger(state?.addedCount) &&
    state.addedCount > 0 &&
    state.addedCount <= (state?.list?.accounts?.length || 0)
  );
}
function render() {
  const enabled = state?.enabled === true;
  document.body.dataset.enabled = String(enabled);
  $("filterState").textContent = enabled ? "Actif" : "En pause";
  $("toggle").disabled = busy || !state;
  $("toggle").textContent = enabled ? "Mettre en pause" : "Activer le filtre";
  $("toggle").setAttribute("aria-pressed", String(enabled));
  $("status").textContent = enabled
    ? state?.needsReload
      ? "Le filtre attend l’actualisation de votre page X."
      : "Le filtre est activé dans ce navigateur."
    : "Le filtre est en pause. Les publications restent visibles.";
  const stats = state?.stats;
  const hasStats =
    stats && Number.isSafeInteger(stats.hidden) && stats.hidden >= 0;
  $("pageStats").hidden = !hasStats;
  if (hasStats)
    $("hiddenCount").textContent = new Intl.NumberFormat("fr-FR").format(
      stats.hidden,
    );
  $("pageHint").hidden = !!hasStats && !state?.needsReload;
  $("pageHint").textContent = state?.needsReload
    ? "Actualisez l’onglet X pour appliquer le nouveau filtre."
    : stats === null
      ? "Ouvrez X pour voir le filtre agir sur votre fil."
      : "La page X se prépare. Actualisez-la si le compteur n’apparaît pas.";
  if (validAdditions()) displayedAdditions = state.addedCount;
  $("listUpdatesNotice").hidden = !displayedAdditions;
  $("listUpdatesCount").textContent =
    displayedAdditions +
    (displayedAdditions === 1
      ? " profil ajouté au filtre"
      : " profils ajoutés au filtre");
  $("error").textContent =
    actionError || (typeof state?.issue === "string" ? state.issue : "");
  renderAccounts();
  renderUpdate();
}

function acknowledgeAfterDisplay() {
  if (!validAdditions() || acknowledgement) return;
  acknowledgement = new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(resolve)),
  )
    .then(() => send("acknowledge"))
    .catch(() => {})
    .finally(() => {
      acknowledgement = undefined;
    });
}
function acceptState(next) {
  // Polling and user actions can finish in a different order than they started.
  if (state && next?.revision < state.revision) return false;
  state = next;
  render();
  acknowledgeAfterDisplay();
  return true;
}
function readState() {
  reading = reading
    .catch(() => {})
    .then(async () => {
      acceptState(await send("state"));
    });
  return reading;
}
async function act(type, fields) {
  if (busy) return;
  busy = true;
  actionError = "";
  render();
  try {
    acceptState(await send(type, fields));
  } catch (error) {
    actionError = error.message;
  } finally {
    busy = false;
    render();
  }
}
async function checkUpdate() {
  if (checkingUpdate) return;
  checkingUpdate = true;
  updateError = "";
  renderUpdate();
  try {
    await send("checkUpdate");
    checkedUpdate = true;
  } catch {
    updateError = "Vérification indisponible. Réessayez plus tard.";
  } finally {
    checkingUpdate = false;
    await readState().catch(() => renderUpdate());
  }
}

$("toggle").onclick = () =>
  act("setEnabled", { enabled: state?.enabled !== true });
$("refreshListe").onclick = () => act("refresh");
$("search").addEventListener("input", renderAccounts);
$("checkUpdate").onclick = checkUpdate;
api.storage.onChanged.addListener((changes, area) => {
  if (
    area === "local" &&
    [
      "filterEnabled",
      "filterRevision",
      "list",
      "filterIssue",
      "filterAdded",
      "latestRelease",
      "updateError",
    ].some((key) => Object.hasOwn(changes, key))
  )
    readState().catch(() => {});
});
await readState().catch((error) => {
  $("error").textContent = error.message;
  $("status").textContent = "Rouvrez l’extension pour réessayer.";
});
const statsTimer = setInterval(() => {
  if (!document.hidden && !busy) readState().catch(() => {});
}, 1500);
addEventListener("pagehide", () => clearInterval(statsTimer), { once: true });
