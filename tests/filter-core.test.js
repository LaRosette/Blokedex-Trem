import { test } from "node:test";
import assert from "node:assert/strict";
import "../extension/filter-core.js";

const core = globalThis.BlokedexFilter;
const listed = new Set(["comptetest_a"]);
const header = (...links) => ({ links });

test("lit uniquement un profil HTTPS X exact, avec liens relatifs ou Twitter", () => {
  for (const url of [
    "/CompteTest_A",
    "/CompteTest_A/",
    "https://x.com/CompteTest_A",
    "https://twitter.com/CompteTest_A?s=1#profile",
  ]) {
    assert.equal(core.profileUsername(url), "comptetest_a", url);
  }
  assert.equal(
    core.profileUsername("/CompteTest_A", "https://twitter.com"),
    "comptetest_a",
  );
});

test("rejette hôtes trompeurs, credentials, ports, liens hors profil et navigation", () => {
  for (const url of [
    "http://x.com/CompteTest_A",
    "https://x.com.evil.test/CompteTest_A",
    "https://evil.test/CompteTest_A",
    "https://user@x.com/CompteTest_A",
    "https://@x.com/CompteTest_A",
    "https://x.com:443/CompteTest_A",
    "https://x.com:444/CompteTest_A",
    "//x.com/CompteTest_A",
    "javascript:alert(1)",
    "https://x.com/CompteTest_A/status/1",
    "/CompteTest_A/status/1",
    "/i",
    "/HOME",
    "/search?q=CompteTest_A",
    "/hashtag/CompteTest_A",
    "/%43ompteTest_A",
    "/@CompteTest_A",
    "/CompteTest_A bad",
    " /CompteTest_A",
    "/CompteTest_A\n",
    "https:\\x.com\\CompteTest_A",
    "/1234567890123456",
  ])
    assert.equal(core.profileUsername(url), null, url);
  assert.equal(
    core.profileUsername("/CompteTest_A", "https://evil.test"),
    null,
  );
});

test("ne confond pas pseudo exact, suffixe, préfixe et casse", () => {
  assert.equal(core.matchesArticle([header("/COMPTEtest_A")], listed), true);
  assert.equal(core.matchesArticle([header("/CompteTest_AB")], listed), false);
  assert.equal(core.matchesArticle([header("/xCompteTest_A")], listed), false);
  assert.equal(core.matchesArticle([header("/CompteTest")], listed), false);
});

test("ignore les mentions et un lien vers un statut, même si le texte est tentant", () => {
  assert.equal(
    core.matchesArticle(
      [
        {
          links: ["/AutreCompte", "/CompteTest_A/status/123"],
          text: "@CompteTest_A",
          body: "@CompteTest_A",
          handles: ["@CompteTest_A"],
        },
      ],
      listed,
    ),
    false,
  );
  assert.equal(
    core.matchesArticle([{ links: [], handles: ["@CompteTest_A"] }], listed),
    false,
  );
  assert.equal(
    core.matchesArticle([header("/AutreCompte?mention=@CompteTest_A")], listed),
    false,
  );
});

test("accepte les doublons nom et pseudo mais rend un en-tête ambigu visible", () => {
  assert.equal(
    core.matchesArticle(
      [header("/CompteTest_A", "/comptetest_a", "/CompteTest_A/status/3")],
      listed,
    ),
    true,
  );
  assert.equal(
    core.matchesArticle([header("/CompteTest_A", "/AutreCompte")], listed),
    false,
  );
  assert.equal(
    core.matchesArticle(
      [header("/CompteTest_A"), header("/AutreCompte", "/CompteTest_B")],
      listed,
    ),
    false,
  );
  assert.equal(
    core.matchesArticle(
      [header("/CompteTest_A"), header("/AutreCompte")],
      listed,
    ),
    false,
  );
});

test("une citation ciblée laisse son auteur principal visible", () => {
  assert.equal(
    core.matchesArticle(
      [header("/AutreCompte"), { ...header("/CompteTest_A"), quote: true }],
      listed,
    ),
    false,
  );
  assert.equal(
    core.matchesArticle(
      [
        header("/AutreCompte"),
        { links: [], quote: true, handles: ["@CompteTest_A", "@comptetest_a"] },
      ],
      listed,
    ),
    false,
  );
  assert.equal(
    core.matchesArticle(
      [
        header("/AutreCompte"),
        { links: [], quote: true, handles: ["@CompteTest_A", "@CompteTest_B"] },
      ],
      listed,
    ),
    false,
  );
  for (const handle of [
    "texte @CompteTest_A",
    "@CompteTest_AB",
    "@CompteTest_A texte",
    "@home",
    "<b>@CompteTest_A</b>",
  ]) {
    assert.equal(
      core.matchesArticle(
        [{ links: [], quote: true, handles: [handle] }],
        listed,
      ),
      false,
      handle,
    );
  }
});

test("le fallback citation ne remplace jamais un vrai lien auteur", () => {
  assert.equal(
    core.matchesArticle(
      [{ links: ["/AutreCompte"], quote: true, handles: ["@CompteTest_A"] }],
      listed,
    ),
    false,
  );
  assert.equal(
    core.matchesArticle(
      [
        {
          links: ["javascript:alert(1)"],
          quote: true,
          handles: ["@CompteTest_A"],
        },
      ],
      listed,
    ),
    false,
  );
});

test("valide intégralement les snapshots, borne et normalise la liste sans modifier l'entrée", () => {
  const input = {
    enabled: true,
    revision: 4,
    usernames: ["CompteTest_A", "comptetest_a", "AutreCompte"],
  };
  assert.deepEqual(core.normalizeSettings(input), {
    enabled: true,
    revision: 4,
    usernames: ["comptetest_a", "autrecompte"],
  });
  assert.equal(input.usernames.length, 3);
  assert.deepEqual(
    core.normalizeSettings({ enabled: false, revision: 0, usernames: [] }),
    { enabled: false, revision: 0, usernames: [] },
  );
  for (const input of [
    null,
    [],
    {},
    { enabled: "true", revision: 1, usernames: [] },
    { enabled: true, revision: -1, usernames: [] },
    { enabled: true, revision: 1.5, usernames: [] },
    { enabled: true, revision: Number.MAX_SAFE_INTEGER + 1, usernames: [] },
    { enabled: true, revision: 1, usernames: ["a", null] },
    { enabled: true, revision: 1, usernames: ["@CompteTest_A"] },
    { enabled: true, revision: 1, usernames: ["CompteTest_A\n"] },
    { enabled: true, revision: 1, usernames: ["home"] },
    { enabled: true, revision: 1, usernames: Array(10001).fill("a") },
  ])
    assert.equal(core.normalizeSettings(input), null);
});

test("normalisation sans résolution approximative ni traitement de propriétés spéciales", () => {
  assert.equal(core.username("__proto__"), "__proto__");
  assert.equal(core.username("constructor"), "constructor");
  assert.equal(
    core.matchesArticle([header("/__proto__")], new Set(["__proto__"])),
    true,
  );
  assert.equal(core.username(""), null);
  assert.equal(core.username("éxemple"), null);
  assert.equal(core.matchesArticle(null, listed), false);
});

test("le pseudo d’une citation native est reconnu séparément du post principal", () => {
  assert.deepEqual(
    core.headerUsername({
      links: [],
      quote: true,
      handles: ["@CompteTest_A", "@comptetest_a"],
    }),
    { ambiguous: false, username: "comptetest_a" },
  );
  assert.deepEqual(
    core.headerUsername({
      links: [],
      quote: true,
      handles: ["@CompteTest_A", "@AutreCompte"],
    }),
    { ambiguous: true, username: null },
  );
  assert.deepEqual(
    core.headerUsername({
      links: [],
      quote: false,
      handles: ["@CompteTest_A"],
    }),
    { ambiguous: false, username: null },
  );
});
