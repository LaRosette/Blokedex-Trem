import { test } from "node:test";
import assert from "node:assert/strict";
import "../extension/filter-core.js";
import "../extension/profile-filter.js";
const route = globalThis.BlokedexProfiles.routeUsername;

test("reconnaît les vues de profil sans masquer les routes de navigation X", () => {
  for (const path of [
    "/CompteTest_A",
    "/CompteTest_A/",
    "/COMPTEtest_A/media",
    "/CompteTest_A/with_replies",
    "/CompteTest_A/highlights",
    "/CompteTest_A/articles/",
  ])
    assert.equal(route(path), "comptetest_a", path);
  for (const path of [
    "/home",
    "/search",
    "/i",
    "/settings",
    "/CompteTest_A/status/123",
    "/CompteTest_A/followers",
    "/CompteTest_A/other",
    "/CompteTest_AB/media/extra",
    "/%43ompteTest_A",
    "/CompteTest_A?x=1",
    "/CompteTest_A\n",
  ])
    assert.equal(route(path), null, path);
});
