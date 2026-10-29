import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_HISTORY_IDS,
  MAX_HISTORY_USERS,
  getKnown,
  normalizeHistory,
  remember,
} from "../extension/history.js";

const key = (number) => number.toString(16).padStart(64, "0");
const row = (number, updatedAt = number) => ({
  key: key(number),
  username: `Compte_${number}`,
  ids: [String(number)],
  updatedAt,
});

test("isole les comptes par clé, même si leur pseudo est identique", () => {
  const history = [row(1), { ...row(2), username: "Compte_1" }];
  assert.deepEqual([...getKnown(history, key(1))], ["1"]);
  assert.deepEqual([...getKnown(history, key(2))], ["2"]);
  assert.equal(getKnown(history, key(3)).size, 0);
  assert.equal(getKnown(history, "Compte_1").size, 0);
});

test("fusionne les identifiants en préservant les grands nombres en chaînes", () => {
  const history = [row(1)];
  const original = structuredClone(history);
  const updated = remember(history, {
    key: key(1),
    username: "NouveauPseudo",
    ids: ["2", "1", "1234567890123456789012345"],
    now: 20,
  });
  assert.deepEqual(updated, [
    {
      key: key(1),
      username: "NouveauPseudo",
      ids: ["2", "1", "1234567890123456789012345"],
      updatedAt: 20,
    },
  ]);
  assert.deepEqual(history, original);
  const known = getKnown(updated, key(1));
  known.add("999");
  assert.equal(updated[0].ids.includes("999"), false);
});

test("filtre les entrées malformées et retire les champs superflus", () => {
  const valid = {
    ...row(1),
    extra: "supprimé",
    ids: ["1", "1", 2, null, {}, "0", "01", "-1", "1e2", "3"],
  };
  assert.deepEqual(
    normalizeHistory([
      null,
      [],
      "faux",
      {},
      valid,
      { ...row(2), key: "bad" },
      { ...row(3), username: "<script>" },
      { ...row(4), ids: {} },
      { ...row(5), updatedAt: NaN },
      { ...row(6), updatedAt: Infinity },
      { ...row(7), updatedAt: -1 },
      { ...row(8), updatedAt: 1.2 },
    ]),
    [{ key: key(1), username: "Compte_1", ids: ["1", "3"], updatedAt: 1 }],
  );
  for (const invalid of [null, {}, "faux", undefined]) {
    assert.deepEqual(normalizeHistory(invalid), []);
    assert.deepEqual(remember([row(1)], invalid), [row(1)]);
  }
});

test("ignore les propriétés héritées, les accesseurs et les clés de prototype", () => {
  let reads = 0;
  const inherited = Object.create(row(1));
  const accessor = { ...row(2) };
  Object.defineProperty(accessor, "key", {
    get() {
      reads++;
      return key(2);
    },
  });
  const ids = ["1"];
  Object.defineProperty(ids, "1", {
    enumerable: true,
    get() {
      reads++;
      return "2";
    },
  });
  const polluted = JSON.parse(
    JSON.stringify(row(3)).replace(
      '"updatedAt":3',
      '"updatedAt":3,"__proto__":{"polluted":true}',
    ),
  );
  const output = normalizeHistory([
    inherited,
    accessor,
    polluted,
    { ...row(4), ids },
  ]);
  assert.equal(reads, 0);
  assert.equal({}.polluted, undefined);
  assert.deepEqual(
    output.map((r) => r.key),
    [key(4), key(3)],
  );
  assert.deepEqual(output[0].ids, ["1"]);
  assert.equal(Object.hasOwn(output[1], "__proto__"), false);
  const nullPrototype = Object.assign(Object.create(null), row(5));
  assert.deepEqual(normalizeHistory([nullPrototype]), [row(5)]);
});

test("borne chaque compte aux 10 000 derniers identifiants uniques", () => {
  const ids = Array.from({ length: MAX_HISTORY_IDS + 5 }, (_, i) =>
    String(i + 1),
  );
  const normalized = normalizeHistory([{ ...row(1), ids }]);
  assert.equal(normalized[0].ids.length, MAX_HISTORY_IDS);
  assert.equal(normalized[0].ids[0], "6");
  const updated = remember(normalized, {
    key: key(1),
    username: "Compte_1",
    ids: ["6", "10006", "10006"],
    now: 2,
  });
  assert.equal(updated[0].ids.length, MAX_HISTORY_IDS);
  assert.equal(updated[0].ids.includes("7"), false);
  assert.deepEqual(updated[0].ids.slice(-2), ["6", "10006"]);
});

test("conserve cinq comptes récents et rafraîchit leur position LRU", () => {
  let history = Array.from({ length: MAX_HISTORY_USERS }, (_, i) => row(i + 1));
  history = remember(history, {
    key: key(1),
    username: "Compte_1",
    ids: ["10"],
    now: 10,
  });
  history = remember(history, {
    key: key(6),
    username: "Compte_6",
    ids: ["6"],
    now: 11,
  });
  assert.equal(history.length, MAX_HISTORY_USERS);
  assert.deepEqual(
    history.map((r) => r.key),
    [6, 1, 5, 4, 3].map(key),
  );
  assert.equal(getKnown(history, key(2)).size, 0);
  assert.deepEqual([...getKnown(history, key(1))], ["1", "10"]);
});

test("une clé répétée garde uniquement l’entrée la plus récente", () => {
  assert.deepEqual(
    normalizeHistory([
      { ...row(1, 1), ids: ["100"] },
      row(2, 2),
      { ...row(1, 3), ids: ["200"] },
    ]),
    [{ ...row(1, 3), ids: ["200"] }, row(2, 2)],
  );
});
