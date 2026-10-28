import { chromium, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  filterAccounts,
  filterPage,
  tweet,
} from "../tests/fixtures/filter-site.mjs";
const root = new URL("../", import.meta.url);
const scratch = new URL(
  `../../../work/filter-browser-${Date.now()}/`,
  import.meta.url,
);
const fixture = new URL("extension/", scratch);
await mkdir(scratch, { recursive: true });
await cp(new URL("extension/", root), fixture, { recursive: true });
const manifest = JSON.parse(
  await readFile(new URL("manifest.json", fixture), "utf8"),
);
const catalog = {
  schemaVersion: 1,
  version: "DEMONSTRATION",
  accounts: filterAccounts,
};
await writeFile(new URL("catalog.json", fixture), JSON.stringify(catalog));
const original = await readFile(new URL("background.js", fixture), "utf8");
await writeFile(
  new URL("background.js", fixture),
  `
const nativeFetch=globalThis.fetch;
globalThis.fetch=async (input,options)=>{
 const url=String(input);
 if(url.endsWith('/liste/accounts.json')){
  const {qaList}=await chrome.storage.session.get('qaList');
  return new Response(JSON.stringify(qaList||${JSON.stringify(catalog)}));
 }
 if(url.endsWith('/updates/latest.json'))return new Response(JSON.stringify({schemaVersion:1,version:${JSON.stringify(manifest.version)}}));
 return nativeFetch(input,options);
};
const qaNativeCreate=chrome.tabs.create.bind(chrome.tabs);
chrome.tabs.create=async options=>{
 const {qaCreates=0}=await chrome.storage.session.get('qaCreates');
 await chrome.storage.session.set({qaCreates:qaCreates+1});
 return qaNativeCreate(options);
};
const qaNativeSend=chrome.tabs.sendMessage.bind(chrome.tabs);
chrome.tabs.sendMessage=async(id,message,...rest)=>{
 const {qaMessages=[]}=await chrome.storage.session.get('qaMessages');
 await chrome.storage.session.set({qaMessages:[...qaMessages,message.type]});
 return qaNativeSend(id,message,...rest);
};
chrome.storage.local.set({job:{id:'old-job',tabId:999999,attempt:1},processedHistory:[{username:'AncienCompte',ids:['11']}],lastConfirmedAccount:{username:'AncienCompte'}});
${original}`,
);
const context = await chromium.launchPersistentContext(
  fileURLToPath(new URL("profile/", scratch)),
  {
    channel: process.env.TEST_BROWSER_CHANNEL || "chromium",
    headless: true,
    ignoreDefaultArgs: ["--disable-extensions"],
    viewport: { width: 950, height: 750 },
    args: [
      `--disable-extensions-except=${fileURLToPath(fixture)}`,
      `--load-extension=${fileURLToPath(fixture)}`,
    ],
  },
);
const checks = [],
  errors = [],
  unexpected = [];
let siteRequests = 0;
context.on("page", (page) =>
  page.on("pageerror", (error) => errors.push(error.message)),
);
await context.route("https://x.com/**", (route) => {
  siteRequests++;
  if (
    route.request().method() !== "GET" ||
    !["/home", "/favicon.ico"].includes(new URL(route.request().url()).pathname)
  )
    unexpected.push(route.request().url());
  return route.fulfill({
    contentType: "text/html; charset=utf-8",
    body: filterPage(),
  });
});
try {
  const worker =
    context.serviceWorkers()[0] ||
    (await context.waitForEvent("serviceworker"));
  const id = new URL(worker.url()).host;
  const site = await context.newPage();
  await site.goto("https://x.com/home");
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${id}/popup.html`);
  await expect(popup.locator("#toggle")).toBeEnabled();
  await expect(popup.locator("#listInfo")).toContainText("2");
  await expect(site.locator("#target")).toBeVisible();
  checks.push(
    "première installation désactivée et catalogue public disponible",
  );
  const migrated = await worker.evaluate(() =>
    chrome.storage.local.get([
      "job",
      "processedHistory",
      "lastConfirmedAccount",
      "filterSchema",
    ]),
  );
  assert.equal(migrated.job, undefined);
  assert.equal(migrated.processedHistory, undefined);
  assert.equal(migrated.lastConfirmedAccount, undefined);
  assert.equal(migrated.filterSchema, 3);
  assert.equal(
    (await worker.evaluate(() => chrome.alarms.getAll())).some(
      (a) => a.name === "block-next",
    ),
    false,
  );
  checks.push(
    "migration : ancien traitement annulé, anciennes données et alarme supprimées",
  );
  const start = Date.now();
  await popup.locator("#toggle").click();
  for (const key of ["target", "quote", "repost"])
    await expect(site.locator("#" + key)).toBeHidden();
  const activationMs = Date.now() - start;
  for (const key of [
    "safe",
    "mention",
    "prefix",
    "ambiguous",
    "foreign",
    "reply",
  ])
    await expect(site.locator("#" + key)).toBeVisible();
  checks.push(
    "auteur exact, republication et citation native masqués",
    "mentions, réponses, préfixes et identités ambiguës conservés",
  );
  await expect(site.locator("#cell-target")).toBeHidden();
  checks.push("cellules vides repliées sans supprimer de nœud React");
  await site.bringToFront();
  await expect(popup.locator("#hiddenCount")).toHaveText("3");
  checks.push("compteur de publications actuellement masquées sur la page");
  await site.evaluate(() => {
    const header = document.querySelector('#target [data-testid="User-Name"]');
    for (const link of header.querySelectorAll("a"))
      link.setAttribute(
        "href",
        link.getAttribute("href").replace("CompteTest_A", "AuteurVisible"),
      );
  });
  await expect(site.locator("#target")).toBeVisible();
  checks.push(
    "recyclage d’un article par X : l’auteur suivant redevient visible",
  );
  const dynamic = tweet("dynamic", "cOmPtEtEsT_a");
  await site.evaluate(
    (html) =>
      document.getElementById("timeline").insertAdjacentHTML("beforeend", html),
    dynamic,
  );
  await expect(site.locator("#dynamic")).toBeHidden();
  checks.push("défilement dynamique et pseudo insensible à la casse");
  const mediaInitiallyPlaying = await site.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 32; canvas.height = 32;
    canvas.getContext("2d").fillRect(0, 0, 32, 32);
    const video = document.createElement("video");
    video.id = "hidden-video";
    video.muted = true;
    video.srcObject = canvas.captureStream(5);
    document.querySelector("#safe").append(video);
    await video.play();
    return !video.paused;
  });
  assert.equal(mediaInitiallyPlaying, true);
  await site.evaluate(() => document.querySelector("#dynamic").append(document.getElementById("hidden-video")));
  await expect.poll(() => site.locator("#hidden-video").evaluate(video => video.paused)).toBe(true);
  await site.locator("#hidden-video").evaluate(video => video.srcObject.getTracks().forEach(track => track.stop()));
  checks.push(
    "lecture d’un média masqué mise en pause sans lancer d’autre lecture",
  );
  const beforeClick = await site.evaluate(
    (html) => {
      document.getElementById("timeline").insertAdjacentHTML("beforeend", html);
      document.querySelector("#race button").click();
      return document.body.dataset.likes;
    },
    tweet("race", "CompteTest_A"),
  );
  assert.equal(beforeClick, "0");
  await expect(site.locator("#race")).toBeHidden();
  checks.push(
    "clic capturé avant le passage de l’observateur : aucune interaction simulée",
  );
  await popup.locator("#toggle").click();
  for (const key of ["quote", "repost", "dynamic", "race"])
    await expect(site.locator("#" + key)).toBeVisible();
  await expect(site.locator("[data-blokedex-hidden]")).toHaveCount(0);
  checks.push("mise en pause : restauration immédiate du contenu original");
  await popup.locator("#toggle").click();
  await site.reload();
  await expect(site.locator("#target")).toBeHidden();
  checks.push("activation conservée après le rechargement de la page");
  await popup.locator("details").evaluate((e) => {
    e.open = true;
  });
  await popup.locator("#search").fill("@CompteTest_A");
  await expect(popup.locator("#accounts li:visible")).toHaveCount(1);
  await popup.locator("#search").fill("");
  checks.push("liste consultable et recherche locale sans requête X");
  await worker.evaluate(
    (data) => chrome.storage.session.set({ qaList: data }),
    {
      schemaVersion: 1,
      version: "AJOUT",
      accounts: [...filterAccounts, { id: "14", username: "AuteurVisible" }],
    },
  );
  await popup.locator("#refreshListe").click();
  await expect(site.locator("#safe")).toBeHidden();
  checks.push("ajout à la liste appliqué dans les onglets déjà ouverts");
  await worker.evaluate(() =>
    chrome.storage.session.set({
      qaList: {
        schemaVersion: 1,
        version: "INVALIDE",
        accounts: [{ id: "bad", username: "<script>" }],
      },
    }),
  );
  await popup.locator("#refreshListe").click();
  await expect(site.locator("#safe")).toBeHidden();
  await expect
    .poll(() =>
      worker.evaluate(
        async () => (await chrome.storage.local.get("filterIssue")).filterIssue,
      ),
    )
    .toContain("indisponible");
  checks.push(
    "liste distante invalide refusée ; dernier filtre valide conservé",
  );
  await worker.evaluate(
    (data) => chrome.storage.session.set({ qaList: data }),
    catalog,
  );
  await popup.locator("#refreshListe").click();
  await expect(site.locator("#safe")).toBeVisible();
  checks.push("retrait de liste : publications rendues à nouveau visibles");
  const performanceStart = Date.now();
  const batch = Array.from({ length: 1000 }, (_, i) =>
    tweet("batch" + i, i % 2 ? "AuteurVisible" : "CompteTest_A"),
  ).join("");
  await site.evaluate(
    (html) =>
      document.getElementById("timeline").insertAdjacentHTML("beforeend", html),
    batch,
  );
  await expect(
    site.locator('article[id^="batch"][data-blokedex-hidden="true"]'),
  ).toHaveCount(500);
  const batchMs = Date.now() - performanceStart;
  await site.evaluate(() =>
    document
      .querySelectorAll('article[id^="batch"]')
      .forEach((a) => a.closest('[data-testid="cellInnerDiv"]').remove()),
  );
  await site.bringToFront();
  await expect(popup.locator("#hiddenCount")).toHaveText("3");
  checks.push(
    "lot de 1 000 articles et nettoyage des nœuds retirés sans historique croissant",
  );
  const operations = await worker.evaluate(() =>
    chrome.storage.session.get(["qaCreates", "qaMessages"]),
  );
  assert.equal(operations.qaCreates || 0, 0);
  assert.ok(
    operations.qaMessages.every((type) =>
      ["abort", "applyFilter", "filterStats"].includes(type),
    ),
  );
  assert.deepEqual(unexpected, []);
  assert.deepEqual(errors, []);
  checks.push(
    "aucun onglet créé par l’extension, aucune navigation de profil, aucun appel d’écriture X",
  );
  await popup.setViewportSize({ width: 360, height: 650 });
  await popup.locator("details").evaluate((e) => {
    e.open = false;
  });
  const box = await popup.evaluate(() => ({
    width: document.documentElement.scrollWidth,
    body: document.body.clientWidth,
  }));
  assert.ok(box.width <= box.body);
  await popup.screenshot({
    path: fileURLToPath(
      new URL("../../../outputs/apercu-filtre-3.0.0.png", import.meta.url),
    ),
  });
  await site.screenshot({
    path: fileURLToPath(
      new URL("../../../outputs/fil-demonstration-filtre.png", import.meta.url),
    ),
  });
  await mkdir(new URL("verification/", root), { recursive: true });
  const report = {
    browser: context.browser()?.version(),
    version: manifest.version,
    checks,
    activationMs,
    batch1000Ms: batchMs,
    siteRequests,
    result: "success",
    network: "Publications fictives, aucun compte X réel modifié",
  };
  await writeFile(
    new URL("verification/chromium.json", root),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  for (const page of context.pages())
    console.error(
      "Page de test",
      page.url(),
      (await page.locator("body").innerText()).slice(0, 1400),
    );
  const worker = context.serviceWorkers()[0];
  if (worker)
    console.error(
      "État de test",
      await worker.evaluate(() => chrome.storage.local.get(null)),
    );
  console.error("Erreurs de page", errors);
  throw error;
} finally {
  await context.close();
}
