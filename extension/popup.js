import { CONFIG } from "./config.js";

const api = globalThis.browser ?? globalThis.chrome;
const $ = (id) => document.getElementById(id);
const currentVersion = api.runtime.getManifest().version;
let busy = false,
  checkingUpdate = false,
  checkedUpdate = false,
  updateError = "",
  state,
  rendering = Promise.resolve(),
  signature;
const send = async (type) => {
  const reply = await api.runtime.sendMessage({ type });
  if (!reply?.ok) throw Error(reply?.error || "Extension indisponible.");
  return reply.data;
};
function renderListUpdates() {
  const updates = state?.listUpdates;
  const total = state?.list?.accounts?.length;
  const valid =
    updates?.available === true &&
    Number.isSafeInteger(updates.count) &&
    updates.count > 0 &&
    Number.isSafeInteger(total) &&
    updates.count <= total &&
    typeof updates.username === "string" &&
    /^[A-Za-z0-9_]{1,15}$/.test(updates.username);
  $("listUpdatesNotice").hidden = !valid || state?.job?.status === "running";
  const count = valid
    ? `${updates.count} ${updates.count === 1 ? "nouveau compte" : "nouveaux comptes"} à bloquer`
    : "";
  const owner = valid ? "Pour @" + updates.username : "";
  if ($("listUpdatesCount").textContent !== count)
    $("listUpdatesCount").textContent = count;
  if ($("listUpdatesOwner").textContent !== owner)
    $("listUpdatesOwner").textContent = owner;
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
  const info = state?.updateInfo;
  const release = checkedRelease(info);
  const checking = checkingUpdate || info?.checking;
  const active = ["running", "paused"].includes(state?.job?.status);
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
    : "Vérifier les mises à jour";
  $("updateStatus").textContent = checking
    ? ""
    : updateError ||
      (checkedUpdate && (info?.error || (info?.available && !release))
        ? "Vérification indisponible. Réessayez plus tard."
        : release
          ? ""
          : checkedUpdate && !info?.error
            ? "Aucune nouvelle version publiée."
            : active
              ? ""
              : info?.channel === "manual"
                ? "Mises à jour à installer manuellement."
                : info?.channel === "native"
                  ? "Mises à jour gérées par votre navigateur."
                  : "");
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
    await render().catch(() => renderUpdate());
  }
}
function updateRetryHint() {
  const job = state?.job;
  const retryAt = job?.retryAt;
  const waiting =
    ((job?.status === "running" && job.phase === "cooldown") ||
      job?.status === "paused") &&
    Number.isFinite(retryAt);
  const locked = waiting && retryAt > Date.now();
  $("start").disabled = busy || job?.status === "running" || locked;
  $("rescan").disabled = busy || job?.status === "running" || locked;
  $("retryHint").hidden = !waiting;
  if (!waiting) return;
  const seconds = Math.max(0, Math.ceil((retryAt - Date.now()) / 1000));
  const minutes = Math.floor(seconds / 60);
  $("retryHint").textContent = seconds
    ? `${job.status === "paused" ? "Vous pourrez reprendre" : "Reprise"} dans ${minutes ? `${minutes} min ` : ""}${seconds % 60} s.`
    : job.status === "paused"
      ? "Vous pouvez reprendre le blocage."
      : "Reprise en cours…";
}
function renderProgress(job) {
  const total = job?.accounts?.length || 0;
  const index = Math.min(total, Math.max(0, job?.index || 0));
  const percent = total ? Math.floor((index / total) * 100) : 0;
  $("progressInfo").hidden = !job;
  $("bar").hidden = !job;
  $("bar").max = total || 1;
  $("bar").value = index;
  $("progressText").textContent = `${index} / ${total} profils`;
  $("progressPercent").textContent = `${percent} %`;
  $("owner").hidden = !job?.owner;
  $("owner").textContent = job?.owner ? `Compte : @${job.owner}` : "";
  const current = job?.currentUsername || job?.accounts?.[index]?.username;
  $("currentProfile").hidden =
    job?.status !== "running" || job.phase === "cooldown" || !current;
  $("currentProfile").textContent = current
    ? `Profil en cours : @${current}`
    : "";
  const count = (value, singular, plural) =>
    `${value} ${value === 1 ? singular : plural}`;
  const parts = [];
  if (Number.isInteger(job?.created) && (job.created || job.status === "done"))
    parts.push(count(job.created, "nouveau blocage", "nouveaux blocages"));
  if (job?.already)
    parts.push(count(job.already, "déjà bloqué", "déjà bloqués"));
  if (job?.cached) parts.push(count(job.cached, "déjà traité", "déjà traités"));
  if (job?.failed?.length)
    parts.push(count(job.failed.length, "indisponible", "indisponibles"));
  $("breakdown").hidden = !parts.length;
  $("breakdown").textContent = parts.join(" · ");
  updateRetryHint();
}
function render() {
  rendering = rendering
    .catch(() => {})
    .then(async () => {
      state = await send("state");
      renderListUpdates();
      renderUpdate();
      const job = state.job,
        running = job?.status === "running",
        cooldown = running && job.phase === "cooldown";
      const status = cooldown ? "cooldown" : job?.status || "idle";
      document.body.dataset.state = status;
      $("activity").dataset.state = status;
      $("phase").hidden = !job;
      $("phase").textContent =
        {
          running: ["sessionLoading", "inspecting"].includes(job?.phase)
            ? "Vérification du compte"
            : "Blocage en cours",
          paused: "Une pause est nécessaire",
          cooldown: "X demande une pause",
          done: "C’est fait.",
          cancelled: "Blocage arrêté",
        }[status] || "";
      $("start").disabled = busy || running;
      $("start").textContent = cooldown
        ? "En attente de X…"
        : running
          ? "Blocage en cours…"
          : job?.status === "paused"
            ? "Reprendre le blocage"
            : "Bloquer la liste";
      $("status").textContent =
        job?.message ||
        (state.list
          ? `${state.list.accounts.length} comptes dans la liste.`
          : "La liste sera chargée au lancement.");
      renderProgress(job);
      $("support").hidden = !["running", "paused"].includes(job?.status);
      $("cancel").hidden = !["running", "paused"].includes(job?.status);
      $("cancel").disabled = busy;
      $("inspect").hidden = job?.status !== "paused";
      $("inspect").disabled = busy;
      $("listInfo").textContent =
        `Comptes sélectionnés${state.list ? " (" + state.list.accounts.length + ")" : ""}`;
      const next = JSON.stringify(state.list);
      if (signature !== next) {
        signature = next;
        $("accounts").replaceChildren(
          ...(state.list?.accounts || []).map((account) => {
            const li = document.createElement("li");
            const link = document.createElement("a");
            link.href = `https://x.com/${encodeURIComponent(account.username)}`;
            link.textContent = "@" + account.username;
            link.target = "_blank";
            link.rel = "noopener noreferrer";
            li.append(link);
            return li;
          }),
        );
      }
    });
  return rendering;
}
async function act(type) {
  if (busy) return;
  busy = true;
  $("error").textContent = "";
  try {
    await render();
    await send(type);
  } catch (error) {
    $("error").textContent = error.message;
  } finally {
    busy = false;
    await render().catch((error) => {
      $("error").textContent = error.message;
    });
  }
}
$("start").onclick = () => act("start");
$("cancel").onclick = () => act("cancel");
$("inspect").onclick = () => act("inspect");
$("rescan").onclick = () => act("rescan");
$("checkUpdate").onclick = checkUpdate;
api.storage.onChanged.addListener(() => render().catch(() => {}));
await render().catch((error) => {
  $("error").textContent = error.message;
  $("status").textContent = "Fermez puis rouvrez l’extension pour réessayer.";
});
if (state?.job?.status !== "running")
  send("refresh")
    .then(render)
    .catch((error) => {
      if (!state?.list) $("error").textContent = error.message;
    });
const retryTimer = setInterval(updateRetryHint, 1000);
addEventListener("pagehide", () => clearInterval(retryTimer), { once: true });
