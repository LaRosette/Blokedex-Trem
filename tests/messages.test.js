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
const popupMessages = [
  { type: "state" },
  { type: "refresh" },
  { type: "setEnabled", enabled: true },
  { type: "setEnabled", enabled: false },
  { type: "acknowledge" },
  { type: "checkUpdate" },
  ...["start", "rescan", "cancel", "inspect", "forgetBlockHistory"].map(
    (type) => ({ type }),
  ),
];

test("les réglages et l'état sont réservés au popup exact de cette extension", () => {
  for (const message of popupMessages) {
    assert.equal(allowsMessage(message, popup, runtime), true, message.type);
    for (const sender of [
      content,
      { ...popup, id: "other-extension" },
      { ...popup, url: runtime.getURL("privacy.html") },
      { ...popup, url: runtime.getURL("popup.html?extra=1") },
      { ...popup, url: runtime.getURL("popup.html#extra") },
      { ...popup, url: "https://x.com/popup.html" },
      {},
      null,
      undefined,
    ])
      assert.equal(
        allowsMessage(message, sender, runtime),
        false,
        message.type,
      );
  }
});

test("le popup ne peut activer le filtre qu'avec un vrai booléen", () => {
  for (const enabled of [undefined, null, "true", "false", 0, 1, {}, []])
    assert.equal(
      allowsMessage({ type: "setEnabled", enabled }, popup, runtime),
      false,
    );
});

test("le script principal X peut demander la configuration ou mettre le filtre en pause", () => {
  for (const url of [
    "https://x.com/home",
    "https://twitter.com/un_profil/status/123",
  ])
    for (const type of ["filterConfig", "pauseFilter"])
      assert.equal(allowsMessage({ type }, { ...content, url }, runtime), true);
  for (const type of ["filterConfig", "pauseFilter"])
    assert.equal(allowsMessage({ type }, popup, runtime), false);
  for (const type of [
    "ready",
    "sessionResult",
    "blockResult",
    "navigateFailed",
  ]) {
    assert.equal(allowsMessage({ type }, content, runtime), true);
    assert.equal(allowsMessage({ type }, popup, runtime), false);
  }
  for (const type of ["abort", "applyFilter", "filterStats", "unknown"])
    for (const sender of [content, popup])
      assert.equal(allowsMessage({ type }, sender, runtime), false, type);
});

test("la configuration et la pause sont refusées aux sous-cadres et fausses origines X", () => {
  for (const change of [
    { url: "http://x.com/home" },
    { url: "https://x.com.evil.example/home" },
    { url: "https://evil.example/x.com/" },
    { url: "https://x.com@evil.example/" },
    { url: "https://attacker@x.com/" },
    { url: "https://x.com:8443/home" },
    { url: "https://www.x.com/" },
    { url: "not-a-url" },
    { url: undefined },
    { frameId: 1 },
    { frameId: undefined },
    { tab: {} },
    { tab: undefined },
    { tab: { id: "7" } },
    { id: "other-extension" },
  ])
    for (const type of ["filterConfig", "pauseFilter"])
      assert.equal(
        allowsMessage({ type }, { ...content, ...change }, runtime),
        false,
        type,
      );
});

test("les valeurs et types de messages inattendus sont refusés sans exception", () => {
  for (const value of [
    null,
    undefined,
    true,
    0,
    "state",
    [],
    {},
    { type: null },
    { type: "unknown" },
  ])
    for (const sender of [popup, content])
      assert.equal(allowsMessage(value, sender, runtime), false);
});
