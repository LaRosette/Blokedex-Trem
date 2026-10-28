import {
  accounts,
  addedAccount,
  sitePage,
  releaseFixturesFor,
} from "../tests/fixtures/site.mjs";
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
  viewport: headed ? null : { width: 330, height: 650 },
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
try {
  const worker =
    context.serviceWorkers()[0] ||
    (await context.waitForEvent("serviceworker"));
  const id = new URL(worker.url()).host;
  let page = await context.newPage();
  await page.goto(`chrome-extension://${id}/popup.html`);
  await page.getByText("3 comptes dans la liste.", { exact: true }).waitFor();
  await expect(page).toHaveTitle("Blokedex-Trem");
  await expect(page.locator(".brand")).toHaveText("Blokedex-Trem");
  await expect(page.locator("#currentVersion")).toHaveText(
    "v" + currentVersion,
  );
  await expect(page.locator("#updateNotice")).toBeHidden();
  await expect(page.locator("#listUpdatesNotice")).toBeHidden();
  await expect
    .poll(() => worker.evaluate(() => chrome.action.getBadgeText({})))
    .toBe("");
  await worker.evaluate(
    (value) => chrome.storage.session.set({ testUpdate: value }),
    releaseFixtures.available,
  );
  await page.locator("#checkUpdate").click();
  await expect(page.locator("#updateNotice")).toBeVisible();
  await expect(page.locator("#updateLink")).toHaveAttribute(
    "href",
    nextReleaseUrl,
  );
  await expect(page.locator("#updateLink")).toHaveText(
    "Voir la version " + nextVersion,
  );
  await expect(page.locator("#start")).toBeEnabled();
  await worker.evaluate(async (value) => {
    await chrome.storage.session.set({ testUpdate: value });
    await chrome.storage.local.remove([
      "latestRelease",
      "updateCheckedAt",
      "updateError",
    ]);
  }, releaseFixtures.injected);
  await page.locator("#checkUpdate").click();
  await expect(page.locator("#updateNotice")).toBeHidden();
  await expect(page.locator("#updateLink")).not.toHaveAttribute("href");
  assert.equal(
    await page.evaluate(() => globalThis.__releaseInjection),
    undefined,
  );
  await expect(page.locator("#updateStatus")).toContainText(
    "Vérification indisponible",
  );
  await worker.evaluate(
    (value) => chrome.storage.session.set({ testUpdate: value }),
    releaseFixtures.current,
  );
  await page.locator("#checkUpdate").click();
  await expect(page.locator("#updateStatus")).toContainText(
    "Aucune nouvelle version publiée",
  );
  await expect(page.locator("#updateNotice")).toBeHidden();
  const blockedDirective = await page.evaluate(async () => {
    const violation = new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(Error("La CSP n’a pas bloqué la requête de test.")),
        3000,
      );
      addEventListener("securitypolicyviolation", (event) => {
        if (event.blockedURI === "https://example.invalid/security-probe") {
          clearTimeout(timer);
          resolve(event.effectiveDirective);
        }
      });
    });
    await fetch("https://example.invalid/security-probe").catch(() => {});
    return violation;
  });
  assert.equal(blockedDirective, "connect-src");
  assert.equal(
    rejectedNetworkRequests,
    0,
    "La requête interdite ne doit pas atteindre le réseau",
  );
  const privacyPage = await context.newPage();
  await privacyPage.goto(`chrome-extension://${id}/privacy.html`);
  assert.equal(
    await privacyPage
      .locator("body")
      .evaluate((body) => getComputedStyle(body).color),
    "rgb(24, 63, 53)",
  );
  assert.ok(
    await privacyPage.evaluate(() =>
      [...document.styleSheets].some(
        (sheet) =>
          sheet.href?.endsWith("/privacy.css") && sheet.cssRules.length > 0,
      ),
    ),
  );
  await privacyPage.close();
  const readJob = () =>
    worker.evaluate(async () => (await chrome.storage.local.get("job")).job);
  const navigateCommands = (job) =>
    worker.evaluate(async (jobId) => {
      const { testCommands = [] } =
        await chrome.storage.session.get("testCommands");
      return testCommands
        .filter(
          (command) => command.jobId === jobId && command.type === "navigate",
        )
        .map((command) => command.username);
    }, job.id);
  const run = async (button = "start", status = "done") => {
    const previous = (await readJob())?.id;
    const before = documents;
    const started = Date.now();
    if (button === "rescan" && !(await page.locator("#rescan").isVisible()))
      await page.locator("summary").click();
    await page.locator("#" + button).click();
    await expect
      .poll(
        async () => {
          const job = await readJob();
          return job?.id !== previous && job?.status === status;
        },
        { timeout: 30000, intervals: [50, 100, 200] },
      )
      .toBe(true);
    const job = await readJob();
    if (status === "done") {
      assert.equal(
        documents - before,
        1,
        "Un seul chargement complet de X pour tout le lot",
      );
      assert.equal(
        await worker.evaluate(async (tabId) => {
          try {
            await chrome.tabs.get(tabId);
            return false;
          } catch {
            return true;
          }
        }, job.tabId),
        true,
        "L’onglet de travail doit se fermer",
      );
      await expect(page.locator("#start")).toBeEnabled();
    }
    return { job, duration: Date.now() - started };
  };
  const first = await run();
  const { job } = first;
  assert.equal(job.confirmed, 2);
  assert.equal(job.failed.length, 1);
  assert.equal(job.status, "done");
  assert.equal(job.owner, "CompteDeTest");
  assert.match(job.ownerKey, /^[a-f0-9]{64}$/);
  assert.equal(job.created, 1);
  assert.equal(job.already, 1);
  assert.equal(job.cached, 0);
  await expect.poll(() => blocked.length).toBe(1);
  assert.deepEqual(blocked, [
    { owner: "CompteDeTest", username: "CompteTest_A" },
  ]);
  assert.deepEqual(await navigateCommands(job), [
    "CompteTest_A",
    "CompteTest_B",
    "CompteTest_C",
  ]);
  assert.equal(
    documents,
    1,
    "Un seul chargement complet de X pour tout le lot",
  );
  const elapsed = first.duration;
  const { testTabs } = await worker.evaluate(
    async () => await chrome.storage.session.get("testTabs"),
  );
  assert.equal(testTabs.length, 1);
  assert.equal(testTabs[0].active, false);
  assert.equal(testTabs[0].requested.active, false);
  const popupWindow = await worker.evaluate(
    async () =>
      (await chrome.tabs.query({ url: chrome.runtime.getURL("popup.html") }))[0]
        .windowId,
  );
  assert.equal(testTabs[0].windowId, popupWindow);

  assert.equal(
    context.pages().filter((p) => p.url().startsWith("https://x.com/")).length,
    0,
  );
  await page.close();
  page = await context.newPage();
  await page.goto(`chrome-extension://${id}/popup.html`);
  await expect(page.locator("#owner")).toContainText("@CompteDeTest");
  assert.equal((await readJob()).id, job.id);
  await mkdir(new URL("verification/", root), { recursive: true });
  await page.screenshot({
    path: fileURLToPath(
      new URL("verification/interface-minimaliste.png", root),
    ),
    fullPage: true,
  });
  // Le cache est volontairement une mémoire locale, pas une lecture de l’état actuel de X.
  // On simule un déblocage manuel : seul « Tout revérifier » doit repasser sur ce profil.
  blockedByOwner.get(activeOwner).delete("CompteTest_A");
  const cached = await run();
  assert.equal(cached.job.cached, 2);
  assert.equal(cached.job.created, 0);
  assert.equal(cached.job.already, 0);
  assert.equal(cached.job.failed.length, 1);
  assert.deepEqual(await navigateCommands(cached.job), ["CompteTest_C"]);
  assert.equal(blocked.length, 1);
  const rescan = await run("rescan");
  assert.equal(rescan.job.force, true);
  assert.equal(rescan.job.cached, 0);
  assert.equal(rescan.job.created, 1);
  assert.equal(rescan.job.already, 1);
  assert.deepEqual(await navigateCommands(rescan.job), [
    "CompteTest_A",
    "CompteTest_B",
    "CompteTest_C",
  ]);
  await expect.poll(() => blocked.length).toBe(2);
  // Changer de compte ne doit jamais réutiliser le cache du précédent.
  activeOwner = "AutreCompte";
  const other = await run();
  assert.equal(other.job.owner, activeOwner);
  assert.match(other.job.ownerKey, /^[a-f0-9]{64}$/);
  assert.notEqual(other.job.ownerKey, job.ownerKey);
  assert.equal(other.job.cached, 0);
  assert.equal(other.job.created, 1);
  assert.equal(other.job.already, 1);
  await expect.poll(() => blocked.length).toBe(3);
  const history = await worker.evaluate(
    async () =>
      (await chrome.storage.local.get("processedHistory")).processedHistory,
  );
  assert.deepEqual(
    new Set(history.map((row) => row.username)),
    new Set(["CompteDeTest", "AutreCompte"]),
  );
  assert.ok(history.every((row) => row.ids.length === 2));
  const refreshPublishedList = async (nextAccounts, count, username) => {
    await worker.evaluate(
      (items) =>
        chrome.storage.session.set({
          testList: {
            schemaVersion: 1,
            version: "AJOUTS-SIMULES",
            accounts: items,
          },
        }),
      nextAccounts,
    );
    const reply = await page.evaluate(() =>
      chrome.runtime.sendMessage({ type: "refresh" }),
    );
    assert.equal(reply?.ok, true);
    await expect
      .poll(() => worker.evaluate(() => chrome.action.getBadgeText({})))
      .toBe(count ? String(count) : "");
    if (count) {
      await expect(page.locator("#listUpdatesNotice")).toBeVisible();
      await expect(page.locator("#listUpdatesCount")).toHaveText(
        "1 nouveau compte à bloquer",
      );
      await expect(page.locator("#listUpdatesOwner")).toHaveText(
        "Pour @" + username,
      );
      const info = await page.evaluate(
        async () =>
          (await chrome.runtime.sendMessage({ type: "state" })).data
            .listUpdates,
      );
      assert.equal(info.count, count);
      assert.equal(info.username, username);
      assert.match(
        await worker.evaluate(() => chrome.action.getTitle({})),
        new RegExp("@" + username),
      );
    } else {
      await expect(page.locator("#listUpdatesNotice")).toBeHidden();
    }
  };
  // Un profil déjà indisponible dans le dernier lot n’est pas un nouvel ajout.
  await refreshPublishedList(accounts, 0);
  await refreshPublishedList([...accounts, addedAccount], 1, "AutreCompte");
  await refreshPublishedList([...accounts, addedAccount], 1, "AutreCompte");
  await refreshPublishedList(accounts, 0);
  await refreshPublishedList([addedAccount, ...accounts], 1, "AutreCompte");
  // Le profil ajouté est déjà bloqué sur X : sa confirmation doit solder l’alerte.
  blockedByOwner.get(activeOwner).add(addedAccount.username);
  const additions = await run();
  assert.equal(additions.job.confirmed, 3);
  assert.equal(additions.job.cached, 2);
  assert.equal(additions.job.already, 1);
  assert.equal(additions.job.created, 0);
  await expect
    .poll(() => worker.evaluate(() => chrome.action.getBadgeText({})))
    .toBe("");
  await expect(page.locator("#listUpdatesNotice")).toBeHidden();
  activeOwner = "CompteDeTest";
  await refreshPublishedList(accounts, 0);
  const selected = await run();
  assert.equal(selected.job.owner, activeOwner);
  assert.equal(selected.job.cached, 2);
  // Le même ajout reste à traiter pour le second compte, même si l’autre l’a fait.
  await refreshPublishedList([...accounts, addedAccount], 1, activeOwner);
  await refreshPublishedList(accounts, 0);
  assert.equal(blocked.length, 3);
  // Une identité incohérente doit suspendre, sans cliquer sur Bloquer.
  await worker.evaluate(async () => {
    await chrome.storage.session.set({
      testList: {
        schemaVersion: 1,
        version: "IDENTITE-INCORRECTE",
        accounts: [{ id: "999", username: "CompteTest_A" }],
      },
    });
  });
  const invalid = await run("start", "paused");
  assert.equal(invalid.job.confirmed, 0);
  await expect(page.locator("#status")).toContainText("vérifier l’identité");
  assert.equal(blocked.length, 3);
  await page.getByRole("button", { name: "Vérifier X", exact: true }).click();
  await expect
    .poll(() => worker.evaluate(async () => {
      const { job } = await chrome.storage.local.get("job");
      return (await chrome.tabs.get(job.tabId)).active;
    }))
    .toBe(true);
  await page.getByRole("button", { name: "Arrêter", exact: true }).click();
  await page
    .getByText("Arrêté. Les blocages déjà faits restent actifs.", {
      exact: true,
    })
    .waitFor();
  assert.equal((await readJob()).status, "cancelled");
  fixtureOptions = {
    profileIds: { CompteTest_A: "999" },
    articleFollowIds: { CompteTest_A: "11" },
  };
  await worker.evaluate(async () =>
    chrome.storage.session.set({
      testList: {
        schemaVersion: 1,
        version: "IDENTITE-ARTICLE",
        accounts: [{ id: "11", username: "CompteTest_A" }],
      },
    }),
  );
  const article = await run("rescan", "paused");
  assert.equal(article.job.confirmed, 0);
  await expect(page.locator("#status")).toContainText("vérifier l’identité");
  assert.equal(
    blocked.length,
    3,
    "Un identifiant présent dans un article ne valide pas le profil",
  );
  await page.locator("#cancel").click();
  await expect.poll(async () => (await readJob()).status).toBe("cancelled");
  // X n’affiche pas toujours l’identifiant numérique sur les profils déjà bloqués.
  // Ce profil doit être sauté sans action et sans certifier l’ID dans l’historique.
  activeOwner = "CompteSansCache";
  fixtureOptions = { genericUnblockHandles: ["CompteTest_B"] };
  await worker.evaluate(async () =>
    chrome.storage.session.set({
      testList: {
        schemaVersion: 1,
        version: "DEJA-BLOQUE-SANS-ID",
        accounts: [{ id: "12", username: "CompteTest_B" }],
      },
    }),
  );
  const generic = await run();
  assert.equal(generic.job.owner, activeOwner);
  assert.equal(generic.job.confirmed, 1);
  assert.equal(generic.job.already, 1);
  assert.equal(generic.job.created, 0);
  assert.equal(generic.job.cached, 0);
  assert.equal(generic.job.failed.length, 0);
  assert.deepEqual(await navigateCommands(generic.job), ["CompteTest_B"]);
  assert.equal(blocked.length, 3);
  const genericHistory = await worker.evaluate(
    async () =>
      (await chrome.storage.local.get("processedHistory")).processedHistory,
  );
  assert.ok(
    !genericHistory.some(
      (row) => row.key === generic.job.ownerKey || row.username === activeOwner,
    ),
    "Un profil bloqué sans identifiant confirmé ne doit pas alimenter le cache",
  );
  const sendToContent = (tabId, message) =>
    worker.evaluate(
      ({ tabId, message }) => chrome.tabs.sendMessage(tabId, message),
      { tabId, message },
    );
  const waitResult = async (message) => {
    let result;
    await expect
      .poll(async () => {
        result = await worker.evaluate(async (identity) => {
          const { testResults = [] } =
            await chrome.storage.session.get("testResults");
          return testResults.find(
            (row) =>
              row.jobId === identity.jobId && row.attempt === identity.attempt,
          );
        }, message);
        return !!result;
      })
      .toBe(true);
    return result;
  };
  const contentCase = async (name, options) => {
    fixtureOptions = options;
    const tab = await worker.evaluate(() =>
      chrome.tabs.create({ url: "https://x.com/CompteTest_A", active: false }),
    );
    try {
      await expect
        .poll(
          async () =>
            (await sendToContent(tab.id, { type: "probe" }).catch(() => null))
              ?.owner,
        )
        .toBe(activeOwner);
      const message = {
        type: "block",
        jobId: "security-" + name,
        attempt: "security-" + name,
        owner: activeOwner,
        ownerKey: generic.job.ownerKey,
        account: accounts[0],
      };
      assert.equal((await sendToContent(tab.id, message)).accepted, true);
      const result = await waitResult(message);
      assert.equal(
        result.outcome,
        "error",
        name + " doit interrompre le blocage",
      );
      assert.equal(blocked.length, 3, name + " ne doit produire aucun blocage");
      return result;
    } finally {
      await worker.evaluate((id) => chrome.tabs.remove(id), tab.id);
    }
  };
  await contentCase("prefix-header", {
    headerUsernames: { CompteTest_A: "CompteTest_AB" },
  });
  await contentCase("prefix-menu", {
    menuUsernames: { CompteTest_A: "CompteTest_AB" },
  });
  await contentCase("prefix-dialog", {
    dialogUsernames: { CompteTest_A: "CompteTest_AB" },
  });
  const mutated = await contentCase("mutated-id", {
    confirmationIds: { CompteTest_A: "999" },
  });
  assert.equal(
    mutated.code,
    "identity",
    "L’identité numérique doit être revérifiée avant confirmation",
  );
  // Même si fermer l’onglet échoue, Arrêter doit invalider le travail en attente.
  fixtureOptions = {
    holdDialogHandles: ["CompteTest_A"],
    holdOwnerAfterDialog: true,
  };
  await worker.evaluate(() =>
    chrome.storage.session.set({
      testKeepTab: true,
      testList: {
        schemaVersion: 1,
        version: "DIALOGUE-RETARDE",
        accounts: [{ id: "11", username: "CompteTest_A" }],
      },
    }),
  );
  const beforeLate = documents;
  await page.locator("#start").click();
  await expect.poll(() => heldRequests.has("dialog")).toBe(true);
  const late = await readJob();
  assert.equal(late.status, "running");
  assert.equal(late.confirmed, 0);
  // Un résultat prétendument envoyé par X ne peut pas être forgé depuis le popup.
  await page.evaluate(
    async ({ jobId, attempt }) => {
      try {
        await chrome.runtime.sendMessage({
          type: "blockResult",
          jobId,
          attempt,
          outcome: "blocked",
        });
      } catch {}
    },
    { jobId: late.id, attempt: late.attempt },
  );
  assert.equal((await readJob()).confirmed, 0);
  assert.equal((await readJob()).status, "running");
  await page.locator("#cancel").click();
  await expect.poll(async () => (await readJob()).status).toBe("cancelled");
  await expect(page.locator("#start")).toBeEnabled();
  const commandsAfterCancel = await worker.evaluate(
    async () => (await chrome.storage.session.get("testCommands")).testCommands,
  );
  assert.ok(
    commandsAfterCancel.some(
      (command) =>
        command.type === "abort" &&
        command.jobId === late.id &&
        command.attempt === late.attempt,
    ),
  );
  assert.ok(
    await worker.evaluate((id) => chrome.tabs.get(id), late.tabId),
    "Le test doit conserver le document après l’annulation",
  );
  const previousShown = shownDialogs;
  await heldRequests.get("dialog").fulfill({ body: "ok" });
  heldRequests.delete("dialog");
  await expect.poll(() => shownDialogs).toBe(previousShown + 1);
  await expect.poll(() => heldRequests.has("owner")).toBe(true);
  assert.equal(
    blocked.length,
    3,
    "Le dialogue apparu après Arrêter ne doit pas être confirmé",
  );
  const newTask = {
    type: "inspect",
    jobId: "security-new-task",
    attempt: "security-new-attempt",
  };
  assert.equal((await sendToContent(late.tabId, newTask)).accepted, true);
  const staleAbort = await sendToContent(late.tabId, {
    type: "abort",
    jobId: late.id,
    attempt: late.attempt,
  });
  assert.equal(
    staleAbort.aborted,
    false,
    "L’annulation d’une ancienne tentative ne doit pas invalider la nouvelle",
  );
  await heldRequests.get("owner").fulfill({ body: "ok" });
  heldRequests.delete("owner");
  const newResult = await waitResult(newTask);
  assert.equal(newResult.type, "sessionResult");
  assert.equal(newResult.owner, activeOwner);
  const allResults = await worker.evaluate(
    async () => (await chrome.storage.session.get("testResults")).testResults,
  );
  assert.ok(
    !allResults.some(
      (row) =>
        row.type === "blockResult" &&
        row.jobId === late.id &&
        row.attempt === late.attempt,
    ),
    "Une tentative annulée ne doit pas émettre de résultat tardif",
  );
  assert.equal(blocked.length, 3);
  assert.equal(documents - beforeLate, 1);
  await worker.evaluate(async (tabId) => {
    await chrome.storage.session.set({ testKeepTab: false });
    await chrome.tabs.remove(tabId);
  }, late.tabId);
  assert.deepEqual(errors, []);
  await writeFile(
    new URL(`verification/${channel}.json`, root),
    JSON.stringify(
      {
        date: new Date().toISOString(),
        browser: channel,
        version: context.browser()?.version(),
        headed,
        network: "Pages X et liste simulées, aucun compte réel modifié",
        batchDurationMs: elapsed,
        cachedBatchDurationMs: cached.duration,
        rescanDurationMs: rescan.duration,
        checks: [
          "manifeste MV3 et scripts de contenu chargés",
          "un clic sur le bouton principal",
          "détection du compte déjà connecté",
          "menu de profil et confirmation de blocage",
          "compte déjà bloqué ignoré sans déblocage",
          "compte indisponible conservé au bilan",
          "onglet de travail fermé à la fin",
          "progression conservée après fermeture du popup",
          "identifiant incorrect : arrêt sans blocage",
          "bouton Arrêter et aucune erreur JavaScript",
          "un seul onglet dans la fenêtre courante pour toute la liste",
          "onglet créé sans activation et aucune fenêtre popup",
          "bouton Vérifier X réservé à une opération en pause",
          "navigation interne : un seul chargement complet pour tout le lot",
          "identité locale cloisonnée par compte connecté",
          "profil valide sans publication traité correctement",
          "second passage : deux comptes confirmés sautés sans navigation",
          "Tout revérifier réapplique un blocage retiré manuellement",
          "autre compte X : aucun cache partagé",
          "identifiant trouvé dans un article refusé comme identité du profil",
          "profil déjà bloqué sans identifiant numérique sauté sans action et sans cache",
          "pseudo plus long refusé dans l’en-tête du profil",
          "pseudo plus long refusé dans le menu Bloquer",
          "pseudo plus long refusé dans le dialogue de confirmation",
          "identifiant numérique modifié avant confirmation : aucun clic",
          "annulation pendant l’attente : dialogue tardif jamais confirmé",
          "annulation d’une ancienne tentative sans effet sur une nouvelle tâche",
          "résultat de contenu forgé depuis le popup refusé",
          "CSP : connexion hors liste bloquée avant tout accès réseau",
          "page confidentialité et feuille de style externe chargées sous CSP stricte",
          "marque Blokedex-Trem et version installée affichées",
          "version supérieure au manifeste signalée avec lien GitHub construit et validé",
          "métadonnées de version injectées refusées sans HTML ni lien arbitraire",
          "première installation et anciens profils indisponibles sans fausse alerte",
          "ajout de liste signalé ; retrait et liste égale sans compteur persistant",
          "nouveaux profils cloisonnés par dernier compte X explicitement confirmé",
          "fin du traitement des ajouts : encart et badge effacés",
        ],
        result: "37 contrôles réussis",
      },
      null,
      2,
    ),
  );
  console.log(
    "37 contrôles navigateur réussis. Durée du lot simulé : " +
      elapsed +
      " ms. Capture : verification/interface-minimaliste.png",
  );
} catch (error) {
  const worker = context.serviceWorkers()[0];
  console.error(
    "État au moment de l’échec :",
    await worker?.evaluate(
      async () =>
        await chrome.storage.local.get([
          "job",
          "list",
          "listAlertSeen",
          "listAlertPending",
          "lastConfirmedAccount",
          "processedHistory",
        ]),
    ),
  );
  for (const page of context.pages())
    console.error(
      "Page :",
      page.url(),
      (
        await page
          .locator("body")
          .innerText()
          .catch(() => "")
      ).slice(0, 1800),
    );
  throw error;
} finally {
  await context.close();
}
