import { test } from "node:test";
import assert from "node:assert/strict";
import { allowsMessage } from "../extension/messages.js";
const runtime = {
  id: "extension-id",
  getURL: (path) => "chrome-extension://extension-id/" + path,
};
const popup = { id: runtime.id, url: runtime.getURL("popup.html") };
const content = {
  id: runtime.id,
  url: "https://x.com/home",
  frameId: 0,
  tab: { id: 7 },
};

test("seul le popup de cette extension peut lancer et consulter un traitement", () => {
  assert.equal(allowsMessage({ type: "start" }, popup, runtime), true);
  for (const sender of [
    content,
    { ...popup, id: "other-extension" },
    { ...popup, url: runtime.getURL("privacy.html") },
    { ...popup, url: "https://x.com/popup.html" },
    {},
  ])
    assert.equal(allowsMessage({ type: "start" }, sender, runtime), false);
  assert.equal(allowsMessage({ type: "state" }, content, runtime), false);
  assert.equal(allowsMessage({ type: "checkUpdate" }, popup, runtime), true);
  assert.equal(allowsMessage({ type: "checkUpdate" }, content, runtime), false);
});
test("les résultats sont réservés au script principal du vrai site X", () => {
  assert.equal(allowsMessage({ type: "blockResult" }, content, runtime), true);
  assert.equal(
    allowsMessage(
      { type: "ready" },
      { ...content, url: "https://twitter.com/home" },
      runtime,
    ),
    true,
  );
  for (const change of [
    { url: "http://x.com/home" },
    { url: "https://x.com.evil.example/home" },
    { url: "https://evil.example/x.com/" },
    { url: "https://x.com@evil.example/" },
    { url: "https://attacker@x.com/" },
    { url: "https://x.com:8443/home" },
    { url: "not-a-url" },
    { frameId: 1 },
    { tab: {} },
    { id: "other-extension" },
  ])
    assert.equal(
      allowsMessage(
        { type: "blockResult" },
        { ...content, ...change },
        runtime,
      ),
      false,
    );
  assert.equal(allowsMessage({ type: "blockResult" }, popup, runtime), false);
  assert.equal(allowsMessage({ type: "unknown" }, content, runtime), false);
});
