import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createUpdateChecker,
  compareVersions,
  versionParts,
  validateRelease,
  readReleaseResponse,
  UPDATE_INTERVAL,
  UPDATE_TIMEOUT,
  MAX_UPDATE_BYTES,
} from "../extension/updates.js";
import { CONFIG } from "../extension/config.js";

function fixture(options = {}) {
  const local = {},
    requests = [],
    manifest = { version: "2.4.0", ...options.manifest };
  const f = {
    local,
    requests,
    clock: 1_000_000,
    selfCalls: 0,
    response: () =>
      new Response(JSON.stringify({ schemaVersion: 1, version: "2.4.1" })),
  };
  f.api = {
    runtime: {
      id: "test-extension",
      getManifest: () => structuredClone(manifest),
      getURL: (path) =>
        (options.scheme || "chrome-extension://") + "test-extension/" + path,
    },
    management: {
      getSelf: async () => {
        f.selfCalls++;
        return {
          installType: options.installType || "development",
          id: "test-extension",
          irrelevantPrivateField: "discarded",
        };
      },
    },
    storage: {
      local: {
        get: async (keys) =>
          Object.fromEntries(
            (Array.isArray(keys) ? keys : [keys]).map((key) => [
              key,
              structuredClone(local[key]),
            ]),
          ),
        set: async (data) => Object.assign(local, structuredClone(data)),
      },
    },
  };
  f.fetcher = async (url, settings) => {
    requests.push({ url, settings });
    return f.response(url, settings);
  };
  f.checker = createUpdateChecker(f.api, CONFIG, f.fetcher, () => f.clock);
  return f;
}

test("les versions sont comparées numériquement avec trois ou quatre composants", () => {
  assert.equal(compareVersions("2.10.0", "2.9.99"), 1);
  assert.equal(compareVersions("2.4.0", "2.4.0.0"), 0);
  assert.equal(compareVersions("2.4.0.1", "2.4.0"), 1);
  assert.equal(compareVersions("3.0.0", "2.65535.65535.65535"), 1);
  assert.equal(compareVersions("0.0.0", "0.0.1"), -1);
  assert.deepEqual(versionParts("65535.0.65535"), [65535, 0, 65535, 0]);
  for (const value of [
    null,
    2.4,
    "2.4",
    "2.4.0.0.1",
    "65536.0.0",
    "2.04.0",
    "2.-1.0",
    "2.4.0-beta",
    "v2.4.0",
    "2.4.0\n",
    "2.4.1/<script>",
    "javascript:alert(1)",
  ])
    assert.throws(() => versionParts(value));
});

test("les métadonnées ne conservent que le schéma et une version valide", () => {
  const value = JSON.parse(
    '{"schemaVersion":1,"version":"2.4.1","url":"javascript:alert(1)","downloads":{"chrome":"https://evil.example"},"__proto__":{"polluted":true}}',
  );
  assert.deepEqual(validateRelease(value), {
    schemaVersion: 1,
    version: "2.4.1",
  });
  assert.equal({}.polluted, undefined);
  for (const invalid of [
    null,
    [],
    { version: "2.4.1" },
    { schemaVersion: "1", version: "2.4.1" },
    { schemaVersion: 2, version: "2.4.1" },
    { schemaVersion: 1, version: "<img src=x onerror=alert(1)>" },
    Object.create({ schemaVersion: 1, version: "2.4.1" }),
  ])
    assert.throws(() => validateRelease(invalid));
  let getterCalled = false;
  assert.throws(() =>
    validateRelease({
      schemaVersion: 1,
      get version() {
        getterCalled = true;
        return "2.4.1";
      },
    }),
  );
  assert.equal(getterCalled, false);
});

test("la taille des métadonnées est bornée même sans Content-Length", async () => {
  await assert.rejects(
    readReleaseResponse(
      new Response("{}", {
        headers: { "content-length": String(MAX_UPDATE_BYTES + 1) },
      }),
    ),
    /volumineuses/,
  );
  const bytes = new TextEncoder().encode(
    JSON.stringify({
      schemaVersion: 1,
      version: "2.4.1",
      ignored: "é".repeat(MAX_UPDATE_BYTES / 2),
    }),
  );
  await assert.rejects(
    readReleaseResponse(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(bytes.slice(0, 100));
            controller.enqueue(bytes.slice(100));
            controller.close();
          },
        }),
      ),
    ),
    /volumineuses/,
  );
  await assert.rejects(
    readReleaseResponse(new Response("<html>Erreur</html>")),
  );
  await assert.rejects(
    readReleaseResponse(new Response("Erreur", { status: 503 })),
  );
});

test("une nouvelle version n’utilise jamais les liens fournis dans le JSON", async () => {
  const f = fixture();
  f.local.checkedAt = 17;
  f.local.job = { status: "running", index: 12 };
  f.response = () =>
    new Response(
      JSON.stringify({
        schemaVersion: 1,
        version: "2.4.1",
        releaseUrl: "https://evil.example/download",
        url: "javascript:alert(1)",
        downloads: { chrome: "https://evil.example/code.zip" },
        compatibility: { permissions: ["management"] },
      }),
    );
  const info = await f.checker.check();
  assert.equal(info.available, true);
  assert.equal(info.currentVersion, "2.4.0");
  assert.equal(info.latestVersion, "2.4.1");
  assert.equal(info.url, CONFIG.repoUrl + "/releases/tag/v2.4.1");
  assert.equal(info.channel, "manual");
  assert.equal(info.checking, false);
  assert.equal(info.error, null);
  assert.deepEqual(f.local.latestRelease, {
    schemaVersion: 1,
    version: "2.4.1",
  });
  assert.equal(f.local.updateCheckedAt, f.clock);
  assert.equal(f.local.checkedAt, 17);
  assert.deepEqual(f.local.job, { status: "running", index: 12 });
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].url, CONFIG.updatesUrl);
  assert.equal(f.requests[0].settings.redirect, "error");
  assert.equal(f.requests[0].settings.credentials, "omit");
  assert.equal(f.requests[0].settings.cache, "no-store");
  assert.ok(f.requests[0].settings.signal instanceof AbortSignal);
  assert.equal(f.requests[0].settings.signal.aborted, false);
  assert.ok(UPDATE_TIMEOUT <= 5000);
});

test("une version égale ou plus ancienne ne produit pas de notification", async () => {
  for (const version of ["2.4.0", "2.4.0.0", "2.3.65535"]) {
    const f = fixture();
    f.response = () =>
      new Response(JSON.stringify({ schemaVersion: 1, version }));
    const info = await f.checker.check();
    assert.equal(info.available, false);
    assert.equal(info.url, null);
  }
});

test("les vérifications automatiques sont espacées de six heures mais le clic peut forcer", async () => {
  const f = fixture();
  await f.checker.check();
  f.clock++;
  await f.checker.check();
  assert.equal(f.requests.length, 1);
  await f.checker.check({ force: true });
  assert.equal(f.requests.length, 2);
  f.clock += UPDATE_INTERVAL - 1;
  await f.checker.check();
  assert.equal(f.requests.length, 2);
  f.clock++;
  await f.checker.check();
  assert.equal(f.requests.length, 3);
});

test("un échec réseau conserve la dernière version sûre et ne relance pas en boucle", async () => {
  const f = fixture();
  await f.checker.check();
  f.clock += UPDATE_INTERVAL;
  f.response = () => {
    throw Error("Cookie=information-qui-ne-doit-pas-sortir");
  };
  const info = await f.checker.check();
  assert.equal(info.available, true);
  assert.equal(info.latestVersion, "2.4.1");
  assert.match(info.error, /Impossible de vérifier/);
  assert.doesNotMatch(info.error, /Cookie/);
  assert.equal(info.checking, false);
  assert.equal(info.checkedAt, f.clock);
  await f.checker.check();
  assert.equal(f.requests.length, 2);
});

test("les informations locales anciennes ou malformées ne réintroduisent pas de lien arbitraire", async () => {
  const f = fixture();
  f.local.latestRelease = {
    schemaVersion: 1,
    version: "2.4.2",
    url: "javascript:alert(1)",
    compatibility: "discarded",
  };
  f.local.updateCheckedAt = f.clock + 1000;
  f.local.updateError = "texte arbitraire";
  let info = await f.checker.state();
  assert.equal(info.url, CONFIG.repoUrl + "/releases/tag/v2.4.2");
  assert.equal(info.checkedAt, null);
  assert.equal(info.error, null);
  assert.equal(info.compatibility, undefined);
  f.local.latestRelease.version = "2.4.2?url=https://evil.example";
  info = await f.checker.state();
  assert.equal(info.available, false);
  assert.equal(info.latestVersion, null);
  assert.equal(info.url, null);
  f.response = () => new Response('{"schemaVersion":1,"version":"<script>"}');
  info = await f.checker.check();
  assert.equal(info.available, false);
  assert.equal(f.local.latestRelease, null);
  assert.match(info.error, /Impossible de vérifier/);
});

test("les appels simultanés partagent une seule requête sans bloquer la lecture de l’état", async () => {
  const f = fixture();
  let release, started;
  const waiting = new Promise((resolve) => (release = resolve));
  const entered = new Promise((resolve) => (started = resolve));
  f.response = () => {
    started();
    return waiting;
  };
  const first = f.checker.check();
  const second = f.checker.check();
  assert.equal(first, second);
  await entered;
  assert.equal((await f.checker.state()).checking, true);
  release(new Response('{"schemaVersion":1,"version":"2.4.1"}'));
  const info = await first;
  assert.equal(info.checking, false);
  assert.equal(info.available, true);
  assert.equal(f.requests.length, 1);
});

test("la vérification manuelle attend une lecture de cache en cours puis contacte la source", async () => {
  const f = fixture();
  f.local.updateCheckedAt = f.clock;
  const cached = f.checker.check();
  const forced = f.checker.check({ force: true });
  await Promise.all([cached, forced]);
  assert.equal(f.requests.length, 1);
  assert.equal((await f.checker.state()).latestVersion, "2.4.1");
});

test("seule la propre installation est inspectée et le canal reste prudent", async () => {
  const cases = [
    [{ installType: "development" }, "manual"],
    [{ installType: "normal" }, "unknown"],
    [
      {
        installType: "normal",
        manifest: {
          update_url: "https://clients2.google.com/service/update2/crx",
        },
      },
      "native",
    ],
    [
      {
        installType: "normal",
        manifest: {
          update_url: "https://edge.microsoft.com/extensionwebstorebase/v1/crx",
        },
      },
      "native",
    ],
    [{ installType: "normal", scheme: "moz-extension://" }, "native"],
    [{ installType: "sideload" }, "unknown"],
    [{ installType: "admin" }, "unknown"],
    [{ installType: "other" }, "unknown"],
    [{ installType: "new-unsupported-type" }, "unknown"],
  ];
  for (const [options, channel] of cases) {
    const f = fixture(options);
    const info = await f.checker.state();
    assert.equal(info.channel, channel);
    await f.checker.state();
    assert.equal(f.selfCalls, 1);
    assert.equal(info.irrelevantPrivateField, undefined);
    assert.equal(f.requests.length, 0);
  }
  const absent = fixture();
  delete absent.api.management;
  assert.equal((await absent.checker.state()).installType, "unknown");
  const refused = fixture();
  refused.api.management.getSelf = async () => {
    throw Error("API indisponible");
  };
  assert.equal((await refused.checker.state()).installType, "unknown");
});

test("la source des métadonnées est fixée au dépôt canonique", () => {
  const f = fixture();
  for (const config of [
    { ...CONFIG, updatesUrl: "https://evil.example/latest.json" },
    { ...CONFIG, updatesUrl: CONFIG.updatesUrl + "?redirect=evil" },
    { ...CONFIG, repoUrl: "https://github.com.evil.example/owner/repo" },
    { ...CONFIG, repoUrl: CONFIG.repoUrl + "/../other" },
    { ...CONFIG, repoUrl: "javascript:alert(1)" },
  ])
    assert.throws(() => createUpdateChecker(f.api, config, f.fetcher));
});

test("le fond expose updateInfo au popup et refuse checkUpdate aux scripts de X", async () => {
  const f = fixture();
  const listeners = {};
  f.local.checkedAt = 19;
  f.local.filterSchema = 3;
  f.local.list = { schemaVersion: 1, version: "TEST", accounts: [] };
  f.local.listAttemptedAt = Date.now();
  const event = (name) => ({
    addListener(listener) {
      listeners[name] = listener;
    },
  });
  Object.assign(f.api.runtime, {
    onMessage: event("message"),
    onStartup: event("startup"),
    onInstalled: event("installed"),
  });
  f.api.alarms = {
    onAlarm: event("alarm"),
    clear: async () => true,
    create: async () => {},
  };
  f.api.tabs = { query: async () => [], sendMessage: async () => {} };
  f.api.action = {
    setBadgeText: async () => {},
    setBadgeBackgroundColor: async () => {},
    setTitle: async () => {},
  };
  const previousChrome = globalThis.chrome,
    previousBrowser = globalThis.browser,
    previousFetch = globalThis.fetch;
  try {
    globalThis.chrome = f.api;
    delete globalThis.browser;
    globalThis.fetch = f.fetcher;
    await import("../extension/background.js?updates-test");
    const popup = {
      id: f.api.runtime.id,
      url: f.api.runtime.getURL("popup.html"),
    };
    const request = (message, sender) =>
      new Promise((resolve) => {
        if (listeners.message(message, sender, resolve) !== true)
          resolve(undefined);
      });
    let response = await request({ type: "state" }, popup);
    assert.equal(response.ok, true);
    assert.equal(response.data.checkedAt, 19);
    assert.equal(response.data.updateInfo.currentVersion, "2.4.0");
    response = await request({ type: "checkUpdate" }, popup);
    assert.equal(response.ok, true);
    assert.equal(response.data.latestVersion, "2.4.1");
    assert.equal(response.data.url, CONFIG.repoUrl + "/releases/tag/v2.4.1");
    const requests = f.requests.length;
    const content = {
      id: f.api.runtime.id,
      url: "https://x.com/home",
      tab: { id: 7 },
      frameId: 0,
    };
    assert.equal(await request({ type: "checkUpdate" }, content), undefined);
    assert.equal(await request({ type: "state" }, content), undefined);
    assert.equal(f.requests.length, requests);
    assert.ok(
      f.requests.every((request) =>
        [CONFIG.updatesUrl, CONFIG.listUrl].includes(request.url),
      ),
    );
    assert.equal(typeof listeners.alarm, "function");
    assert.equal(typeof listeners.startup, "function");
  } finally {
    globalThis.chrome = previousChrome;
    globalThis.browser = previousBrowser;
    globalThis.fetch = previousFetch;
  }
});
