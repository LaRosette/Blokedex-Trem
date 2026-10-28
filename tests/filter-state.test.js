import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createFilterStore,
  isXPage,
  LIST_ALARM,
  LIST_INTERVAL,
} from "../extension/filter-state.js";

const listUrl =
  "https://raw.githubusercontent.com/LaRosette/Blokedex-Trem/main/liste/accounts.json";
const catalogUrl = "chrome-extension://test-extension/catalog.json";
const oldKeys = [
  "job",
  "processedHistory",
  "lastConfirmedAccount",
  "listAlertSeen",
  "listAlertPending",
  "listAlertBaseline",
];
const profile = (id) => ({ id: String(id), username: "Compte_" + id });
const list = (...ids) => ({
  schemaVersion: 1,
  version: "test-" + ids.join("-"),
  accounts: ids.map(profile),
});
const response = (value) => new Response(JSON.stringify(value));
function deferred() {
  let resolve;
  const promise = new Promise((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function fixture(initial = {}) {
  const f = {
    local: structuredClone(initial),
    now: 1_000_000_000,
    events: [],
    tabs: [],
    alarms: new Map([
      ["block-next", {}],
      ["check-list-additions", {}],
    ]),
    catalog: list(11, 12),
    remote: async () => response(list(11, 12)),
    abort: async () => ({ aborted: true }),
  };
  const forbidden =
    (name) =>
    async (...args) => {
      f.events.push({ type: name, args });
      throw Error("Le filtre local ne doit pas appeler " + name);
    };
  f.api = {
    runtime: { getURL: (name) => "chrome-extension://test-extension/" + name },
    storage: {
      local: {
        get: async (keys) =>
          Object.fromEntries(
            (Array.isArray(keys) ? keys : [keys]).map((key) => [
              key,
              structuredClone(f.local[key]),
            ]),
          ),
        set: async (values) => {
          Object.assign(f.local, structuredClone(values));
          f.events.push({ type: "set", values: structuredClone(values) });
        },
        remove: async (keys) => {
          f.events.push({ type: "removeKeys", keys: [...keys] });
          for (const key of keys) delete f.local[key];
        },
        setAccessLevel: async (options) =>
          f.events.push({ type: "access", ...options }),
      },
    },
    alarms: {
      clear: async (name) => {
        f.events.push({ type: "clearAlarm", name });
        return f.alarms.delete(name);
      },
      create: async (name, options) => {
        f.events.push({ type: "createAlarm", name, ...options });
        f.alarms.set(name, structuredClone(options));
      },
    },
    tabs: {
      query: async (options) => {
        f.events.push({ type: "queryTabs", options: structuredClone(options) });
        return structuredClone(f.tabs);
      },
      sendMessage: async (id, message, options) => {
        f.events.push({
          type: "message",
          id,
          message: structuredClone(message),
          options: structuredClone(options),
          persistedEnabled: f.local.filterEnabled,
          persistedRevision: f.local.filterRevision,
        });
        return message.type === "abort" ? f.abort() : undefined;
      },
      create: forbidden("createTab"),
      update: forbidden("navigateTab"),
      remove: forbidden("closeTab"),
    },
    windows: {
      create: forbidden("createWindow"),
      update: forbidden("focusWindow"),
    },
    action: {
      setBadgeText: async (options) =>
        f.events.push({ type: "badge", ...options }),
      setBadgeBackgroundColor: async () => {},
      setTitle: async (options) => f.events.push({ type: "title", ...options }),
    },
  };
  f.fetcher = async (url, options) => {
    f.events.push({ type: "fetch", url, options });
    if (url === catalogUrl) return response(f.catalog);
    assert.equal(
      url,
      listUrl,
      "Seule la liste configurée peut être téléchargée",
    );
    return f.remote();
  };
  f.newStore = () =>
    createFilterStore(f.api, { listUrl }, f.fetcher, () => f.now);
  f.store = f.newStore();
  f.fetches = (url = listUrl) =>
    f.events.filter((event) => event.type === "fetch" && event.url === url);
  f.messages = (type = "applyFilter") =>
    f.events.filter(
      (event) => event.type === "message" && event.message.type === type,
    );
  return f;
}
const installed = (extra = {}) => ({
  filterSchema: 3,
  filterEnabled: false,
  filterRevision: 0,
  filterAdded: [],
  list: list(11, 12),
  checkedAt: 100,
  ...extra,
});

test("la migration arrête l'ancien job sans naviguer, fermer ou ouvrir un onglet", async () => {
  const job = {
    id: "ancien-job",
    attempt: "ancien-essai",
    tabId: 17,
    status: "running",
  };
  const f = fixture({
    job,
    processedHistory: [{ username: "AncienCompte", ids: ["11"] }],
    lastConfirmedAccount: { username: "AncienCompte" },
    listAlertSeen: ["11"],
    listAlertPending: ["12"],
    listAlertBaseline: "old",
    filterEnabled: true,
    filterRevision: 9,
    list: list(11, 12),
    checkedAt: 10,
    latestRelease: { schemaVersion: 1, version: "3.0.0" },
  });
  await Promise.all([f.store.initialize(), f.store.initialize()]);
  assert.deepEqual(
    f.messages("abort").map((event) => [event.id, event.message]),
    [[17, { type: "abort", jobId: job.id, attempt: job.attempt }]],
  );
  for (const key of oldKeys)
    assert.equal(Object.hasOwn(f.local, key), false, key);
  assert.equal(f.local.filterSchema, 3);
  assert.equal(f.local.filterEnabled, false);
  assert.equal(f.local.filterRevision, 0);
  assert.deepEqual(f.local.filterAdded, []);
  assert.deepEqual(f.local.latestRelease, {
    schemaVersion: 1,
    version: "3.0.0",
  });
  assert.deepEqual([...f.alarms], [[LIST_ALARM, { periodInMinutes: 360 }]]);
  assert.equal(f.fetches(catalogUrl).length, 0);
  assert.equal(f.fetches().length, 0);
  assert.equal(
    f.events.filter((event) =>
      /^(?:createTab|navigateTab|closeTab|createWindow|focusWindow)$/.test(
        event.type,
      ),
    ).length,
    0,
  );
  assert.ok(
    f.events.findIndex((event) => event.type === "message") <
      f.events.findIndex((event) => event.type === "removeKeys"),
  );
});

test("un ancien onglet absent n'empêche pas d'effacer les données et de désactiver le filtre", async () => {
  const f = fixture({
    job: { id: "old", attempt: "old", tabId: 7 },
    list: list(11),
  });
  f.abort = async () => {
    throw Error("Le document n'existe plus");
  };
  await f.store.initialize();
  assert.equal(f.messages("abort").length, 1);
  assert.equal(f.local.filterEnabled, false);
  assert.equal(Object.hasOwn(f.local, "job"), false);
  assert.equal(
    f.events.some((event) =>
      /^(?:createTab|navigateTab|closeTab)$/.test(event.type),
    ),
    false,
  );
});

test("une initialisation 3.0 conserve le choix de l'utilisateur et partage un seul chargement du catalogue", async () => {
  const f = fixture(
    installed({
      filterEnabled: true,
      filterRevision: 8,
      list: { invalid: true },
    }),
  );
  const results = await Promise.all([
    f.store.initialize(),
    f.store.snapshot(),
    f.store.contentConfig(),
    f.store.initialize(),
  ]);
  assert.equal(f.fetches(catalogUrl).length, 1);
  assert.equal(f.fetches().length, 0);
  assert.equal(f.local.filterEnabled, true);
  assert.equal(f.local.filterRevision, 8);
  assert.equal(f.local.checkedAt, 0);
  assert.deepEqual(results[1].list, list(11, 12));
  assert.deepEqual(results[2], {
    enabled: true,
    revision: 8,
    usernames: ["Compte_11", "Compte_12"],
  });
  assert.deepEqual(
    f.events.filter((event) => event.type === "access"),
    [{ type: "access", accessLevel: "TRUSTED_CONTEXTS" }],
  );
  assert.equal(
    f.events.filter((event) => event.type === "createAlarm").length,
    1,
  );
  const request = f.fetches(catalogUrl)[0].options;
  assert.equal(request.credentials, "omit");
  assert.equal(request.redirect, "error");
});

test("un cache valide évite le catalogue et n'expose que les pseudonymes au script de page", async () => {
  const f = fixture(
    installed({
      filterEnabled: true,
      filterRevision: 4,
      list: {
        ...list(11),
        secret: "aucun-transfert",
        accounts: [{ ...profile(11), note: "interne" }],
      },
      job: { owner: "AncienCompte", tabId: 99 },
      processedHistory: [{ ids: ["11"] }],
    }),
  );
  assert.deepEqual(await f.store.contentConfig(), {
    enabled: true,
    revision: 4,
    usernames: ["Compte_11"],
  });
  assert.deepEqual((await f.store.snapshot()).list, list(11));
  assert.equal(f.fetches(catalogUrl).length, 0);
  assert.equal(f.messages("abort").length, 0);
});

test("un catalogue invalide échoue sans enregistrer la liste et l'initialisation peut être retentée", async () => {
  const f = fixture();
  f.catalog = list(11, 11);
  await assert.rejects(f.store.initialize(), /invalide/);
  assert.equal(f.local.list, undefined);
  f.catalog = list(11, 12);
  await f.store.initialize();
  assert.deepEqual(f.local.list, list(11, 12));
  assert.equal(f.fetches(catalogUrl).length, 2);
  assert.equal(f.local.filterEnabled, false);
});

test("activer ou mettre en pause exige un booléen et le réglage est enregistré avant diffusion", async () => {
  const f = fixture(installed({ filterAdded: ["12"] }));
  f.tabs = [{ id: 1, url: "https://x.com/home" }];
  for (const value of [undefined, null, 0, 1, "true", "false", {}, []])
    await assert.rejects(f.store.setEnabled(value), /Réglage invalide/);
  assert.equal(f.events.length, 0);
  await f.store.setEnabled(true);
  await f.store.setEnabled(false);
  assert.deepEqual(
    f.messages().map((event) => ({
      settings: event.message.settings,
      persisted: [event.persistedEnabled, event.persistedRevision],
    })),
    [
      {
        settings: {
          enabled: true,
          revision: 1,
          usernames: ["Compte_11", "Compte_12"],
        },
        persisted: [true, 1],
      },
      {
        settings: {
          enabled: false,
          revision: 2,
          usernames: ["Compte_11", "Compte_12"],
        },
        persisted: [false, 2],
      },
    ],
  );
  assert.equal(f.local.filterEnabled, false);
  assert.equal(f.local.filterRevision, 2);
  assert.deepEqual(f.local.filterAdded, ["12"]);
});

test("la diffusion cible seulement le cadre principal de X et Twitter, sans IDs ni ancien état", async () => {
  const f = fixture(installed({ filterRevision: 3 }));
  f.tabs = [
    { id: 1, url: "https://x.com/home" },
    { id: 2, url: "https://twitter.com/un_profil/status/123" },
    { id: 3, url: "https://x.com.evil.example/home" },
    { id: 4, url: "http://x.com/home" },
    { id: 5, url: "https://user@x.com/home" },
    { id: 6, url: "https://x.com:8443/home" },
    { id: 7, url: "https://evil.example/x.com" },
    { id: 8, url: "https://www.x.com/home" },
    { id: 9, url: "chrome://extensions/" },
    { id: 10 },
    { id: "11", url: "https://x.com/home" },
  ];
  await f.store.broadcast();
  assert.deepEqual(
    f.messages().map((event) => event.id),
    [1, 2],
  );
  for (const event of f.messages()) {
    assert.deepEqual(event.options, { frameId: 0 });
    assert.deepEqual(event.message, {
      type: "applyFilter",
      settings: {
        enabled: false,
        revision: 3,
        usernames: ["Compte_11", "Compte_12"],
      },
    });
  }
  assert.deepEqual(
    f.events.find((event) => event.type === "queryTabs").options,
    { url: ["https://x.com/*", "https://twitter.com/*"] },
  );
});

test("une panne réseau conserve le cache, l'activation, la révision et les ajouts", async () => {
  const f = fixture(
    installed({ filterEnabled: true, filterRevision: 8, filterAdded: ["12"] }),
  );
  f.remote = async () => {
    throw Error("Hors ligne");
  };
  await f.store.refresh({ force: true });
  assert.deepEqual(f.local.list, list(11, 12));
  assert.equal(f.local.checkedAt, 100);
  assert.equal(f.local.filterEnabled, true);
  assert.equal(f.local.filterRevision, 8);
  assert.deepEqual(f.local.filterAdded, ["12"]);
  assert.match(
    (await f.store.snapshot()).issue,
    /indisponible.*dernière liste/,
  );
  assert.equal(f.local.listAttemptedAt, f.now);
  assert.equal(f.messages().length, 0);
  const options = f.fetches()[0].options;
  assert.equal(options.credentials, "omit");
  assert.equal(options.redirect, "error");
  assert.equal(options.cache, "no-store");
});

test("une liste distante invalide ne remplace pas le cache et une nouvelle tentative reste possible", async () => {
  const f = fixture(installed());
  f.remote = async () => response(list(11, 11));
  await f.store.refresh({ force: true });
  assert.deepEqual(f.local.list, list(11, 12));
  assert.match(f.local.filterIssue, /indisponible/);
  f.remote = async () => response(list(11, 12, 13));
  await f.store.refresh({ force: true });
  assert.deepEqual(f.local.list, list(11, 12, 13));
  assert.equal(f.local.filterIssue, "");
  assert.equal(f.fetches().length, 2);
});

test("les actualisations concurrentes partagent une seule requête réseau", async () => {
  const f = fixture(installed());
  const started = deferred(),
    held = deferred();
  f.remote = async () => {
    started.resolve();
    return held.promise;
  };
  const first = f.store.refresh({ force: true });
  await started.promise;
  const second = f.store.refresh({ force: true }),
    third = f.store.refresh();
  held.resolve(response(list(11, 12, 13)));
  await Promise.all([first, second, third]);
  assert.equal(f.fetches().length, 1);
  assert.equal(f.local.filterRevision, 1);
  assert.deepEqual(f.local.filterAdded, ["13"]);
});

test("une demande forcée n'est pas absorbée par une lecture récente du cache", async () => {
  const f = fixture(installed({ listAttemptedAt: 1_000_000_000 }));
  await f.store.initialize();
  await f.store.refresh();
  assert.equal(f.fetches().length, 0);
  f.remote = async () => response(list(11, 12, 13));
  await Promise.all([
    f.store.refresh(),
    f.store.refresh({ force: true }),
    f.store.refresh({ force: true }),
  ]);
  assert.equal(f.fetches().length, 1);
  assert.deepEqual(f.local.list, list(11, 12, 13));
});

test("les demandes forcées arrivées pendant un contrôle automatique partagent une seconde requête fraîche", async () => {
  const f = fixture(installed());
  const started = deferred(),
    held = deferred();
  let requests = 0;
  f.remote = async () => {
    if (++requests === 1) {
      started.resolve();
      return held.promise;
    }
    return response(list(11, 12, 13, 14));
  };
  const automatic = f.store.refresh();
  await started.promise;
  const manual = f.store.refresh({ force: true }),
    otherManual = f.store.refresh({ force: true });
  held.resolve(response(list(11, 12, 13)));
  await Promise.all([automatic, manual, otherManual]);
  assert.equal(f.fetches().length, 2);
  assert.deepEqual(f.local.list, list(11, 12, 13, 14));
  assert.deepEqual(f.local.filterAdded, ["13", "14"]);
  assert.equal(f.local.filterRevision, 2);
});

test("le délai de six heures limite les tentatives, sans bloquer après un recul de l'horloge", async () => {
  const f = fixture(installed({ listAttemptedAt: 1_000_000_000 }));
  f.now += LIST_INTERVAL - 1;
  await f.store.refresh();
  assert.equal(f.fetches().length, 0);
  f.now += 1;
  await f.store.refresh();
  assert.equal(f.fetches().length, 1);
  f.now -= 60_000;
  await f.store.refresh();
  assert.equal(f.fetches().length, 2);
});

test("une réponse tardive préserve l'activation et l'acquittement enregistrés entre-temps", async () => {
  const f = fixture(installed({ filterRevision: 7, filterAdded: ["12"] }));
  f.tabs = [{ id: 1, url: "https://x.com/home" }];
  const started = deferred(),
    held = deferred();
  f.remote = async () => {
    started.resolve();
    return held.promise;
  };
  const refresh = f.store.refresh({ force: true });
  await started.promise;
  await f.store.setEnabled(true);
  await f.store.acknowledge();
  held.resolve(response(list(11, 12, 13)));
  await refresh;
  assert.equal(f.local.filterEnabled, true);
  assert.equal(f.local.filterRevision, 9);
  assert.deepEqual(f.local.filterAdded, ["13"]);
  assert.deepEqual(f.messages().at(-1).message.settings, {
    enabled: true,
    revision: 9,
    usernames: ["Compte_11", "Compte_12", "Compte_13"],
  });
  const restored = f.newStore();
  assert.deepEqual(await restored.contentConfig(), {
    enabled: true,
    revision: 9,
    usernames: ["Compte_11", "Compte_12", "Compte_13"],
  });
  assert.equal((await restored.snapshot()).addedCount, 1);
});

test("le premier téléchargement ne présente pas toute la liste comme nouvelle", async () => {
  const f = fixture();
  f.remote = async () => response(list(11, 12, 13));
  await f.store.refresh({ force: true });
  assert.equal(f.local.filterEnabled, false);
  assert.deepEqual(f.local.filterAdded, []);
  assert.equal((await f.store.snapshot()).addedCount, 0);
  f.remote = async () => response(list(11, 12, 13, 14));
  await f.store.refresh({ force: true });
  assert.deepEqual(f.local.filterAdded, ["14"]);
  assert.equal((await f.store.snapshot()).addedCount, 1);
  assert.equal(
    f.events.filter((event) => event.type === "badge").at(-1).text,
    "1",
  );
});

test("réordonner ne crée pas d'ajout et retirer un profil supprime son alerte", async () => {
  const f = fixture(installed({ filterAdded: ["12"] }));
  f.remote = async () => response(list(12, 11));
  await f.store.refresh({ force: true });
  assert.deepEqual(f.local.filterAdded, ["12"]);
  f.remote = async () => response(list(11));
  await f.store.refresh({ force: true });
  assert.deepEqual(f.local.filterAdded, []);
  assert.equal((await f.store.snapshot()).addedCount, 0);
  assert.equal(
    f.events.filter((event) => event.type === "badge").at(-1).text,
    "",
  );
});

test("acquitter l'information efface le badge sans désactiver le filtre ni changer la liste", async () => {
  const f = fixture(
    installed({ filterEnabled: true, filterRevision: 3, filterAdded: ["12"] }),
  );
  await f.store.acknowledge();
  assert.deepEqual(f.local.filterAdded, []);
  assert.equal(f.local.filterEnabled, true);
  assert.equal(f.local.filterRevision, 3);
  assert.deepEqual(f.local.list, list(11, 12));
  assert.equal(
    f.events.filter((event) => event.type === "badge").at(-1).text,
    "",
  );
  await f.store.refresh({ force: true });
  assert.equal((await f.store.snapshot()).addedCount, 0);
});

test("isXPage refuse les origines voisines, identifiants et protocoles non HTTPS", () => {
  for (const url of [
    "https://x.com/home",
    "https://twitter.com/Compte_11/status/1",
  ])
    assert.equal(isXPage(url), true, url);
  for (const url of [
    undefined,
    null,
    "",
    "bad",
    "http://x.com/",
    "https://x.com.evil.example/",
    "https://attacker@x.com/",
    "https://x.com:8443/",
    "https://www.x.com/",
    "javascript:alert(1)",
  ])
    assert.equal(isXPage(url), false, String(url));
});
