import {
  accounts,
  addedAccount,
  sitePage,
  releaseFixturesFor,
} from "../tests/fixtures/block-site.mjs";
import { chromium, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { cp, mkdir, writeFile, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const root = new URL("../", import.meta.url),
  scratch = new URL(
    `../../../work/browser-test-${Date.now()}/`,
    import.meta.url,
  );
const fixture = new URL("extension/", scratch),
  profile = new URL("profile/", scratch);
const currentVersion = JSON.parse(
  await readFile(new URL("extension/manifest.json", root), "utf8"),
).version;
const releaseFixtures = releaseFixturesFor(currentVersion);
const nextVersion = releaseFixtures.available.version;
const nextReleaseUrl =
  "https://github.com/LaRosette/Blokedex-Trem/releases/tag/v" + nextVersion;
await mkdir(scratch, { recursive: true });
await cp(new URL("extension/", root), fixture, { recursive: true });
const original = await readFile(new URL("background.js", fixture), "utf8");
await writeFile(
  new URL("background.js", fixture),
  `
const createTestTab=chrome.tabs.create.bind(chrome.tabs);
const sendTestMessage=chrome.tabs.sendMessage.bind(chrome.tabs);
const removeTestTab=chrome.tabs.remove.bind(chrome.tabs);
chrome.tabs.remove=async ids=>{
 const {testKeepTab}=await chrome.storage.session.get('testKeepTab');
 if(testKeepTab)throw Error('Fermeture temporairement impossible pour le test d’annulation');
 return removeTestTab(ids);
};
chrome.runtime.onMessage.addListener((message,sender)=>{
 if(sender.id===chrome.runtime.id&&sender.tab&&sender.url?.startsWith('https://x.com/')&&['sessionResult','blockResult','navigateFailed'].includes(message.type)){
  chrome.storage.session.get('testResults').then(({testResults=[]})=>chrome.storage.session.set({testResults:[...testResults,message]}));
 }
});
chrome.tabs.sendMessage=async(id,message)=>{
 if(['navigate','block','abort'].includes(message.type)){
  const {testCommands=[]}=await chrome.storage.session.get('testCommands');
  testCommands.push({type:message.type,jobId:message.jobId,attempt:message.attempt,username:message.account?.username});
  await chrome.storage.session.set({testCommands});
 }
 return sendTestMessage(id,message);
};
chrome.windows.create=async()=>{throw Error('Le traitement ne doit pas ouvrir de fenêtre');};
chrome.tabs.create=async options=>{
 const tab=await createTestTab({...options,url:'about:blank'});
 await new Promise(resolve=>setTimeout(resolve,500));
 const state=await chrome.tabs.get(tab.id);
 const {testTabs=[]}=await chrome.storage.session.get('testTabs');
 testTabs.push({id:tab.id,windowId:state.windowId,active:state.active,requested:options});
 await chrome.storage.session.set({testTabs});
 return chrome.tabs.update(tab.id,{url:options.url});
};
globalThis.fetch=async input=>{
 if(new URL(String(input)).pathname.endsWith('/updates/latest.json')){
  const {testUpdate}=await chrome.storage.session.get('testUpdate');
  return new Response(JSON.stringify(testUpdate||${JSON.stringify(releaseFixtures.current)}));
 }
 const {testList}=await chrome.storage.session.get('testList');
 return new Response(JSON.stringify(testList||{schemaVersion:1,version:'DEMONSTRATION',accounts:${JSON.stringify(accounts)}}));
};
${original}`,
);
const path = fileURLToPath(fixture);
const channel = process.env.TEST_BROWSER_CHANNEL || "chromium";
const headed = process.env.TEST_BROWSER_HEADED === "1";
const context = await chromium.launchPersistentContext(fileURLToPath(profile), {
  channel,
  headless: !headed,
  ignoreDefaultArgs: ["--disable-extensions"],
  viewport: headed ? null : { width: 900, height: 750 },
  args: [`--disable-extensions-except=${path}`, `--load-extension=${path}`],
});
const blocked = [],
  errors = [];
let documents = 0;
let activeOwner = "CompteDeTest";
let fixtureOptions = {};
const blockedByOwner = new Map();
const heldRequests = new Map();
let shownDialogs = 0;
let rejectedNetworkRequests = 0;
await context.route("https://example.invalid/security-probe", async (route) => {
  rejectedNetworkRequests++;
  await route.abort();
});
context.on("page", (page) =>
  page.on("pageerror", (error) => errors.push(error.message)),
);
await context.route("https://pbs.twimg.com/**", async (route) =>
  route.fulfill({
    contentType: "image/png",
    body: await readFile(new URL("extension/icons/icon16.png", root)),
  }),
);

await context.route("https://x.com/**", async (route) => {
  const url = new URL(route.request().url());
  if (route.request().resourceType() === "document") documents++;
  if (["/__test__/dialog", "/__test__/owner"].includes(url.pathname)) {
    heldRequests.set(url.pathname.split("/").at(-1), route);
    return;
  }
  if (url.pathname === "/__test__/shown") {
    shownDialogs++;
    return route.fulfill({ body: "ok" });
  }
  if (url.pathname === "/__test__/blocked") {
    const owner = url.searchParams.get("owner");
    const username = url.searchParams.get("username");
    blocked.push({ owner, username });
    if (!blockedByOwner.has(owner)) blockedByOwner.set(owner, new Set());
    blockedByOwner.get(owner).add(username);
    return route.fulfill({ body: "ok" });
  }
  return route.fulfill({
    contentType: "text/html; charset=utf-8",
    body: sitePage(url.href, activeOwner, {
      ...fixtureOptions,
      blocked: [...(blockedByOwner.get(activeOwner) || [])],
    }),
  });
});
const checks = [];
try {
  const worker =
    context.serviceWorkers()[0] ||
    (await context.waitForEvent("serviceworker"));
  const id = new URL(worker.url()).host;
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${id}/popup.html`);
  await expect(popup.locator("#toggle")).toBeEnabled();
  await expect(popup.locator("#listInfo")).toContainText("3");
  await popup.locator("#toggle").click();
  await popup.locator("#tabBlock").click();
  await expect(popup.locator("#blockPanel")).toBeVisible();
  await expect(popup.locator("#maskPanel")).toBeHidden();
  assert.equal(blocked.length, 0);
  checks.push("changer d’onglet ne déclenche aucune action X");
  const job = () =>
    worker.evaluate(
      async () => (await chrome.storage.local.get("blockJob")).blockJob,
    );
  const waitJob = async (status) =>
    expect
      .poll(async () => (await job())?.status, { timeout: 20000 })
      .toBe(status);
  const startJob = async (button, status) => {
    const previous = (await job())?.id;
    await popup.locator(button).click();
    await expect
      .poll(async () => (await job())?.id, { timeout: 10000 })
      .not.toBe(previous);
    if (status) await waitJob(status);
  };
  await startJob("#startBlock", "done");
  let current = await job();
  assert.equal(current.owner, "CompteDeTest");
  assert.equal(current.created, 1);
  assert.equal(current.already, 1);
  assert.equal(current.failed.length, 1);
  assert.deepEqual(blocked, [
    { owner: "CompteDeTest", username: "CompteTest_A" },
  ]);
  let allTabs = await worker.evaluate(() =>
    chrome.storage.session.get("testTabs"),
  );
  assert.equal(allTabs.testTabs.length, 1);
  assert.equal(allTabs.testTabs[0].requested.active, false);
  assert.ok(
    documents <= 2,
    "les profils sont parcourus par le routeur dans un seul document",
  );
  checks.push(
    "un seul onglet dans la fenêtre courante ; blocage, déjà bloqué et compte indisponible distingués",
  );
  const firstTab = current.tabId;
  await expect(popup.locator("#rescanBlock")).toBeVisible();
  await startJob("#startBlock", "done");
  current = await job();
  assert.equal(current.cached, 2);
  assert.equal(current.created, 0);
  assert.equal(blocked.length, 1);
  checks.push(
    "les comptes déjà traités pour le même utilisateur sont sautés sans nouveau clic",
  );
  activeOwner = "AutreCompte";
  await startJob("#startBlock", "done");
  current = await job();
  assert.equal(current.owner, "AutreCompte");
  assert.equal(current.created, 1);
  assert.equal(current.cached, 0);
  assert.deepEqual(blocked.at(-1), {
    owner: "AutreCompte",
    username: "CompteTest_A",
  });
  checks.push(
    "deuxième utilisateur : session et historique indépendants du premier compte",
  );
  const history = await worker.evaluate(
    async () => (await chrome.storage.local.get("blockHistory")).blockHistory,
  );
  assert.equal(history.length, 2);
  // A renamed handle must never permit blocking its new numeric identity.
  fixtureOptions = { profileIds: { CompteTest_A: "999" } };
  const beforeMismatch = blocked.length;
  await startJob("#rescanBlock", "paused");
  assert.equal(blocked.length, beforeMismatch);
  assert.match((await job()).message, /identité/);
  checks.push(
    "pseudo réattribué : identifiant numérique différent, aucun blocage",
  );
  await popup.locator("#stopBlock").click();
  await waitJob("cancelled");
  blockedByOwner.get(activeOwner)?.delete("CompteTest_A");
  fixtureOptions = { dialogUsernames: { CompteTest_A: "AutreCible" } };
  await startJob("#startBlock", "done");
  // Normal start reused the confirmed local history; rescan is explicit.
  await startJob("#rescanBlock", "paused");
  assert.equal(blocked.length, beforeMismatch);
  assert.match((await job()).message, /Confirmation/);
  checks.push("confirmation adressée à un autre compte refusée avant le clic");
  await popup.locator("#stopBlock").click();
  await waitJob("cancelled");
  fixtureOptions = { holdDialogHandles: ["CompteTest_A"] };
  // Clear the local history to exercise the next account action again.
  await popup.locator("#forgetBlock").click();
  await expect.poll(job).toBeUndefined();
  await startJob("#startBlock");
  await expect
    .poll(() => heldRequests.has("dialog"), { timeout: 15000 })
    .toBe(true);
  const pending = await job();
  await popup.locator("#stopBlock").click();
  await waitJob("cancelled");
  await heldRequests.get("dialog").fulfill({ body: "ok" });
  heldRequests.delete("dialog");
  const blockPage = context
    .pages()
    .find((p) => p.url().endsWith("/CompteTest_A") && p !== popup);
  if (blockPage)
    await expect
      .poll(() => blockPage.locator("#dialog").evaluate((e) => !e.hidden))
      .toBe(true);
  await worker
    .evaluate(async (data) => {
      const tab = await chrome.tabs.get(data.tabId);
      await chrome.runtime.sendMessage({
        type: "blockResult",
        jobId: data.id,
        attempt: data.attempt,
        outcome: "blocked",
      });
    }, pending)
    .catch(() => {});
  assert.equal((await job()).status, "cancelled");
  assert.equal((await job()).confirmed, 0);
  assert.equal(blocked.length, beforeMismatch);
  checks.push(
    "arrêt pendant la confirmation : le résultat tardif ne relance pas la tâche",
  );
  await popup.locator("#forgetBlock").click();
  await expect.poll(job).toBeUndefined();
  const privacy = await worker.evaluate(() =>
    chrome.storage.local.get(["blockHistory", "blockAccount", "blockJob"]),
  );
  assert.deepEqual(privacy, {});
  checks.push(
    "effacement de l’historique local sans débloquer les comptes sur X",
  );
  const messages = await worker.evaluate(() =>
    chrome.storage.session.get("testCommands"),
  );
  assert.ok(messages.testCommands.some((m) => m.type === "navigate"));
  assert.equal(errors.length, 0, JSON.stringify(errors));
  assert.equal(rejectedNetworkRequests, 0);
  checks.push(
    "aucune fenêtre créée, aucun cookie ou jeton lu, aucune API X appelée",
  );
  const report = {
    version: currentVersion,
    browser: context.browser().version(),
    checks,
    documents,
    blocked: blocked.length,
    result: "success",
    network: "Profils fictifs uniquement ; aucun compte réel modifié",
  };
  await mkdir(new URL("verification/", root), { recursive: true });
  await writeFile(
    new URL("verification/blocking.json", root),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error("Erreurs", errors);
  const worker = context.serviceWorkers()[0];
  if (worker)
    console.error(
      "État",
      await worker.evaluate(() => chrome.storage.local.get(null)),
    );
  throw error;
} finally {
  for (const route of heldRequests.values())
    await route.abort().catch(() => {});
  await context.close();
}
