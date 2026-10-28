import {
  cp,
  readFile,
  writeFile,
  mkdir,
  rm,
  lstat,
  realpath,
} from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { relative } from "node:path";
import { createHash } from "node:crypto";
import { manifestFor } from "./manifests.mjs";
import { packageDirectory, packageEntries } from "./package.mjs";
import { CONFIG } from "../extension/config.js";
import { readListResponse } from "../extension/core.js";
const root = new URL("../", import.meta.url),
  source = new URL("extension/", root);
const targets = process.argv.includes("--browser")
  ? [process.argv[process.argv.indexOf("--browser") + 1]]
  : ["chrome", "edge", "firefox"];
if (!CONFIG.listUrl) throw Error("Adresse de la liste manquante.");
if (!process.argv.includes("--development")) {
  const list = await readListResponse(
    await fetch(CONFIG.listUrl, {
      redirect: "error",
      signal: AbortSignal.timeout(20000),
    }),
  );
  if (!list.accounts.length) throw Error("La liste distante est vide.");
}
const manifest = JSON.parse(
  await readFile(new URL("manifest.json", source), "utf8"),
);
await packageEntries(source);
const dist = new URL("dist/", root);
await mkdir(dist, { recursive: true });
const distInfo = await lstat(fileURLToPath(dist).replace(/[\\/]$/, ""));
const distReal = await realpath(dist);
if (
  distInfo.isSymbolicLink() ||
  !distInfo.isDirectory() ||
  relative(await realpath(root), distReal) !== "dist"
)
  throw Error("Le dossier dist doit être un dossier réel du projet.");
for (const target of targets) {
  const adapted = manifestFor(manifest, target),
    folder = new URL("dist/" + target + "/", root);
  const insideDist = relative(
    fileURLToPath(new URL("dist/", root)),
    fileURLToPath(folder),
  );
  if (insideDist !== target || !["chrome", "edge", "firefox"].includes(target))
    throw Error("Dossier de paquet incorrect.");
  try {
    const info = await lstat(fileURLToPath(folder).replace(/[\\/]$/, ""));
    if (
      info.isSymbolicLink() ||
      !info.isDirectory() ||
      relative(distReal, await realpath(folder)) !== target
    )
      throw Error(
        "La cible de construction doit être un dossier réel : " + target,
      );
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await rm(folder, { recursive: true, force: true });
  await mkdir(folder, { recursive: true });
  await cp(source, folder, { recursive: true });
  await writeFile(
    new URL("manifest.json", folder),
    JSON.stringify(adapted, null, 2) + "\n",
  );
  const archive = await packageDirectory(folder),
    name = "extension-" + target + ".zip";
  await writeFile(new URL("dist/" + name, root), archive);
  await writeFile(
    new URL("dist/" + name + ".sha256", root),
    createHash("sha256").update(archive).digest("hex") + "  " + name + "\n",
  );
  console.log("Paquet créé : dist/" + name);
}
