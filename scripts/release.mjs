import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { manifestFor } from "./manifests.mjs";
import { packageEntries, readPackageArchive } from "./package.mjs";

const root = new URL("../", import.meta.url);
const source = new URL("extension/", root);
const manifest = JSON.parse(
  await readFile(new URL("manifest.json", source), "utf8"),
);
const project = JSON.parse(
  await readFile(new URL("package.json", root), "utf8"),
);
const version = manifest.version;
if (!/^\d+\.\d+\.\d+(?:\.\d+)?$/.test(version))
  throw Error("Version du manifeste incorrecte.");
assert.equal(
  project.version,
  version,
  "package.json et manifest.json doivent avoir la même version.",
);
const tag = "v" + version;
if (process.argv.includes("--tag")) {
  const requested = process.argv[process.argv.indexOf("--tag") + 1];
  assert.equal(
    requested,
    tag,
    "Le tag doit correspondre à la version du manifeste.",
  );
}

const expected = new Map(
  (await packageEntries(source)).map(({ name, data }) => [name, data]),
);
const prepared = [];
for (const browser of ["chrome", "edge", "firefox"]) {
  const name = "extension-" + browser + ".zip";
  const bytes = await readFile(new URL("dist/" + name, root));
  const entries = readPackageArchive(bytes);
  assert.deepEqual(
    [...entries.keys()].sort(),
    [...expected.keys()].sort(),
    name + " doit contenir uniquement les fichiers de l’extension.",
  );
  assert.deepEqual(
    JSON.parse(entries.get("manifest.json").toString("utf8")),
    manifestFor(manifest, browser),
    "Manifeste incorrect dans " + name,
  );
  for (const [path, data] of expected) {
    if (path !== "manifest.json")
      assert.ok(
        data.equals(entries.get(path)),
        name + " contient un fichier périmé : " + path,
      );
  }
  const digest = createHash("sha256").update(bytes).digest("hex");
  const checksum = digest + "  " + name + "\n";
  assert.equal(
    await readFile(new URL("dist/" + name + ".sha256", root), "utf8"),
    checksum,
    "Empreinte incorrecte pour " + name,
  );
  prepared.push({ name, bytes, checksum, digest });
}

const directory = "dist/releases/" + tag + "/";
const destination = new URL(directory, root);
await mkdir(destination, { recursive: true });
for (const asset of prepared) {
  await writeFile(new URL(asset.name, destination), asset.bytes);
  await writeFile(new URL(asset.name + ".sha256", destination), asset.checksum);
}
await writeFile(
  new URL("SHA256SUMS.txt", destination),
  prepared.map((asset) => asset.checksum).join(""),
);
const count = JSON.parse(
  await readFile(new URL("liste/accounts.json", root), "utf8"),
).accounts.length;
const notes = `# Blokedex-Trem ${tag}\n\n${count} comptes dans la liste de cette version.\n\n- Le projet devient Blokedex-Trem ; les identifiants de l’extension sont conservés.\n- Le popup signale les nouvelles versions publiées sur GitHub. La liste de comptes continue de se mettre à jour séparément.\n- Une pastille sur l’icône et un encart signalent les nouveaux comptes de la liste. Les profils déjà traités sont mémorisés localement pour le compte X utilisé : cette mémoire ne vérifie pas l’état actuel des blocages sur X.\n- Télécharger le ZIP de son navigateur, puis suivre le [guide d’installation](https://github.com/LaRosette/Blokedex-Trem/blob/main/README.rst). Les ZIP Chrome et Edge chargés en mode développeur demandent un remplacement des fichiers puis un rechargement pour mettre à jour le code.\n- Le ZIP Firefox est non signé et se charge temporairement. Le canal permanent utilise un XPI signé Mozilla lorsqu’il est joint à la release.\n\nLes empreintes des ZIP sont dans \`SHA256SUMS.txt\`. Les détails du canal signé et de la migration sont dans [Mises à jour](https://github.com/LaRosette/Blokedex-Trem/blob/main/README.rst).\n`;
await writeFile(new URL("NOTES.txt", destination), notes);
await writeFile(
  new URL("RELEASE.json", destination),
  JSON.stringify(
    {
      schemaVersion: 1,
      version,
      tag,
      assets: prepared.map((asset) => ({
        name: asset.name,
        sha256: asset.digest,
        bytes: asset.bytes.length,
      })),
    },
    null,
    2,
  ) + "\n",
);
await writeFile(
  new URL("dist/release.json", root),
  JSON.stringify(
    {
      version,
      tag,
      directory,
      assets: prepared.map((asset) => ({
        name: asset.name,
        sha256: asset.digest,
        bytes: asset.bytes.length,
      })),
    },
    null,
    2,
  ) + "\n",
);
console.log(`Release préparée : ${tag}, trois ZIP vérifiés dans ${directory}`);
