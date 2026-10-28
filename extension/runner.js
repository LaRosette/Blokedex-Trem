import { readListResponse } from "./core.js";
import { getKnown, remember } from "./history.js";
const ALARM = "block-next",
  NEXT_DELAY = 250,
  LOAD_TIMEOUT = 25000;
export function createRunner(
  chrome,
  config,
  fetcher = globalThis.fetch,
  defer = setTimeout,
) {
  let serial = Promise.resolve(),
    wakeTimer,
    listRequest;
  const locked = (fn) => {
    const next = serial.then(fn);
    serial = next.catch(() => {});
    return next;
  };
  const read = async () => (await chrome.storage.local.get("job")).job;
  const save = (job) => chrome.storage.local.set({ job });
  const sendToTab = async (id, message) => {
    let timer;
    try {
      return await Promise.race([
        chrome.tabs.sendMessage(id, message),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(Error("Le script X ne répond pas.")),
            3000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  async function abortTask(job) {
    if (!job?.tabId) return true;
    try {
      const result = await sendToTab(job.tabId, {
        type: "abort",
        jobId: job.id,
        attempt: job.attempt,
      });
      if (result?.aborted === true) return true;
    } catch {}
    // Une ancienne version du script peut rester injectée après une mise à jour.
    // On détruit ce document si elle ne sait pas invalider la tâche en cours.
    try {
      const tab = await chrome.tabs.get(job.tabId);
      if (["x.com", "twitter.com"].includes(new URL(tab.url).hostname))
        await chrome.tabs.update(job.tabId, { url: "https://x.com/home" });
    } catch {}
    return false;
  }
  const schedule = async (when) => {
    await chrome.alarms.create(ALARM, { when });
    // Les alarmes servent de secours si Chrome arrête le service worker.
    clearTimeout(wakeTimer);
    wakeTimer = defer(
      () => locked(drive).catch(() => {}),
      Math.max(100, when - Date.now()),
    );
  };
  async function fetchList() {
    const response = await fetcher(config.listUrl, {
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    });
    const list = await readListResponse(response);
    await chrome.storage.local.set({ list, checkedAt: Date.now() });
    return list;
  }
  async function list() {
    if (listRequest) return listRequest;
    listRequest = fetchList().finally(() => {
      listRequest = null;
    });
    return listRequest;
  }
  async function pause(job, message) {
    await abortTask(job);
    job.status = "paused";
    job.message = message;
    clearTimeout(wakeTimer);
    await save(job);
    await chrome.alarms.clear(ALARM);
  }
  async function recover(job, code, message) {
    const limited = code === "rate";
    const tries = job.retries || 0;
    const maxRetries = limited ? 2 : 1;
    if (tries >= maxRetries) {
      job.retryAt = limited ? Date.now() + 15 * 60000 : null;
      await pause(
        job,
        message ||
          "X ne charge toujours pas. La progression est conservée ; réessayez plus tard.",
      );
      return;
    }
    await abortTask(job);
    job.retries = tries + 1;
    job.retryAt = Date.now() + (limited ? 60000 * 2 ** tries : 2000);
    job.phase = "cooldown";
    job.message = limited
      ? "X limite les requêtes. Le blocage reprendra après une pause."
      : "X n’a pas chargé le profil. Une nouvelle tentative est prévue.";
    await save(job);
    await schedule(job.retryAt);
  }
  async function record(job, id) {
    if (!job.ownerKey) return;
    const { processedHistory } =
      await chrome.storage.local.get("processedHistory");
    await chrome.storage.local.set({
      processedHistory: remember(processedHistory, {
        key: job.ownerKey,
        username: job.owner,
        ids: [id],
        now: Date.now(),
      }),
    });
  }
  async function workspace(previous) {
    if (previous?.tabId) {
      const stopped = await abortTask(previous);
      try {
        const tab = await chrome.tabs.get(previous.tabId);
        if (new URL(tab.url).hostname === "x.com") {
          let probe;
          try {
            if (!stopped) throw Error("reload-required");
            probe = await sendToTab(tab.id, { type: "probe" });
          } catch {}
          await chrome.tabs.update(tab.id, {
            ...(probe?.owner ? {} : { url: "https://x.com/home" }),
            muted: true,
            autoDiscardable: false,
          });
          return {
            tabId: tab.id,
            sessionPath: probe?.owner
              ? new URL(tab.url).pathname.toLowerCase()
              : "/home",
            documentReady: !!probe?.owner,
          };
        }
      } catch {}
    }
    const tab = await chrome.tabs.create({
      url: "https://x.com/home",
      active: false,
    });
    await chrome.tabs.update(tab.id, { muted: true, autoDiscardable: false });
    return { tabId: tab.id, sessionPath: "/home", documentReady: false };
  }
  async function closeOwnedTab(job) {
    try {
      const tab = await chrome.tabs.get(job.tabId);
      if (new URL(tab.url).hostname === "x.com")
        await chrome.tabs.remove(job.tabId);
    } catch {}
  }
  async function finish(job) {
    job.status = "done";
    job.finishedAt = Date.now();
    job.currentUsername = null;
    job.retryAt = null;
    job.message = job.failed.length
      ? `${job.confirmed} compte(s) bloqué(s), ${job.failed.length} compte(s) indisponible(s).`
      : `${job.confirmed} compte(s) bloqué(s). C’est fait !`;
    if (job.cached)
      job.message = `${job.created || 0} nouveau(x) blocage(s), ${job.cached} compte(s) déjà traité(s).`;
    clearTimeout(wakeTimer);
    await save(job);
    await chrome.alarms.clear(ALARM);
    await closeOwnedTab(job);
  }
  async function drive() {
    const job = await read();
    if (job?.status !== "running") return;
    if (job.index >= job.accounts.length) {
      await finish(job);
      return;
    }
    if (job.phase === "cooldown") {
      if (Date.now() < job.retryAt) {
        await schedule(job.retryAt);
        return;
      }
      job.phase = "sessionLoading";
      job.sessionPath = "/home";
      job.documentReady = false;
      job.softNavigation = false;
      job.retryAt = null;
      job.attempt = crypto.randomUUID();
      job.deadline = Date.now() + LOAD_TIMEOUT;
      await save(job);
      try {
        await chrome.tabs.update(job.tabId, { url: "https://x.com/home" });
        await schedule(Date.now() + 1000);
      } catch {
        await pause(
          job,
          "L’onglet de blocage a été fermé. Cliquez pour reprendre.",
        );
      }
      return;
    }
    if (job.phase === "delay") {
      if (job.nextAt > Date.now()) {
        await schedule(job.nextAt);
        return;
      }
      const known = new Set(job.skipIds || []);
      while (
        job.index < job.accounts.length &&
        known.has(job.accounts[job.index].id)
      ) {
        job.index++;
        job.confirmed++;
        job.cached = (job.cached || 0) + 1;
      }
      if (job.index >= job.accounts.length) {
        await finish(job);
        return;
      }
      job.phase = "loading";
      job.currentUsername = job.accounts[job.index].username;
      job.documentReady = false;
      job.softNavigation = false;
      job.attempt = crypto.randomUUID();
      job.deadline = Date.now() + LOAD_TIMEOUT;
      await save(job);
      try {
        try {
          const accepted =
            !job.navigationFallback &&
            (await sendToTab(job.tabId, {
              type: "navigate",
              jobId: job.id,
              attempt: job.attempt,
              account: job.accounts[job.index],
              owner: job.owner,
            }));
          if (accepted?.accepted) {
            job.softNavigation = true;
            await save(job);
            await schedule(job.deadline + 100);
            return;
          }
        } catch {}
        await chrome.tabs.update(job.tabId, {
          url: `https://x.com/${job.accounts[job.index].username}`,
        });
        // Firefox peut encore renvoyer l’ancienne URL juste après update().
        // Le nouveau document nous prévient dès que son script est prêt.
        await schedule(Date.now() + 1000);
        return;
      } catch {
        await pause(
          job,
          "L’onglet de blocage a été fermé. Cliquez pour reprendre.",
        );
        return;
      }
    }
    if (job.deadline < Date.now()) {
      await recover(
        job,
        "loading",
        "X ne répond pas. La progression est conservée. Ouvrez l’onglet X avant de reprendre.",
      );
      return;
    }
    if (["inspecting", "blocking"].includes(job.phase)) {
      await schedule(job.deadline + 100);
      return;
    }
    let tab;
    try {
      tab = await chrome.tabs.get(job.tabId);
    } catch {
      await pause(
        job,
        "L’onglet de blocage a été fermé. Cliquez pour reprendre.",
      );
      return;
    }
    if (
      (tab.status !== "complete" || job.softNavigation) &&
      !job.documentReady
    ) {
      await schedule(Date.now() + 1000);
      return;
    }
    if (!tab.url || tab.url === "about:blank") {
      await schedule(Date.now() + 500);
      return;
    }
    let url;
    try {
      url = new URL(tab.url);
    } catch {
      await pause(job, "L’onglet X a changé. Cliquez pour reprendre.");
      return;
    }
    if (
      url.hostname !== "x.com" ||
      (job.phase === "loading" &&
        url.pathname.toLowerCase() !==
          `/${job.accounts[job.index].username.toLowerCase()}`)
    ) {
      await pause(
        job,
        "Connectez-vous à X dans l’onglet ouvert, puis cliquez pour reprendre.",
      );
      return;
    }
    const session = job.phase === "sessionLoading";
    const loadingDeadline = job.deadline;
    job.phase = session ? "inspecting" : "blocking";
    job.deadline = Date.now() + 22000;
    await save(job);
    try {
      const accepted = await sendToTab(job.tabId, {
        type: session ? "inspect" : "block",
        jobId: job.id,
        attempt: job.attempt,
        account: job.accounts[job.index],
        owner: job.owner,
        ownerKey: job.ownerKey,
      });
      if (!accepted?.accepted) throw new Error("not-ready");
    } catch {
      job.phase = session ? "sessionLoading" : "loading";
      job.deadline = loadingDeadline;
      await save(job);
      await schedule(Date.now() + 500);
      return;
    }
    await schedule(job.deadline + 100);
  }
  async function result(message, sender) {
    const job = await read();
    if (
      job?.status !== "running" ||
      sender.tab?.id !== job.tabId ||
      sender.frameId !== 0 ||
      job.id !== message.jobId ||
      job.attempt !== message.attempt
    )
      return;
    if (message.type === "sessionResult" && job.phase === "inspecting") {
      if (
        message.outcome === "error" &&
        ["loading", "rate"].includes(message.code)
      ) {
        await recover(job, message.code, message.error);
        return;
      }
      if (!message.owner || !/^[A-Za-z0-9_]{1,15}$/.test(message.owner)) {
        await pause(
          job,
          "Connectez-vous à X dans l’onglet ouvert, puis cliquez pour reprendre.",
        );
        return;
      }
      if (
        job.owner &&
        job.owner.toLowerCase() !== message.owner.toLowerCase()
      ) {
        await pause(
          job,
          "Le compte X connecté a changé. Revenez au compte utilisé au lancement.",
        );
        return;
      }
      job.owner = message.owner;
      const key = /^[a-f0-9]{64}$/.test(message.ownerKey || "")
        ? message.ownerKey
        : null;
      if (job.ownerKey && job.ownerKey !== key) {
        await pause(
          job,
          "L’identité du compte connecté a changé. Revenez au compte utilisé au lancement.",
        );
        return;
      }
      job.ownerKey = key;
      if (!key) job.skipIds = [];
      if (!job.planned) {
        const { processedHistory } =
          await chrome.storage.local.get("processedHistory");
        job.skipIds = job.force ? [] : [...getKnown(processedHistory, key)];
        job.planned = true;
      }
      job.phase = "delay";
      job.nextAt = Date.now();
      job.message = "Blocage en cours…";
      await chrome.storage.local.set({
        job,
        lastConfirmedAccount: key ? { key, username: message.owner } : null,
      });
      await drive();
      return;
    }
    if (message.type !== "blockResult" || job.phase !== "blocking") return;
    if (["blocked", "already"].includes(message.outcome)) {
      if (message.identityVerified !== false)
        await record(job, job.accounts[job.index].id);
      if (message.outcome === "blocked") job.created = (job.created || 0) + 1;
      else job.already = (job.already || 0) + 1;
      job.confirmed++;
      job.index++;
    } else if (message.outcome === "unavailable") {
      job.failed.push(job.accounts[job.index]);
      job.index++;
    } else {
      if (["rate", "loading"].includes(message.code)) {
        await recover(job, message.code, message.error);
        return;
      }
      await pause(
        job,
        message.error ||
          "X a interrompu le blocage. Ouvrez l’onglet X, puis cliquez pour reprendre.",
      );
      return;
    }
    job.retries = 0;
    if (job.index >= job.accounts.length) {
      await finish(job);
      return;
    }
    job.phase = "delay";
    job.nextAt =
      Date.now() + (message.outcome === "already" ? 100 : NEXT_DELAY);
    job.message = `${job.confirmed} / ${job.accounts.length} comptes bloqués…`;
    await save(job);
    await schedule(job.nextAt);
  }
  return {
    dispatch(message, sender = {}) {
      if (message?.type === "state")
        return chrome.storage.local.get(["list", "job", "checkedAt"]);
      if (message?.type === "refresh") return list();
      return locked(async () => {
        if (message?.type === "navigateFailed") {
          const job = await read();
          if (
            job?.status !== "running" ||
            job.phase !== "loading" ||
            !job.softNavigation ||
            job.tabId !== sender.tab?.id ||
            sender.frameId !== 0 ||
            job.id !== message.jobId ||
            job.attempt !== message.attempt
          )
            return;
          if (message.code === "rate") {
            await recover(job, "rate", message.error);
            return;
          }
          job.softNavigation = false;
          job.navigationFallback = true;
          job.documentReady = false;
          await save(job);
          try {
            await chrome.tabs.update(job.tabId, {
              url: `https://x.com/${job.accounts[job.index].username}`,
            });
            await schedule(Date.now() + 1000);
          } catch {
            await pause(
              job,
              "L’onglet de blocage a été fermé. Cliquez pour reprendre.",
            );
          }
          return;
        }
        if (message?.type === "ready") {
          const job = await read();
          if (
            job?.status !== "running" ||
            job.tabId !== sender.tab?.id ||
            sender.frameId !== 0 ||
            (message.jobId &&
              (message.jobId !== job.id || message.attempt !== job.attempt)) ||
            !["loading", "sessionLoading"].includes(job.phase)
          )
            return;
          const expected =
            job.phase === "sessionLoading"
              ? job.sessionPath || "/home"
              : `/${job.accounts[job.index].username.toLowerCase()}`;
          const url = new URL(message.url || sender.url);
          if (
            url.hostname !== "x.com" ||
            url.pathname.toLowerCase() !== expected
          )
            return;
          job.documentReady = true;
          await save(job);
          await drive();
          return;
        }
        if (["sessionResult", "blockResult"].includes(message?.type))
          return result(message, sender);
        const old = await read();
        if (message?.type === "inspect") {
          if (old?.status === "paused") {
            const tab = await chrome.tabs.get(old.tabId);
            if (new URL(tab.url).hostname === "x.com") {
              await chrome.tabs.update(tab.id, { active: true });
              await chrome.windows.update(tab.windowId, { focused: true });
            }
          }
          return;
        }
        if (message?.type === "cancel") {
          clearTimeout(wakeTimer);
          if (old) {
            old.status = "cancelled";
            old.message = "Arrêté. Les blocages déjà faits restent actifs.";
            await save(old);
            await abortTask(old);
            await closeOwnedTab(old);
          }
          await chrome.alarms.clear(ALARM);
          return;
        }
        if (!["start", "rescan"].includes(message?.type))
          throw new Error("Commande inconnue.");
        if (old?.status === "running") return;
        const resume = message.type === "start" && old?.status === "paused";
        if (old?.status === "paused" && old.retryAt > Date.now())
          throw Error(
            "X demande encore une pause. Attendez la fin du décompte avant de reprendre.",
          );
        const accounts = resume ? old.accounts : (await list()).accounts;
        if (!accounts.length)
          throw new Error("La liste est vide pour le moment.");
        const work = await workspace(old?.status === "paused" ? old : null);
        if (old?.status === "paused" && work.tabId !== old.tabId)
          await closeOwnedTab(old);
        const job = resume
          ? old
          : {
              id: crypto.randomUUID(),
              accounts,
              index: 0,
              confirmed: 0,
              failed: [],
              owner: null,
              ownerKey: null,
              created: 0,
              already: 0,
              cached: 0,
              startedAt: Date.now(),
              force: message.type === "rescan",
            };
        Object.assign(job, {
          status: "running",
          phase: "sessionLoading",
          ...work,
          softNavigation: false,
          attempt: crypto.randomUUID(),
          deadline: Date.now() + LOAD_TIMEOUT,
          retryAt: null,
          message: "Vérification de votre session X…",
        });
        await save(job);
        await schedule(Date.now() + 250);
      });
    },
    tick: () => locked(drive),
    startup: () =>
      locked(async () => {
        const job = await read();
        if (job?.status === "running")
          await pause(
            job,
            "Le navigateur a redémarré. Cliquez pour reprendre.",
          );
      }),
  };
}
