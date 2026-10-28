import { test } from "node:test";
import assert from "node:assert/strict";
import { validateList, readListResponse } from "../extension/core.js";
test("préserve les grands identifiants et supprime les données supplémentaires", () => {
  assert.deepEqual(
    validateList({
      schemaVersion: 1,
      version: "1",
      accounts: [
        { id: "1234567890123456789", username: "exemple", script: "bad" },
      ],
    }).accounts,
    [{ id: "1234567890123456789", username: "exemple" }],
  );
});
test("refuse les identifiants numériques, doublons et injections", () => {
  for (const accounts of [
    [{ id: 123, username: "a" }],
    [
      { id: "1", username: "a" },
      { id: "1", username: "b" },
    ],
    [
      { id: "1", username: "Exemple" },
      { id: "2", username: "exemple" },
    ],
    [{ id: "1", username: "<script>" }],
  ])
    assert.throws(() =>
      validateList({ schemaVersion: 1, version: "1", accounts }),
    );
});
test("la limite en octets fonctionne aussi pour un flux sans taille déclarée", async () => {
  let cancelled = false;
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(2_000_001));
    },
    cancel() {
      cancelled = true;
    },
  });
  await assert.rejects(readListResponse(new Response(stream)), /volumineuse/);
  assert.equal(cancelled, true);
});
test("refuse une liste mal structurée et accepte une liste vide", () => {
  assert.throws(() => validateList({ accounts: [] }));
  assert.equal(
    validateList({ schemaVersion: 1, version: "1", accounts: [] }).accounts
      .length,
    0,
  );
});
test("rejette les gros fichiers avant leur chargement et les réponses non JSON", async () => {
  await assert.rejects(
    readListResponse(
      new Response("x", { headers: { "content-length": "9000000" } }),
    ),
    /volumineuse/,
  );
  await assert.rejects(readListResponse(new Response("not json")), /invalide/);
});
