import { chromium, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { filterAccounts, filterPage } from "../tests/fixtures/filter-site.mjs";
import { CONFIG } from "../extension/config.js";

const root = new URL("../", import.meta.url);
const scratch = new URL(
  `../../../work/popup-layout-${Date.now()}/`,
  import.meta.url,
);
const fixture = new URL("extension/", scratch);
await mkdir(scratch, { recursive: true });
await cp(new URL("extension/", root), fixture, { recursive: true });
const manifest = JSON.parse(
  await readFile(new URL("manifest.json", fixture), "utf8"),
);
const originalBackground = await readFile(
  new URL("background.js", fixture),
  "utf8",
);
// Les sources de production restent intactes. Seuls les téléchargements de données sont simulés.
await writeFile(
  new URL("background.js", fixture),
  `
const nativeLayoutFetch=globalThis.fetch.bind(globalThis);
globalThis.fetch=async(input,options)=>{
 const href=typeof input==='string'?input:input.url||String(input);
 if(href===${JSON.stringify(CONFIG.listUrl)})return new Response(JSON.stringify({schemaVersion:1,version:'LAYOUT-NATIF',accounts:${JSON.stringify(filterAccounts)}}),{headers:{'Content-Type':'application/json'}});
 if(href===${JSON.stringify(CONFIG.updatesUrl)})return new Response(JSON.stringify({schemaVersion:1,version:${JSON.stringify(manifest.version)}}),{headers:{'Content-Type':'application/json'}});
 if(href.startsWith(chrome.runtime.getURL('')))return nativeLayoutFetch(input,options);
 throw Error('Requête extérieure interdite pendant le test de mise en page.');
};
${originalBackground}`,
);
const channel = process.env.TEST_BROWSER_CHANNEL || "chromium";
const headed = process.env.TEST_BROWSER_HEADED === "1";
const sizes = [
  { width: 412, height: 750 },
  { width: 1280, height: 900 },
];
const displayScaleFactors = [1, 1.25, 1.5];
const results = [];
for (const size of sizes)
  for (const displayScaleFactor of displayScaleFactors) {
    const profile = new URL(
      `profile-${size.width}-${displayScaleFactor}/`,
      scratch,
    );
    const extension = fileURLToPath(fixture);
    const context = await chromium.launchPersistentContext(
      fileURLToPath(profile),
      {
        channel,
        headless: !headed,
        viewport: null,
        ignoreDefaultArgs: ["--disable-extensions"],
        args: [
          `--disable-extensions-except=${extension}`,
          `--load-extension=${extension}`,
          `--window-size=${size.width},${size.height}`,
          `--force-device-scale-factor=${displayScaleFactor}`,
        ],
      },
    );
    try {
      await context.route("https://x.com/**", (route) =>
        route.fulfill({
          contentType: "text/html; charset=utf-8",
          body: filterPage(),
        }),
      );
      const worker =
        context.serviceWorkers()[0] ||
        (await context.waitForEvent("serviceworker"));
      const extensionId = new URL(worker.url()).host;
      const control = await context.newPage();
      await control.goto(`chrome-extension://${extensionId}/privacy.html`);
      const timeline = await context.newPage();
      await timeline.goto("https://x.com/home");
      await worker.evaluate(() => chrome.action.openPopup());
      await control.waitForFunction(() => {
        const popup = chrome.extension.getViews({ type: "popup" })[0];
        return (
          popup?.document.querySelector("#toggle")?.disabled === false &&
          !popup.document.querySelector("#pageStats")?.hidden
        );
      });
      const snapshot = () =>
        control.evaluate(() => {
          const popup = chrome.extension.getViews({ type: "popup" })[0];
          if (!popup) return null;
          const document = popup.document,
            html = document.documentElement;
          const rect = (selector) =>
            document.querySelector(selector).getBoundingClientRect().toJSON();
          return {
            width: popup.innerWidth,
            height: popup.innerHeight,
            devicePixelRatio: popup.devicePixelRatio,
            bodyWidth: document.body.getBoundingClientRect().width,
            htmlWidth: html.getBoundingClientRect().width,
            scrollWidth: Math.max(html.scrollWidth, document.body.scrollWidth),
            scrollHeight: html.scrollHeight,
            content: rect("main"),
            overflowX: popup.getComputedStyle(html).overflowX,
            heading: rect(
              document.body.dataset.mode === "block"
                ? "#blockPanel h1"
                : "#maskPanel h1",
            ),
            button: rect(
              document.body.dataset.mode === "block"
                ? "#startBlock"
                : "#toggle",
            ),
            footer: rect("footer"),
            footerChildren: [
              ...document.querySelectorAll(
                "footer a, footer button, #currentVersion",
              ),
            ].map((element) => element.getBoundingClientRect().toJSON()),
            detailsOpen: document.querySelector("details").open,
            pressed: document
              .querySelector("#toggle")
              .getAttribute("aria-pressed"),
          };
        });
      const assertLayout = (info, label) => {
        assert.ok(info, label + " : le vrai popup doit rester ouvert");
        assert.ok(
          info.width >=
            (size.width === 412 && displayScaleFactor >= 1.5 ? 280 : 359) &&
            info.width <= 380,
          label + " : largeur native " + info.width,
        );
        assert.ok(
          Math.abs(info.bodyWidth - 360) < 1,
          label + " : largeur de body " + info.bodyWidth,
        );
        assert.ok(
          Math.abs(info.htmlWidth - 360) < 1,
          label + " : largeur de html " + info.htmlWidth,
        );
        assert.ok(
          info.heading.height <= 66,
          label + " : titre sur plus de deux lignes",
        );
        assert.ok(
          info.button.width >= Math.min(300, info.width - 48),
          label + " : bouton trop étroit",
        );
        assert.ok(
          info.content.right <= info.width + 1 &&
            (info.scrollWidth <= info.width + 1 || info.overflowX === "clip"),
          label + " : contenu au-delà de la largeur disponible",
        );
        for (const child of info.footerChildren)
          assert.ok(
            child.x >= 0 && child.right <= info.width + 1,
            label + " : pied de page tronqué",
          );
      };
      let info;
      await expect
        .poll(async () => {
          info = await snapshot();
          return info?.heading.height <= 66;
        })
        .toBe(true);
      console.log(
        JSON.stringify({ window: size, displayScaleFactor, initial: info }),
      );
      assertLayout(info, "état initial");
      assert.equal(info.pressed, "false");
      const initial = info;
      await control.evaluate(() =>
        chrome.extension
          .getViews({ type: "popup" })[0]
          .document.querySelector("#toggle")
          .click(),
      );
      await expect.poll(async () => (await snapshot())?.pressed).toBe("true");
      info = await snapshot();
      assertLayout(info, "filtre actif");
      await control.evaluate(() => {
        chrome.extension
          .getViews({ type: "popup" })[0]
          .document.querySelector("details").open = true;
      });
      await expect.poll(async () => (await snapshot())?.detailsOpen).toBe(true);
      await expect
        .poll(async () => {
          info = await snapshot();
          return info?.height >= initial.height;
        })
        .toBe(true);
      assertLayout(info, "liste dépliée");
      await control.evaluate(() => {
        const document = chrome.extension.getViews({ type: "popup" })[0]
          .document;
        document.querySelector("details").open = false;
        document.querySelector("#tabBlock").click();
      });
      const blockInfo = await snapshot();
      assertLayout(blockInfo, "onglet Bloquer");
      results.push({
        window: size,
        displayScaleFactor,
        initial,
        expanded: info,
        blocking: blockInfo,
      });
    } finally {
      await context.close();
    }
  }
const report = {
  date: new Date().toISOString(),
  browser: channel,
  extensionVersion: manifest.version,
  method:
    "chrome.action.openPopup et chrome.extension.getViews(type:popup), aucun viewport artificiel pour le popup",
  scaling:
    "Facteurs d’échelle d’affichage Chromium (DPI), distincts du zoom de page",
  network: "Profils fictifs et téléchargements simulés ; aucun accès X réel",
  results,
  result: `${results.length} configurations de popup natif réussies`,
};
await mkdir(new URL("verification/", root), { recursive: true });
await writeFile(
  new URL("verification/popup-layout.json", root),
  JSON.stringify(report, null, 2),
);
console.log(report.result + " (" + channel + ").");
