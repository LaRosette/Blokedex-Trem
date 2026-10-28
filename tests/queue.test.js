import { test } from "node:test";
import assert from "node:assert/strict";
import { createRunner } from "../extension/runner.js";
const accounts = [
  { id: "11", username: "CompteTest_A" },
  { id: "12", username: "CompteTest_B" },
];
function fixture() {
  const local = {},
    alarms = new Map(),
    tabs = new Map(),
    createdTabs = [];
  const currentWindow = { id: 1, type: "normal", focused: true };
  let id = 0;
  const api = {
    storage: {
      local: {
        get: async (keys) =>
          Object.fromEntries(
            (Array.isArray(keys) ? keys : [keys]).map((key) => [
              key,
              structuredClone(local[key]),
            ]),
          ),
        set: async (value) => Object.assign(local, structuredClone(value)),
      },
    },
    alarms: {
      create: async (name, options) => alarms.set(name, options),
      clear: async (name) => alarms.delete(name),
    },
    tabs: {
      create: async (options) => {
        createdTabs.push(options);
        const tab = { id: ++id, ...options, status: "complete", windowId: 1 };
        tabs.set(id, tab);
        return tab;
      },
      get: async (id) => {
        if (!tabs.has(id)) throw Error("closed");
        return tabs.get(id);
      },
      remove: async (id) => {
        f.events.push({ type: "remove", id });
        if (f.removeError) throw f.removeError;
        return tabs.delete(id);
      },
      update: async (id, change) => {
        f.events.push({ type: "update", id, ...change });
        if (!tabs.has(id)) throw Error("closed");
        Object.assign(tabs.get(id), change);
        return tabs.get(id);
      },
      sendMessage: async (id, msg) => {
        f.events.push({ type: "message", id, ...msg });
        if (msg.type === "abort") {
          if (f.abortError) throw f.abortError;
          if (f.abortSupported === false) return undefined;
          return { aborted: true };
        }
        if (msg.type === "navigate") return { accepted: !!f.softNavigation };
        f.sent = msg;
        if (f.rpcError) throw f.rpcError;
        if (msg.type === "probe" && f.probe) return f.probe;
        return { accepted: true };
      },
    },
    windows: {
      create: async () => {
        throw Error("Ne doit pas créer une fenêtre");
      },
      update: async (id, change) => Object.assign(currentWindow, change),
    },
  };
  const f = {
    local,
    alarms,
    tabs,
    createdTabs,
    events: [],
    sent: null,
    fetcher: async () =>
      new Response(
        JSON.stringify({ schemaVersion: 1, version: "test", accounts }),
      ),
  };
  f.runner = createRunner(
    api,
    { listUrl: "https://list.example/list.json" },
    (...args) => f.fetcher(...args),
    () => {},
  );
  f.result = (type, data = {}, tabId = local.job.tabId) =>
    f.runner.dispatch(
      { type, jobId: local.job.id, attempt: local.job.attempt, ...data },
      { tab: { id: tabId }, frameId: 0 },
    );
  f.begin = async (
    owner = "CompteTest",
    ownerKey = null,
    command = "start",
  ) => {
    await f.runner.dispatch({ type: command });
    await f.runner.tick();
    await f.result("sessionResult", { owner, ownerKey });
    await f.runner.tick();
  };
  return f;
}

test("un clic ouvre un seul onglet sans le rendre actif", async () => {
  const f = fixture();
  await f.begin();
  assert.equal(f.local.job.phase, "blocking");
  assert.equal(f.sent.type, "block");
  assert.equal(f.sent.account.username, "CompteTest_A");
  assert.equal(f.local.job.owner, "CompteTest");
  assert.deepEqual(f.createdTabs, [
    { url: "https://x.com/home", active: false },
  ]);
  assert.equal(f.tabs.get(f.local.job.tabId).muted, true);
  assert.equal(f.tabs.get(f.local.job.tabId).autoDiscardable, false);
});
test("succès et compte déjà bloqué comptent sans jamais débloquer", async () => {
  const f = fixture();
  await f.begin();
  await f.result("blockResult", { outcome: "blocked" });
  f.local.job.nextAt = 0;
  await f.runner.tick();
  await f.runner.tick();
  await f.result("blockResult", { outcome: "already" });
  assert.equal(f.local.job.status, "done");
  assert.equal(f.local.job.confirmed, 2);
  assert.equal(f.tabs.size, 0);
});
test("un compte indisponible est conservé dans le bilan et les suivants continuent", async () => {
  const f = fixture();
  await f.begin();
  await f.result("blockResult", { outcome: "unavailable" });
  assert.equal(f.local.job.index, 1);
  assert.equal(f.local.job.confirmed, 0);
  assert.equal(f.local.job.failed.length, 1);
});
test("un blocage déjà visible sans identité numérique ne remplit pas le cache", async () => {
  const f = fixture();
  await f.begin("CompteTest", "a".repeat(64));
  await f.result("blockResult", {
    outcome: "already",
    identityVerified: false,
  });
  assert.equal(f.local.job.index, 1);
  assert.equal(f.local.job.already, 1);
  assert.equal(f.local.processedHistory, undefined);
});
test("refuse les résultats venant d’un autre onglet ou d’une tentative ancienne", async () => {
  const f = fixture();
  await f.begin();
  await f.result("blockResult", { outcome: "blocked" }, 999);
  assert.equal(f.local.job.index, 0);
  await f.result("blockResult", { outcome: "blocked", attempt: "old" });
  assert.equal(f.local.job.index, 0);
});
test("erreur de X met en pause et un clic reprend sans perdre la progression", async () => {
  const f = fixture();
  await f.begin();
  await f.result("blockResult", {
    outcome: "error",
    error: "Vérification X nécessaire",
  });
  assert.equal(f.local.job.status, "paused");
  await f.runner.dispatch({ type: "start" });
  await f.runner.tick();
  await f.result("sessionResult", { owner: "CompteTest" });
  await f.runner.tick();
  assert.equal(f.local.job.index, 0);
  assert.equal(f.local.job.phase, "blocking");
  assert.equal(f.createdTabs.length, 1);
});
test("un changement de compte X bloque la reprise", async () => {
  const f = fixture();
  await f.begin();
  await f.result("blockResult", { outcome: "error" });
  await f.runner.dispatch({ type: "start" });
  await f.runner.tick();
  await f.result("sessionResult", { owner: "AutreCompte" });
  assert.equal(f.local.job.status, "paused");
});
test("le redémarrage du navigateur suspend et l’arrêt ferme seulement l’onglet de travail", async () => {
  const f = fixture();
  await f.begin();
  await f.runner.startup();
  assert.equal(f.local.job.status, "paused");
  await f.runner.dispatch({ type: "cancel" });
  assert.equal(f.local.job.status, "cancelled");
  assert.equal(f.tabs.size, 0);
});

test("Annuler invalide la tâche avant de fermer l’onglet même si sa fermeture échoue", async () => {
  const f = fixture();
  await f.begin("CompteTest", "a".repeat(64));
  const { id, attempt, tabId } = f.local.job;
  f.events.length = 0;
  f.removeError = Error("Fermeture indisponible");
  await f.runner.dispatch({ type: "cancel" });
  assert.equal(f.local.job.status, "cancelled");
  assert.deepEqual(f.events[0], {
    type: "abort",
    id: tabId,
    jobId: id,
    attempt,
  });
  assert.equal(f.events[1].type, "remove");
  assert.equal(f.tabs.has(tabId), true);
  await f.result("blockResult", { outcome: "blocked" });
  assert.equal(f.local.job.index, 0);
  assert.equal(f.local.job.confirmed, 0);
  assert.equal(f.local.processedHistory, undefined);
});

test("une pause et une récupération invalident la tentative encore active", async (t) => {
  for (const reason of ["pause", "timeout"]) {
    await t.test(reason, async () => {
      const f = fixture();
      await f.begin();
      const { id, attempt, tabId } = f.local.job;
      f.events.length = 0;
      if (reason === "pause")
        await f.result("blockResult", { outcome: "error", code: "identity" });
      else {
        f.local.job.deadline = 0;
        await f.runner.tick();
      }
      assert.deepEqual(f.events[0], {
        type: "abort",
        id: tabId,
        jobId: id,
        attempt,
      });
      assert.equal(
        reason === "pause" ? f.local.job.status : f.local.job.phase,
        reason === "pause" ? "paused" : "cooldown",
      );
      await f.result("blockResult", { outcome: "blocked" });
      assert.equal(f.local.job.index, 0);
      assert.equal(f.local.job.confirmed, 0);
    });
  }
});

test("une reprise invalide l’ancienne tentative avant de réutiliser le même document", async () => {
  const f = fixture();
  await f.begin();
  const { id, attempt, tabId } = f.local.job;
  await f.result("blockResult", { outcome: "error" });
  f.events.length = 0;
  f.probe = { owner: "CompteTest", url: f.tabs.get(tabId).url };
  await f.runner.dispatch({ type: "start" });
  assert.deepEqual(f.events[0], {
    type: "abort",
    id: tabId,
    jobId: id,
    attempt,
  });
  assert.equal(f.events[1].type, "probe");
  assert.equal(f.local.job.documentReady, true);
  assert.equal(f.createdTabs.length, 1);
  assert.notEqual(f.local.job.attempt, attempt);
  assert.equal(f.tabs.get(tabId).url, "https://x.com/CompteTest_A");
  await f.runner.tick();
  await f.result("blockResult", { outcome: "blocked", attempt });
  assert.equal(f.local.job.index, 0);
});

test("un ancien script sans annulation est rechargé au lieu de conserver sa tâche", async () => {
  const f = fixture();
  await f.begin();
  const tabId = f.local.job.tabId;
  f.abortSupported = false;
  f.events.length = 0;
  await f.result("blockResult", { outcome: "error" });
  assert.equal(f.local.job.status, "paused");
  assert.equal(f.tabs.get(tabId).url, "https://x.com/home");
  assert.equal(f.events[0].type, "abort");
  assert.equal(f.events[1].type, "update");
  f.events.length = 0;
  await f.runner.dispatch({ type: "start" });
  assert.equal(f.local.job.documentReady, false);
  assert.equal(
    f.events.some((event) => event.type === "probe"),
    false,
  );
});
test("une liste invalide ou inaccessible ne lance aucun blocage", async () => {
  const f = fixture();
  f.fetcher = async () => new Response("invalid");
  await assert.rejects(f.runner.dispatch({ type: "start" }));
  assert.equal(f.tabs.size, 0);
});
test("une réponse perdue déclenche une récupération bornée puis une pause", async () => {
  const f = fixture();
  await f.begin();
  f.local.job.deadline = 0;
  await f.runner.tick();
  assert.equal(f.local.job.phase, "cooldown");
  f.local.job.retryAt = 0;
  await f.runner.tick();
  f.local.job.deadline = 0;
  await f.runner.tick();
  assert.equal(f.local.job.status, "paused");
  assert.equal(f.local.job.index, 0);
});

test("un script absent conserve l’échéance puis déclenche la récupération", async (t) => {
  for (const command of ["inspect", "block"]) {
    await t.test(command, async () => {
      const f = fixture();
      await f.runner.dispatch({ type: "start" });
      if (command === "block") {
        await f.runner.tick();
        await f.result("sessionResult", { owner: "CompteTest" });
      }
      const deadline = Date.now() + 10000;
      f.local.job.deadline = deadline;
      f.rpcError = Error("Receiving end does not exist");
      for (let attempt = 0; attempt < 3; attempt++) {
        await f.runner.tick();
        assert.equal(f.sent.type, command);
        assert.equal(
          f.local.job.phase,
          command === "inspect" ? "sessionLoading" : "loading",
        );
        assert.equal(f.local.job.deadline, deadline);
        assert.equal(f.local.job.index, 0);
      }
      f.local.job.deadline = 0;
      await f.runner.tick();
      assert.equal(f.local.job.phase, "cooldown");
      assert.equal(f.local.job.retries, 1);
      assert.equal(f.local.job.confirmed, 0);
    });
  }
});

test("deux reprises après limitation X sont suivies d’une pause de quinze minutes", async () => {
  const f = fixture();
  const owner = "UtilisateurA";
  const ownerKey = "a".repeat(64);
  await f.begin(owner, ownerKey);
  for (let attempt = 0; attempt < 2; attempt++) {
    const before = Date.now();
    await f.result("blockResult", { outcome: "error", code: "rate" });
    const retryAt = f.local.job.retryAt;
    assert.equal(f.local.job.status, "running");
    assert.equal(f.local.job.phase, "cooldown");
    assert.equal(f.local.job.retries, attempt + 1);
    assert.ok(retryAt >= before + 60000 * 2 ** attempt);
    assert.equal(f.alarms.get("block-next").when, retryAt);
    await f.runner.tick();
    assert.equal(f.local.job.phase, "cooldown");
    assert.equal(f.local.job.retryAt, retryAt);
    f.local.job.retryAt = 0;
    await f.runner.tick();
    await f.runner.tick();
    await f.result("sessionResult", { owner, ownerKey });
    await f.runner.tick();
    assert.equal(f.local.job.phase, "blocking");
    assert.equal(f.local.job.index, 0);
  }
  const before = Date.now();
  await f.result("blockResult", { outcome: "error", code: "rate" });
  assert.equal(f.local.job.status, "paused");
  assert.equal(f.local.job.retries, 2);
  assert.ok(f.local.job.retryAt >= before + 15 * 60000);
  assert.equal(f.local.job.index, 0);
  assert.equal(f.local.job.confirmed, 0);
  assert.equal(f.createdTabs.length, 1);
  assert.equal(f.alarms.has("block-next"), false);
  await assert.rejects(f.runner.dispatch({ type: "start" }), /pause/);
  await assert.rejects(f.runner.dispatch({ type: "rescan" }), /pause/);
});

test("un nouveau passage saute les comptes déjà traités pour le même compte", async () => {
  const f = fixture();
  const key = "a".repeat(64);
  await f.begin("UtilisateurA", key);
  await f.result("blockResult", { outcome: "blocked" });
  f.local.job.nextAt = 0;
  await f.runner.tick();
  await f.runner.tick();
  await f.result("blockResult", { outcome: "already" });
  assert.equal(f.local.job.created, 1);
  assert.equal(f.local.job.already, 1);
  await f.begin("UtilisateurA", key);
  assert.equal(f.local.job.status, "done");
  assert.equal(f.local.job.cached, 2);
  assert.equal(f.local.job.created, 0);
  assert.equal(f.local.job.confirmed, 2);
  assert.equal(f.tabs.size, 0);
});

test("le cache ne passe jamais d’un utilisateur à l’autre", async () => {
  const f = fixture();
  const key = "a".repeat(64);
  await f.begin("UtilisateurA", key);
  await f.result("blockResult", { outcome: "blocked" });
  await f.runner.dispatch({ type: "cancel" });
  await f.begin("UtilisateurB", "b".repeat(64));
  assert.equal(f.local.job.cached, 0);
  assert.equal(f.local.job.phase, "blocking");
  assert.equal(f.sent.account.id, "11");
});

test("Tout revérifier ignore le cache et conserve une liste fraîche", async () => {
  const f = fixture();
  const key = "a".repeat(64);
  await f.begin("UtilisateurA", key);
  await f.result("blockResult", { outcome: "blocked" });
  await f.runner.dispatch({ type: "cancel" });
  await f.begin("UtilisateurA", key, "rescan");
  assert.equal(f.local.job.force, true);
  assert.equal(f.local.job.cached, 0);
  assert.equal(f.sent.account.id, "11");
});

test("la limitation de X impose une pause même pour Tout revérifier", async () => {
  const f = fixture();
  await f.begin();
  await f.result("blockResult", { outcome: "error", code: "rate" });
  assert.equal(f.local.job.phase, "cooldown");
  assert.ok(f.local.job.retryAt > Date.now() + 59000);
  f.local.job.status = "paused";
  await assert.rejects(f.runner.dispatch({ type: "start" }), /pause/);
  await assert.rejects(f.runner.dispatch({ type: "rescan" }), /pause/);
});

test("une identité de compte différente bloque la reprise du cache", async () => {
  const f = fixture();
  await f.begin("UtilisateurA", "a".repeat(64));
  await f.result("blockResult", { outcome: "error" });
  await f.runner.dispatch({ type: "start" });
  await f.runner.tick();
  await f.result("sessionResult", {
    owner: "UtilisateurA",
    ownerKey: "b".repeat(64),
  });
  assert.equal(f.local.job.status, "paused");
  assert.match(f.local.job.message, /identité/);
});

test("une identité devenue indisponible suspend la reprise et conserve la clé connue", async () => {
  const f = fixture();
  const key = "a".repeat(64);
  f.local.processedHistory = [
    {
      key,
      username: "UtilisateurA",
      ids: ["12"],
      updatedAt: Date.now(),
    },
  ];
  await f.begin("UtilisateurA", key);
  await f.result("blockResult", { outcome: "error" });
  await f.runner.dispatch({ type: "start" });
  await f.runner.tick();
  await f.result("sessionResult", {
    owner: "UtilisateurA",
    ownerKey: null,
  });
  assert.equal(f.local.job.status, "paused");
  assert.equal(f.local.job.ownerKey, key);
  assert.equal(f.local.job.index, 0);
  assert.equal(f.local.job.confirmed, 0);
  assert.deepEqual(f.local.job.skipIds, ["12"]);
  assert.equal(f.sent.type, "inspect");
});

test("un premier passage sans clé fonctionne sans enregistrer ni réutiliser de cache", async () => {
  const f = fixture();
  await f.begin("UtilisateurA", null);
  assert.equal(f.local.job.ownerKey, null);
  assert.deepEqual(f.local.job.skipIds, []);
  assert.equal(f.local.job.cached, 0);
  assert.equal(f.sent.account.id, "11");
  await f.result("blockResult", { outcome: "blocked" });
  assert.equal(f.local.processedHistory, undefined);
  f.local.job.nextAt = 0;
  await f.runner.tick();
  await f.runner.tick();
  assert.equal(f.sent.account.id, "12");
  await f.result("blockResult", { outcome: "blocked" });
  assert.equal(f.local.job.status, "done");
  assert.equal(f.local.job.created, 2);
  assert.equal(f.local.job.confirmed, 2);
  assert.equal(f.local.processedHistory, undefined);
  await f.begin("UtilisateurA", null);
  assert.equal(f.local.job.phase, "blocking");
  assert.equal(f.local.job.cached, 0);
  assert.equal(f.sent.account.id, "11");
});
test("le signal du contenu permet de traiter avant le chargement complet", async () => {
  const f = fixture();
  await f.runner.dispatch({ type: "start" });
  const id = f.local.job.tabId;
  f.tabs.get(id).status = "loading";
  await f.runner.dispatch(
    { type: "ready" },
    { tab: { id }, frameId: 0, url: "https://x.com/CompteTest_A" },
  );
  assert.equal(f.local.job.phase, "sessionLoading");
  await f.runner.dispatch(
    { type: "ready" },
    { tab: { id }, frameId: 0, url: "https://x.com/home" },
  );
  assert.equal(f.local.job.phase, "inspecting");
});
test("la pause entre profils est réduite à 250 ms", async () => {
  const f = fixture();
  await f.begin();
  const before = Date.now();
  await f.result("blockResult", { outcome: "blocked" });
  assert.ok(f.local.job.nextAt - before <= 300);
});
test("l’onglet X est activé seulement sur demande en cas de pause", async () => {
  const f = fixture();
  await f.begin();
  const id = f.local.job.tabId;
  await f.runner.dispatch({ type: "inspect" });
  assert.equal(f.tabs.get(id).active, false);
  await f.result("blockResult", { outcome: "error" });
  await f.runner.dispatch({ type: "inspect" });
  assert.equal(f.tabs.get(id).active, true);
  await f.runner.dispatch({ type: "start" });
  assert.equal(f.createdTabs.length, 1);
  assert.equal(f.local.job.tabId, id);
});

test("une navigation attend le nouveau document avant de lire son URL", async () => {
  const f = fixture();
  await f.runner.dispatch({ type: "start" });
  await f.runner.tick();
  await f.result("sessionResult", { owner: "CompteTest" });
  assert.equal(f.local.job.phase, "loading");
  assert.equal(f.local.job.status, "running");
  const tab = f.tabs.get(f.local.job.tabId);
  await f.runner.dispatch(
    { type: "ready" },
    { tab: { id: tab.id }, frameId: 0, url: tab.url },
  );
  assert.equal(f.local.job.phase, "blocking");
});

test("une navigation interne conserve la page et attend le bon profil", async () => {
  const f = fixture();
  f.softNavigation = true;
  await f.runner.dispatch({ type: "start" });
  await f.runner.tick();
  await f.result("sessionResult", { owner: "CompteTest" });
  assert.equal(f.local.job.softNavigation, true);
  const tab = f.tabs.get(f.local.job.tabId);
  assert.equal(tab.url, "https://x.com/home");
  await f.runner.tick();
  assert.equal(f.local.job.phase, "loading");
  tab.url = "https://x.com/CompteTest_A";
  await f.runner.dispatch(
    {
      type: "ready",
      url: tab.url,
      jobId: f.local.job.id,
      attempt: f.local.job.attempt,
    },
    { tab: { id: tab.id }, frameId: 0, url: "https://x.com/home" },
  );
  assert.equal(f.local.job.phase, "blocking");
});

test("un routeur indisponible déclenche une seule navigation de secours", async () => {
  const f = fixture();
  f.softNavigation = true;
  await f.runner.dispatch({ type: "start" });
  await f.runner.tick();
  await f.result("sessionResult", { owner: "CompteTest" });
  await f.result("navigateFailed", { attempt: "ancienne" });
  assert.equal(f.local.job.softNavigation, true);
  await f.result("navigateFailed");
  assert.equal(f.local.job.softNavigation, false);
  assert.equal(f.tabs.get(f.local.job.tabId).url, "https://x.com/CompteTest_A");
});
