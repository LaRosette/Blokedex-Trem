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
const notes = `# Blokedex-Trem ${tag}

Deux onglets : masquer localement les contenus, ou bloquer les comptes sur votre propre session X. ${count} comptes dans la liste incluse.

- Popup plus lisible, largeur native corrigée, navigation au clavier entre les deux modes.
- Les posts masqués conservent leur hauteur : plus de rechargement en boucle provoqué par leur disparition.
- Les citations ciblées sont masquées sans retirer le commentaire d’un auteur non listé. Les mentions restent visibles.
- Suggestions, résultats de recherche et profils directs reconnus sont masqués ; la pause restaure l’affichage.
- Blocage volontaire dans un seul onglet réutilisé : contrôles du pseudo et de l’identifiant numérique, progression sauvegardée, historique local séparé par compte et effaçable. Aucun déblocage automatique.
- Le traitement s’arrête sur erreur ou changement d’identité. Une limite X impose quinze minutes d’attente, sans reprise automatique. Aucun contournement des protections de X.
- Le blocage par script de l’interface est interdit par les règles de X et peut entraîner une suspension. Il est facultatif ; le filtrage local reste indépendant. Aucun risque nul ou effet global sur la portée n’est promis.
- Le guide compare filtrage local, ignorance, mise en sourdine native et blocage, avec les coefficients du code public de X et leurs limites d’interprétation.
- Actualisez vos pages X après avoir rechargé l’extension. Les ZIP Chrome/Edge demandent une mise à jour manuelle ; le ZIP Firefox reste temporaire, sans XPI signé joint.

[Installation et fonctionnement](https://github.com/LaRosette/Blokedex-Trem/blob/main/README.rst). Les empreintes des trois ZIP figurent dans SHA256SUMS.txt.
`;

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
