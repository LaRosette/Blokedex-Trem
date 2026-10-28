import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { validateList, fingerprint } from "../extension/core.js";
const path = process.argv[2]
  ? resolve(process.argv[2])
  : new URL("../liste/accounts.json", import.meta.url);
const list = validateList(JSON.parse(await readFile(path, "utf8")));
console.log(
  `${list.accounts.length} comptes valides · version ${list.version} · SHA-256 ${await fingerprint(list)}`,
);
