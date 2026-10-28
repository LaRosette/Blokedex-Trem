import { test } from "node:test";
import assert from "node:assert/strict";
import {
  calculateListUpdates,
  createListMonitor,
  LIST_CHECK_ALARM,
  LIST_CHECK_INTERVAL,
} from "../extension/list-alerts.js";

const keyA = "a".repeat(64),
  keyB = "b".repeat(64);
const profile = (id) => ({ id: String(id), username: "Compte_" + id });
const list = (...ids) => ({
  schemaVersion: 1,
  version: "test",
  accounts: ids.map(profile),
});
const row = (key, username, ids) => ({
  key,
  username,
  ids: ids.map(String),
  updatedAt: 1,
});
function fixture() {
  return {
    list: list(11, 12, 13),
    checkedAt: 1,
    job: {
      status: "done",
      owner: "CompteA",
      ownerKey: keyA,
      accounts: list(11, 12).accounts,
    },
    processedHistory: [row(keyA, "CompteA", [11])],
  };
}
function apply(stored) {
  const result = calculateListUpdates(stored, 100);
  stored.listAlertSeen = result.listAlertSeen;
  stored.listAlertPending = result.listAlertPending;
  return result.listUpdates;
}

test("une première installation sans compte ou historique ne crée pas d’alerte", () => {
  assert.equal(apply({ list: list(11, 12) }).available, false);
  const f = fixture();
  f.processedHistory = [];
  assert.equal(apply(f).available, false);
});
test("un vrai ajout est signalé, pas un ancien profil indisponible", () => {
  const f = fixture();
  assert.deepEqual(apply(f), {
    available: true,
    count: 1,
    username: "CompteA",
    checkedAt: 1,
  });
  assert.deepEqual(f.listAlertPending[0].ids, ["13"]);
  f.list = list(12, 13, 11);
  f.list.version = "reordered";
  assert.equal(apply(f).count, 1);
});
test("commencer ou interrompre le lot n’efface pas les ajouts non confirmés", () => {
  const f = fixture();
  apply(f);
  f.job = { ...f.job, accounts: f.list.accounts, status: "running" };
  assert.equal(apply(f).count, 1);
  f.job.status = "cancelled";
  assert.equal(apply(f).count, 1);
});
test("une confirmation ou un retrait de la liste solde l’alerte", () => {
  const f = fixture();
  apply(f);
  f.processedHistory[0].ids.push("13");
  assert.equal(apply(f).available, false);
  f.list = list(11, 12, 14);
  assert.equal(apply(f).count, 1);
  f.list = list(11, 12);
  assert.equal(apply(f).count, 0);
});
test("les confirmations d’un autre compte ne soldent jamais les ajouts du premier", () => {
  const f = fixture();
  apply(f);
  f.processedHistory.push(row(keyB, "CompteB", [11, 12, 13]));
  assert.equal(apply(f).count, 1);
  f.lastConfirmedAccount = { key: keyB, username: "CompteB" };
  assert.equal(apply(f).count, 0);
  f.lastConfirmedAccount = { key: keyA, username: "CompteA" };
  assert.equal(apply(f).count, 1);
});
test("un compte sans clé, sans historique ou incohérent ne récupère pas le badge précédent", () => {
  const f = fixture();
  apply(f);
  for (const marker of [
    null,
    { key: keyB, username: "CompteB" },
    { key: keyA, username: "AutreCompte" },
    { key: "invalide", username: "CompteA" },
  ]) {
    f.lastConfirmedAccount = marker;
    assert.equal(apply(f).available, false);
  }
});
test("les données locales invalides et les listes distantes invalides n’inventent pas d’alerte", () => {
  const f = fixture();
  f.list = {
    schemaVersion: 1,
    version: "bad",
    accounts: [profile(11), profile(11)],
  };
  assert.equal(apply(f).available, false);
  f.list = list(11, 12);
  f.listAlertPending = [{ ...row(keyA, "CompteA", [13]), key: "malformed" }];
  assert.equal(apply(f).available, false);
});
test("les historiques de suivi restent limités à cinq comptes", () => {
  const f = fixture();
  f.listAlertSeen = f.listAlertPending = Array.from({ length: 9 }, (_, i) =>
    row(String(i).repeat(64), "Compte" + i, [11]),
  );
  apply(f);
  assert.ok(f.listAlertSeen.length <= 5 && f.listAlertPending.length <= 5);
});

function monitorFixture() {
  const local = fixture(),
    badges = [],
    titles = [],
    alarms = new Map();
  const f = {
    local,
    badges,
    titles,
    alarms,
    clock: LIST_CHECK_INTERVAL + 100,
    refreshes: 0,
  };
  const api = {
    runtime: { getManifest: () => ({ name: "Blokedex-Trem" }) },
    storage: {
      local: {
        get: async (keys) =>
          Object.fromEntries(keys.map((k) => [k, structuredClone(local[k])])),
        set: async (values) => Object.assign(local, structuredClone(values)),
      },
    },
    action: {
      setBadgeText: async ({ text }) => badges.push(text),
      setTitle: async ({ title }) => titles.push(title),
      setBadgeBackgroundColor: async () => {},
    },
    alarms: {
      get: async (name) => alarms.get(name),
      create: async (name, value) => alarms.set(name, value),
    },
  };
  f.monitor = createListMonitor(
    api,
    async () => {
      f.refreshes++;
      if (f.failure) throw Error("network");
      local.checkedAt = f.clock;
    },
    () => f.clock,
  );
  return f;
}
test("le badge et son titre ne concernent que le dernier compte confirmé", async () => {
  const f = monitorFixture();
  await f.monitor.sync();
  assert.equal(f.badges.at(-1), "1");
  assert.match(f.titles.at(-1), /@CompteA/);
  f.local.lastConfirmedAccount = null;
  await f.monitor.sync();
  assert.equal(f.badges.at(-1), "");
  assert.equal(f.titles.at(-1), "Blokedex-Trem");
});
test("la pastille plafonne à 99+ sans perdre le vrai nombre", async () => {
  const f = monitorFixture();
  f.local.list = list(...Array.from({ length: 120 }, (_, i) => i + 11));
  const info = await f.monitor.sync();
  assert.equal(info.count, 118);
  assert.equal(f.badges.at(-1), "99+");
});
test("la cadence réseau et l’alarme sont distinctes de la file de blocage", async () => {
  const f = monitorFixture();
  await f.monitor.initialize();
  await f.monitor.initialize();
  assert.deepEqual([...f.alarms.keys()], [LIST_CHECK_ALARM]);
  assert.equal(f.alarms.get(LIST_CHECK_ALARM).periodInMinutes, 360);
  const snapshot = structuredClone(f.local.job);
  await Promise.all([f.monitor.check(), f.monitor.check()]);
  assert.equal(f.refreshes, 1);
  await f.monitor.check();
  assert.equal(f.refreshes, 1);
  f.clock += LIST_CHECK_INTERVAL;
  await f.monitor.check();
  assert.equal(f.refreshes, 2);
  assert.deepEqual(f.local.job, snapshot);
});
test("un échec réseau conserve les ajouts et évite une boucle de requêtes", async () => {
  const f = monitorFixture();
  f.failure = true;
  await assert.rejects(f.monitor.check(), /network/);
  assert.equal((await f.monitor.sync()).count, 1);
  await f.monitor.check();
  assert.equal(f.refreshes, 1);
});

test("un rafraîchissement explicite n’est pas absorbé par une lecture de cache simultanée", async () => {
  const f = monitorFixture();
  f.local.checkedAt = f.clock;
  const cached = f.monitor.check();
  const forced = f.monitor.check({ force: true });
  await Promise.all([cached, forced]);
  assert.equal(f.refreshes, 1);
});
