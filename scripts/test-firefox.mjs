import { Builder } from "selenium-webdriver";
import firefox from "selenium-webdriver/firefox.js";
import { createServer } from "node:http";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { manifestFor } from "./manifests.mjs";
import { packageDirectory } from "./package.mjs";
import {
  filterAccounts,
  filterPage,
  tweet,
} from "../tests/fixtures/filter-site.mjs";
import { sitePage as blockPage } from "../tests/fixtures/block-site.mjs";
import { CONFIG } from "../extension/config.js";

const root = new URL("../", import.meta.url);
const sourceManifest = JSON.parse(
  await readFile(new URL("extension/manifest.json", root), "utf8"),
);
const scratch = new URL(
  `../../../work/firefox-filter-${Date.now()}/`,
  import.meta.url,
);
const fixture = new URL("extension/", scratch);
await mkdir(scratch, { recursive: true });
await cp(new URL("extension/", root), fixture, { recursive: true });
let documents = 0,
  blockingFixture = false,
  blockingOwner = "CompteDeTest";
const confirmedBlocks = [];
const requests = [];
const commandQueue = [],
  commandResults = new Map();
let nextCommand, ready;
const panelReady = new Promise((resolve) => {
  ready = resolve;
});
const server = createServer(async (request, response) => {
  requests.push({ method: request.method, url: request.url });
  const pathname = new URL(request.url, "http://127.0.0.1").pathname;
  response.setHeader("Access-Control-Allow-Origin", "*");
  if (pathname === "/next") {
    response.setHeader("Content-Type", "application/json");
    if (commandQueue.length) response.end(JSON.stringify(commandQueue.shift()));
    else nextCommand = response;
  } else if (pathname === "/ready") {
    ready();
    response.end("ok");
  } else if (pathname === "/result") {
    let body = "";
    for await (const chunk of request) body += chunk;
    const result = JSON.parse(body);
    commandResults.get(result.id)?.(result);
    commandResults.delete(result.id);
    response.end("ok");
  } else if (blockingFixture && pathname === "/__test__/blocked") {
    const params = new URL(request.url, "http://127.0.0.1").searchParams;
    confirmedBlocks.push({
      owner: params.get("owner"),
      username: params.get("username"),
    });
    response.end("ok");
  } else if (blockingFixture && pathname.startsWith("/profile_images/")) {
    response.setHeader("Content-Type", "image/png");
    response.end(await readFile(new URL("extension/icons/icon16.png", root)));
  } else if (
    blockingFixture &&
    ["/home", "/CompteTest_A", "/CompteTest_B"].includes(pathname)
  ) {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(
      blockPage("https://x.com" + pathname, blockingOwner, {
        avatarOrigin: origin,
      }),
    );
  } else if (pathname === "/home") {
    documents++;
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(filterPage());
  } else {
    response.statusCode = 404;
    response.end("Ressource de test inconnue");
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const manifest = manifestFor(sourceManifest, "firefox");
manifest.host_permissions = ["http://127.0.0.1/*"];
manifest.content_scripts[0].matches = ["http://127.0.0.1/*"];
manifest.content_security_policy.extension_pages =
  manifest.content_security_policy.extension_pages.replace(
    /connect-src[^;]*/,
    `connect-src ${origin}`,
  );
await writeFile(new URL("manifest.json", fixture), JSON.stringify(manifest));

// Seule cette copie éphémère reconnaît l’origine HTTP de la fixture.
let store = await readFile(new URL("filter-state.js", fixture), "utf8");
const originalStore = store;
store = store.replace(
  /export function isXPage\(value\)\s*\{[\s\S]*?\n\}/,
  `export function isXPage(value) { try { const url = new URL(value); return url.origin === ${JSON.stringify(origin)} && !url.username && !url.password; } catch { return false; } }`,
);
store = store.replace(
  /\["https:\/\/x\.com\/\*",\s*"https:\/\/twitter\.com\/\*"\]/g,
  JSON.stringify(["http://127.0.0.1/*"]),
);
assert.notEqual(
  store,
  originalStore,
  "L’origine locale doit être adaptée dans la copie de test.",
);
assert.ok(
  store.includes(JSON.stringify("http://127.0.0.1/*")),
  "La diffusion du filtre doit atteindre la fixture locale.",
);
await writeFile(new URL("filter-state.js", fixture), store);
const content = await readFile(new URL("content.js", fixture), "utf8");
assert.ok(
  content.includes("location.origin"),
  "La copie de test doit adapter la base des liens de profil.",
);
await writeFile(
  new URL("content.js", fixture),
  content.replaceAll("location.origin", '"https://x.com"'),
);

await writeFile(
  new URL("profile-filter.js", fixture),
  (await readFile(new URL("profile-filter.js", fixture), "utf8")).replaceAll(
    "location.origin",
    '\"https://x.com\"',
  ),
);
// Only the throwaway copy maps X navigation to the isolated local fixture.
let runnerSource = await readFile(new URL("runner.js", fixture), "utf8");
runnerSource = runnerSource
  .replaceAll("https://x.com", origin)
  .replaceAll('hostname === "x.com"', 'hostname === "127.0.0.1"')
  .replaceAll('hostname !== "x.com"', 'hostname !== "127.0.0.1"')
  .replaceAll('protocol === "https:"', 'protocol === "http:"')
  .replaceAll('protocol !== "https:"', 'protocol !== "http:"');
await writeFile(new URL("runner.js", fixture), runnerSource);
let blockSource = await readFile(new URL("block-content.js", fixture), "utf8");
blockSource = blockSource.replace(
  'url.hostname !== "pbs.twimg.com"',
  'url.hostname !== "127.0.0.1"',
);
await writeFile(new URL("block-content.js", fixture), blockSource);
const nativeBackground = await readFile(
  new URL("background.js", fixture),
  "utf8",
);
await writeFile(
  new URL("background.js", fixture),
  `
const fixtureApi=globalThis.browser;
const fixtureFetch=globalThis.fetch.bind(globalThis);
globalThis.fetch=async(input,options)=>{
 const href=typeof input==='string'?input:input.url||String(input);
 if(href===${JSON.stringify(CONFIG.listUrl)})return new Response(JSON.stringify({schemaVersion:1,version:'FILTRE-FIREFOX',accounts:${JSON.stringify(filterAccounts)}}),{headers:{'Content-Type':'application/json'}});
 if(href===${JSON.stringify(CONFIG.updatesUrl)})return new Response(JSON.stringify({schemaVersion:1,version:${JSON.stringify(sourceManifest.version)}}),{headers:{'Content-Type':'application/json'}});
 if(href.startsWith(fixtureApi.runtime.getURL('')))return fixtureFetch(input,options);
 throw Error('Requête extérieure interdite pendant le test Firefox.');
};
${nativeBackground}
fixtureApi.tabs.create({url:fixtureApi.runtime.getURL('popup.html'),active:true});
`,
);
const popup = await readFile(new URL("popup.html", fixture), "utf8");
await writeFile(
  new URL("popup.html", fixture),
  popup.replace(
    "</body>",
    '<script type="module" src="firefox-test-driver.js"></script></body>',
  ),
);
await writeFile(
  new URL("firefox-test-driver.js", fixture),
  `
// Une page de test remplace le panneau natif, sans changer les API Firefox.
Object.defineProperty(document,'hidden',{get:()=>false});
let siteId;
const waitFor=async predicate=>{const deadline=Date.now()+7000;while(Date.now()<deadline){if(await predicate())return;await new Promise(resolve=>setTimeout(resolve,25));}throw Error('Délai dépassé dans le panneau Firefox de test.');};
const snapshot=()=>({pressed:document.getElementById('toggle').getAttribute('aria-pressed'),label:document.getElementById('toggle').textContent,hidden:document.getElementById('hiddenCount').textContent,statsVisible:!document.getElementById('pageStats').hidden,list:document.getElementById('listInfo').textContent,version:document.getElementById('currentVersion').textContent,links:[...document.querySelectorAll('#accounts a')].map(a=>a.textContent),noResults:!document.getElementById('noResults').hidden,updateVisible:!document.getElementById('updateNotice').hidden});
await fetch(${JSON.stringify(origin + "/ready")});
for(;;){
 const {id,payload}=await (await fetch(${JSON.stringify(origin + "/next")})).json();
 try{
  let data;
  if(payload.kind==='open'){const tab=await browser.tabs.create({url:${JSON.stringify(origin + "/home")},active:true});siteId=tab.id;data=tab.id;}
  else {
   if(siteId)await browser.tabs.update(siteId,{active:true});
   if(payload.kind==='runtime')data=await browser.runtime.sendMessage(payload.message);
   else if(payload.kind==='storage')data=await browser.storage.local.get(null);
   else if(payload.kind==='tabs')data=await browser.tabs.query({});
   else if(payload.kind==='ui'){
    await waitFor(()=>!document.getElementById('toggle').disabled);
    if(payload.toggle){const before=document.getElementById('toggle').getAttribute('aria-pressed');document.getElementById('toggle').click();await waitFor(()=>!document.getElementById('toggle').disabled&&document.getElementById('toggle').getAttribute('aria-pressed')!==before);}
    if(payload.search!==undefined){document.querySelector('details').open=true;document.getElementById('search').value=payload.search;document.getElementById('search').dispatchEvent(new Event('input'));}
    if(payload.hidden!==undefined)await waitFor(()=>!document.getElementById('pageStats').hidden&&document.getElementById('hiddenCount').textContent===String(payload.hidden));
    data=snapshot();
   }else throw Error('Commande de test inconnue.');
  }
  await fetch(${JSON.stringify(origin + "/result")},{method:'POST',body:JSON.stringify({id,ok:true,data})});
 }catch(error){await fetch(${JSON.stringify(origin + "/result")},{method:'POST',body:JSON.stringify({id,ok:false,error:error.message})});}
}
`,
);
const archive = new URL("filter-test.zip", scratch);
await writeFile(archive, await packageDirectory(fixture));
const options = new firefox.Options()
  .setBrowserVersion("stable")
  .addArguments("-headless");
if (process.env.FIREFOX_BINARY) options.setBinary(process.env.FIREFOX_BINARY);
let driver,
  siteHandle,
  sequence = 0;
const checks = [];
try {
  driver = await new Builder()
    .forBrowser("firefox")
    .setFirefoxOptions(options)
    .build();
  await driver.installWebExtension(fileURLToPath(archive), {
    permanent: false,
  });
  let readyTimeout;
  await Promise.race([
    panelReady,
    new Promise((_, reject) => {
      readyTimeout = setTimeout(
        () => reject(Error("Le panneau Firefox de test n’a pas répondu.")),
        10000,
      );
    }),
  ]).finally(() => clearTimeout(readyTimeout));
  const command = async (payload) => {
    const id = String(++sequence);
    let timeout;
    const result = await new Promise((resolve, reject) => {
      commandResults.set(id, resolve);
      timeout = setTimeout(() => {
        commandResults.delete(id);
        reject(Error("Une commande du panneau Firefox n’a pas répondu."));
      }, 10000);
      if (nextCommand) {
        nextCommand.end(JSON.stringify({ id, payload }));
        nextCommand = null;
      } else commandQueue.push({ id, payload });
    }).finally(() => clearTimeout(timeout));
    assert.equal(result.ok, true, result.error);
    return result.data;
  };
  const runtime = async (message) => {
    const reply = await command({ kind: "runtime", message });
    assert.equal(reply?.ok, true, reply?.error);
    return reply.data;
  };
  const currentState = () => runtime({ type: "state" });
  let state = await runtime({ type: "refresh" });
  assert.equal(state.enabled, false);
  assert.deepEqual(state.list.accounts, filterAccounts);
  assert.equal(state.addedCount, 0);
  checks.push(
    "paquet Firefox MV3 et API browser natives",
    "filtre désactivé par défaut et liste de démonstration chargée",
  );
  await command({ kind: "open" });
  await driver.wait(async () => {
    for (const handle of await driver.getAllWindowHandles()) {
      await driver.switchTo().window(handle);
      if ((await driver.getCurrentUrl()) === origin + "/home") {
        siteHandle = handle;
        return true;
      }
    }
    return false;
  }, 5000);
  await driver.wait(
    async () => {
      state = await currentState();
      return state.stats !== null;
    },
    10000,
    "Le script de filtrage Firefox n’a pas répondu.",
  );
  assert.deepEqual(state.stats, { hidden: 0, active: false });
  const visible = async (ids, expected) => {
    await driver.switchTo().window(siteHandle);
    await driver.wait(
      async () => {
        const result = await driver.executeScript(
          (values) =>
            values.map((id) => ({
              id,
              visible:
                !!document.getElementById(id)?.getClientRects().length &&
                getComputedStyle(document.getElementById(id)).visibility !==
                  "hidden",
            })),
          ids,
        );
        return result.every((row) => row.visible === expected);
      },
      7000,
      "Visibilité incorrecte pour " + ids.join(", "),
    );
  };
  const hiddenIds = ["target", "repost", "quote-card"];
  const visibleIds = [
    "quote",
    "safe",
    "mention",
    "prefix",
    "ambiguous",
    "foreign",
    "reply",
  ];
  await visible([...hiddenIds, ...visibleIds], true);
  const tabsBefore = (await command({ kind: "tabs" })).length;
  const firstToggleAt = Date.now();
  let ui = await command({ kind: "ui", toggle: true });
  assert.equal(ui.pressed, "true");
  assert.equal(ui.label, "Mettre en pause");
  await visible(hiddenIds, false);
  await visible(visibleIds, true);
  const filterDurationMs = Date.now() - firstToggleAt;
  state = await currentState();
  assert.deepEqual(state.stats, { hidden: 3, active: true });
  ui = await command({ kind: "ui", hidden: 3 });
  assert.equal(ui.statsVisible, true);
  assert.equal(ui.hidden, "3");
  assert.equal(ui.version, "v" + sourceManifest.version);
  checks.push(
    "activation depuis le popup sans navigation ni action X",
    "auteur ciblé, republication et citation native masqués",
    "mention, réponse, pseudo approchant, auteur ambigu et URL étrangère conservés",
    "compteur de publications de l’onglet courant dans le popup",
  );
  ui = await command({ kind: "ui", search: "@comptetest_a" });
  assert.deepEqual(ui.links, ["@CompteTest_A"]);
  ui = await command({ kind: "ui", search: "aucun_compte" });
  assert.equal(ui.noResults, true);
  assert.deepEqual(ui.links, []);
  await command({ kind: "ui", search: "" });
  checks.push("recherche insensible à la casse et état sans résultat");
  await driver.switchTo().window(siteHandle);
  await driver.executeScript(() => {
    for (const link of document.querySelectorAll(
      '#target [data-testid="User-Name"] a',
    )) {
      link.setAttribute(
        "href",
        link.querySelector("time")
          ? "/AuteurRecycle/status/123"
          : "/AuteurRecycle",
      );
      if (link.querySelector("span"))
        link.querySelector("span").textContent = "@AuteurRecycle";
    }
  });
  await visible(["target"], true);
  await driver.wait(
    async () => (await currentState()).stats?.hidden === 2,
    5000,
  );
  await driver.switchTo().window(siteHandle);
  await driver.executeScript(() => {
    for (const link of document.querySelectorAll(
      '#target [data-testid="User-Name"] a',
    )) {
      link.setAttribute(
        "href",
        link.querySelector("time")
          ? "/CompteTest_A/status/123"
          : "/CompteTest_A",
      );
      if (link.querySelector("span"))
        link.querySelector("span").textContent = "@CompteTest_A";
    }
  });
  await visible(["target"], false);
  checks.push(
    "cellule recyclée : liens et auteur modifiés réévalués sans faux positif",
  );
  await driver.switchTo().window(siteHandle);
  await driver.executeScript(
    (html) =>
      document.getElementById("timeline").insertAdjacentHTML("beforeend", html),
    tweet("dynamic", "CompteTest_A"),
  );
  await visible(["dynamic"], false);
  await driver.wait(
    async () => (await currentState()).stats?.hidden === 4,
    5000,
  );
  await driver.switchTo().window(siteHandle);
  await driver.executeScript(
    "document.getElementById('cell-dynamic').remove()",
  );
  await driver.wait(
    async () => (await currentState()).stats?.hidden === 3,
    5000,
  );
  checks.push(
    "publication ajoutée au DOM masquée automatiquement",
    "compteur actuel décrémenté lors du retrait d’une publication",
  );
  await driver.switchTo().window(siteHandle);
  await driver.navigate().refresh();
  await visible(hiddenIds, false);
  await visible(visibleIds, true);
  state = await currentState();
  assert.equal(state.enabled, true);
  assert.deepEqual(state.stats, { hidden: 3, active: true });
  checks.push("activation conservée après rechargement de la page");
  ui = await command({ kind: "ui", toggle: true });
  assert.equal(ui.pressed, "false");
  assert.equal(ui.label, "Activer le filtre");
  await visible([...hiddenIds, ...visibleIds], true);
  await driver.wait(
    async () => (await currentState()).stats?.hidden === 0,
    5000,
  );
  checks.push(
    "mise en pause : toutes les publications restaurées et compteur à zéro",
  );
  const stored = await command({ kind: "storage" });
  for (const key of [
    "job",
    "processedHistory",
    "lastConfirmedAccount",
    "listAlertSeen",
    "listAlertPending",
    "listAlertBaseline",
  ])
    assert.equal(
      Object.hasOwn(stored, key),
      false,
      key + " ne doit pas être conservé",
    );
  assert.equal(stored.filterEnabled, false);
  assert.equal((await command({ kind: "tabs" })).length, tabsBefore);
  assert.equal(
    documents,
    2,
    "Un chargement initial et un rechargement explicite uniquement",
  );
  await driver.switchTo().window(siteHandle);
  assert.equal(
    await driver.executeScript("return document.body.dataset.likes"),
    "0",
  );
  assert.ok(
    requests.every(
      (request) =>
        (request.method === "GET" &&
          ["/next", "/ready"].includes(
            new URL(request.url, origin).pathname,
          )) ||
        (request.method === "POST" &&
          new URL(request.url, origin).pathname === "/result") ||
        (request.method === "GET" &&
          ["/home", "/favicon.ico"].includes(
            new URL(request.url, origin).pathname,
          )),
    ),
    JSON.stringify(requests),
  );
  checks.push(
    "aucun historique de blocage ou identifiant du compte connecté stocké",
    "aucun onglet ou navigation supplémentaire pendant le filtrage",
    "aucun clic sur les contrôles de publication et aucun appel d’action réseau",
  );
  blockingFixture = true;
  await runtime({ type: "start" });
  await driver.wait(
    async () => (await currentState()).job?.status === "done",
    15000,
  );
  let blockState = (await currentState()).job;
  assert.equal(blockState.owner, "CompteDeTest");
  assert.equal(blockState.created, 1);
  assert.equal(blockState.already, 1);
  assert.deepEqual(confirmedBlocks, [
    { owner: "CompteDeTest", username: "CompteTest_A" },
  ]);
  blockingOwner = "AutreCompte";
  await runtime({ type: "start" });
  await driver.wait(
    async () => (await currentState()).job?.status === "done",
    15000,
  );
  blockState = (await currentState()).job;
  assert.equal(blockState.owner, "AutreCompte");
  assert.equal(blockState.created, 1);
  assert.equal(blockState.cached, 0);
  assert.deepEqual(confirmedBlocks.at(-1), {
    owner: "AutreCompte",
    username: "CompteTest_A",
  });
  await runtime({ type: "forgetBlockHistory" });
  assert.equal((await currentState()).job, null);
  checks.push(
    "blocage Firefox natif : un compte bloqué et un compte déjà bloqué distingués",
    "deux utilisateurs Firefox : autorisations de session et historiques séparés",
    "effacement volontaire de l’historique local de blocage",
  );
  const report = {
    date: new Date().toISOString(),
    browser: "Firefox",
    version: (await driver.getCapabilities()).get("browserVersion"),
    extensionVersion: sourceManifest.version,
    network: "Origine HTTP locale et profils fictifs ; aucun accès X réel",
    filterDurationMs,
    checks,
    result: `${checks.length} contrôles réussis`,
  };
  await mkdir(new URL("verification/", root), { recursive: true });
  await writeFile(
    new URL("verification/firefox.json", root),
    JSON.stringify(report, null, 2),
  );
  console.log(
    `${checks.length} contrôles Firefox réussis (${report.version}).`,
  );
} catch (error) {
  if (driver)
    for (const handle of await driver.getAllWindowHandles().catch(() => [])) {
      await driver
        .switchTo()
        .window(handle)
        .catch(() => {});
      console.error(
        "Page de test :",
        await driver.getCurrentUrl().catch(() => ""),
        (
          await driver
            .executeScript("return document.body.innerText")
            .catch(() => "")
        ).slice(0, 1600),
      );
    }
  throw error;
} finally {
  await driver?.quit();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
