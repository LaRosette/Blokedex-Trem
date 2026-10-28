import { readFile, writeFile } from "node:fs/promises";
import { validateList } from "../extension/core.js";

const root = new URL("../", import.meta.url);
const list = validateList(
  JSON.parse(await readFile(new URL("liste/accounts.json", root), "utf8")),
);
const accounts = [...list.accounts].sort((a, b) =>
  a.username.localeCompare(b.username, "en", { sensitivity: "base" }),
);
const start = ".. comptes:debut";
const end = ".. comptes:fin";
const columnCount = 5;
const rowCount = Math.ceil(accounts.length / columnCount);
const columns = Array.from({ length: columnCount }, (_, index) =>
  accounts.slice(index * rowCount, (index + 1) * rowCount),
);
const range = (column) => {
  if (!column.length) return "";
  const first = column[0].username[0].toUpperCase();
  const last = column.at(-1).username[0].toUpperCase();
  return first === last ? first : `${first} – ${last}`;
};
const row = (cells) =>
  cells
    .map((cell, index) => `${index === 0 ? "   * - " : "     - "}${cell}`)
    .join("\n");
const table = [
  start,
  "",
  `**${accounts.length} comptes** · liste ${list.version}`,
  "",
  "Ce tableau suit les comptes sélectionnés pour le filtre local. Aucun historique de lecture n’est collecté.",
  "",
  ".. list-table::",
  "   :header-rows: 1",
  "   :widths: 20 20 20 20 20",
  "",
  row(columns.map(range)),
  ...Array.from({ length: rowCount }, (_, index) =>
    row(
      columns.map((column) => {
        const account = column[index];
        return account
          ? "`@" +
              account.username +
              " <https://x.com/" +
              account.username +
              ">`_"
          : "";
      }),
    ),
  ),
  "",
  end,
].join("\n");
const path = new URL("README.rst", root);
const readme = await readFile(path, "utf8");
const first = readme.indexOf(start),
  last = readme.indexOf(end);
if (first < 0 || last < first)
  throw Error("Repères du tableau absents du README.");
const updated =
  readme.slice(0, first) + table + readme.slice(last + end.length);
if (process.argv.includes("--check")) {
  if (updated !== readme)
    throw Error("Le tableau doit être actualisé : npm run update:table");
} else {
  await writeFile(path, updated);
  console.log(`Tableau actualisé : ${accounts.length} comptes.`);
}
