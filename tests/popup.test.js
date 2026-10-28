import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const repoUrl = "https://github.com/LaRosette/Blokedex-Trem";
const currentVersion = "3.0.0";
const source = (
  await readFile(new URL("../extension/popup.js", import.meta.url), "utf8")
).replace(/^import \{ CONFIG \} from "\.\/config\.js";\r?\n/, "");

function deferred() {
  let resolve;
  const promise = new Promise((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function snapshot(overrides = {}) {
  return {
    enabled: false,
    revision: 0,
    list: {
      schemaVersion: 1,
      version: "initial",
      accounts: [{ id: "11", username: "Compte_A" }],
    },
    checkedAt: 0,
    issue: "",
    addedCount: 0,
    stats: null,
    needsReload: false,
    updateInfo: { currentVersion, available: false },
    ...overrides,
  };
}
function element() {
  return {
    value: "",
    textContent: "",
    hidden: false,
    disabled: false,
    attributes: new Map(),
    children: [],
    setAttribute(name, value) {
      this.attributes.set(name, value);
    },
    removeAttribute(name) {
      this.attributes.delete(name);
      if (name === "href") delete this.href;
    },
    replaceChildren(...children) {
      this.children = children;
    },
    append(...children) {
      this.children.push(...children);
    },
    addEventListener() {},
  };
}
async function popup(initial = snapshot()) {
  const f = { elements: new Map(), respond: async () => initial };
  const document = {
    body: { dataset: {} },
    hidden: false,
    getElementById(id) {
      if (!f.elements.has(id)) f.elements.set(id, element());
      return f.elements.get(id);
    },
    createElement: element,
  };
  const api = {
    runtime: {
      getManifest: () => ({ version: currentVersion }),
      sendMessage: async (message) => ({
        ok: true,
        data: await f.respond(message),
      }),
    },
    storage: { onChanged: { addListener() {} } },
  };
  const context = vm.createContext({
    CONFIG: { repoUrl },
    document,
    chrome: api,
    URL,
    Intl,
    Date,
    setInterval: () => 1,
    clearInterval() {},
    addEventListener() {},
    requestAnimationFrame() {},
  });
  await vm.runInContext(
    "(async () => {" +
      source +
      "\nglobalThis.qa = { readState, act, state: () => state }; })()",
    context,
  );
  f.ui = context.qa;
  f.get = (id) => f.elements.get(id);
  return f;
}

test("une ancienne réponse périodique ne réaffiche pas Activer après l'activation", async () => {
  const f = await popup();
  const oldReply = deferred(),
    requested = deferred();
  const active = snapshot({
    enabled: true,
    revision: 1,
    stats: { hidden: 7, active: true },
  });
  f.respond = async (message) => {
    if (message.type === "state") {
      requested.resolve();
      return oldReply.promise;
    }
    assert.equal(message.type, "setEnabled");
    assert.equal(message.enabled, true);
    return active;
  };
  const poll = f.ui.readState();
  await requested.promise;
  await f.ui.act("setEnabled", { enabled: true });
  assert.equal(f.get("toggle").textContent, "Mettre en pause");
  assert.equal(f.get("hiddenCount").textContent, "7");
  oldReply.resolve(snapshot({ stats: { hidden: 0, active: false } }));
  await poll;
  assert.equal(f.ui.state().revision, 1);
  assert.equal(f.ui.state().enabled, true);
  assert.equal(f.get("toggle").textContent, "Mettre en pause");
  assert.equal(f.get("toggle").attributes.get("aria-pressed"), "true");
  assert.equal(f.get("hiddenCount").textContent, "7");
});

test("une action terminée tard ne remplace pas une liste et des statistiques plus récentes", async () => {
  const f = await popup();
  const oldAction = deferred(),
    requested = deferred();
  const latest = snapshot({
    enabled: true,
    revision: 2,
    list: {
      schemaVersion: 1,
      version: "nouvelle",
      accounts: [
        { id: "11", username: "Compte_A" },
        { id: "12", username: "Compte_B" },
        { id: "13", username: "Compte_C" },
      ],
    },
    stats: { hidden: 9, active: true },
  });
  f.respond = async (message) => {
    if (message.type === "refresh") {
      requested.resolve();
      return oldAction.promise;
    }
    assert.equal(message.type, "state");
    return latest;
  };
  const refresh = f.ui.act("refresh");
  await requested.promise;
  await f.ui.readState();
  assert.equal(f.get("listInfo").textContent, "Voir la liste (3)");
  oldAction.resolve(
    snapshot({ revision: 1, stats: { hidden: 1, active: false } }),
  );
  await refresh;
  assert.equal(f.ui.state().revision, 2);
  assert.equal(f.ui.state().list.version, "nouvelle");
  assert.equal(f.get("listInfo").textContent, "Voir la liste (3)");
  assert.equal(f.get("accounts").children.length, 3);
  assert.equal(f.get("hiddenCount").textContent, "9");
  assert.equal(f.get("toggle").textContent, "Mettre en pause");
  assert.equal(f.get("toggle").disabled, false);
});

test("à révision identique, les statistiques de la page peuvent continuer de changer", async () => {
  const f = await popup(
    snapshot({
      enabled: true,
      revision: 4,
      stats: { hidden: 2, active: true },
    }),
  );
  f.respond = async () =>
    snapshot({
      enabled: true,
      revision: 4,
      stats: { hidden: 6, active: true },
    });
  await f.ui.readState();
  assert.equal(f.ui.state().revision, 4);
  assert.equal(f.get("hiddenCount").textContent, "6");
  assert.equal(f.get("toggle").textContent, "Mettre en pause");
});

test("les nouveaux états gardent le contrôle du lien de version sur le dépôt officiel", async () => {
  const info = { available: true, latestVersion: "3.0.1", channel: "manual" };
  const f = await popup(
    snapshot({ updateInfo: { ...info, url: "https://evil.example/version" } }),
  );
  assert.equal(f.get("updateNotice").hidden, true);
  assert.equal(f.get("updateLink").href, undefined);
  f.respond = async () =>
    snapshot({
      updateInfo: { ...info, url: repoUrl + "/releases/tag/v3.0.1" },
    });
  await f.ui.readState();
  assert.equal(f.get("updateNotice").hidden, false);
  assert.equal(f.get("updateLink").href, repoUrl + "/releases/tag/v3.0.1");
  assert.match(f.get("updateHint").textContent, /Installation manuelle/);
});
