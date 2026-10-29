import { readFile } from "node:fs/promises";
import { test } from "node:test";
import assert from "node:assert/strict";
import { manifestFor } from "../scripts/manifests.mjs";
import { CONFIG } from "../extension/config.js";
const manifest = JSON.parse(
  await readFile(
    new URL("../extension/manifest.json", import.meta.url),
    "utf8",
  ),
);

test("les trois paquets gardent un périmètre de permissions minimal", () => {
  for (const browser of ["chrome", "edge", "firefox"]) {
    const value = manifestFor(manifest, browser);
    assert.deepEqual(value.permissions.slice().sort(), ["alarms", "storage"]);
    assert.deepEqual(value.host_permissions.slice().sort(), [
      "https://raw.githubusercontent.com/*",
      "https://twitter.com/*",
      "https://x.com/*",
    ]);
    assert.equal(value.externally_connectable, undefined);
    assert.equal(value.web_accessible_resources, undefined);
    assert.equal(value.content_scripts[0].all_frames, undefined);
  }
});
test("les pages privilégiées ne peuvent charger ni exécuter de ressources distantes", () => {
  const directives = Object.fromEntries(
    manifest.content_security_policy.extension_pages
      .split(";")
      .filter((value) => value.trim())
      .map((value) => {
        const [name, ...sources] = value.trim().split(/\s+/);
        return [name, sources];
      }),
  );
  for (const name of ["default-src", "script-src", "style-src", "img-src"])
    assert.deepEqual(directives[name], ["'self'"]);
  assert.deepEqual(directives["object-src"], ["'none'"]);
  assert.deepEqual(directives["base-uri"], ["'none'"]);
  assert.deepEqual(directives["form-action"], ["'none'"]);
  assert.deepEqual(directives["connect-src"], [
    "'self'",
    CONFIG.listUrl,
    CONFIG.updatesUrl,
  ]);
});

test("le filtre injecte uniquement son CSS et ses scripts locaux au début des pages X", async () => {
  for (const browser of ["chrome", "edge", "firefox"]) {
    const value = manifestFor(manifest, browser);
    assert.deepEqual(value.content_scripts, [
      {
        run_at: "document_start",
        matches: ["https://x.com/*", "https://twitter.com/*"],
        js: [
          "filter-core.js",
          "profile-filter.js",
          "content.js",
          "block-content.js",
        ],
        css: ["filter.css", "profile-filter.css"],
      },
    ]);
  }
  const catalog = JSON.parse(
    await readFile(
      new URL("../extension/catalog.json", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(catalog.schemaVersion, 1);
  assert.ok(catalog.accounts.length > 0);
});
