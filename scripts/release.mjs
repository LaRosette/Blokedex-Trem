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

Blokedex-Trem devient un filtre local pour le site web X. ${count} comptes figurent dans la liste incluse avec cette version.

- Activez le filtre depuis le popup : il est désactivé au premier lancement. Les publications reconnues sont masquées dans la page, y compris les citations et reposts dont le compte concerné peut être déterminé. Les simples mentions et liens dans le texte ne déclenchent pas le filtre.
- Aucun clic sur le site, aucune API X, aucun blocage, mise en sourdine ou signalement. Aucun onglet de travail n’est ouvert. Le réglage est local au navigateur et fonctionne quel que soit le compte X utilisé, sans l’identifier.
- Mettre en pause restaure les éléments masqués. Le compteur concerne la page actuelle, sans compter des publications uniques ni mesurer des impressions évitées. Le filtre ne promet aucun effet sur les recommandations de X et ne s’applique pas aux applications mobiles.
- La liste est incluse pour démarrer immédiatement, puis vérifiée toutes les six heures. En cas d’indisponibilité, le cache valide ou la copie incluse reste utilisé avec un avertissement. Les ajouts sont signalés par une pastille et s’appliquent automatiquement si le filtre est actif.
- La migration arrête les anciennes tâches de blocage et retire leur progression, leur historique local et les anciennes références du compte connecté. Les blocages déjà effectués sur X restent actifs : aucun déblocage automatique. Rechargez les pages X ouvertes après la mise à jour.
- Les identifiants de l’extension sont conservés. Le popup signale les nouvelles versions publiées ; les ZIP Chrome et Edge en mode développeur demandent de remplacer les fichiers puis de recharger l’extension. Le ZIP Firefox reste temporaire ; le canal permanent utilise un XPI signé Mozilla lorsqu’il est joint à la release.

Le [guide d’installation](https://github.com/LaRosette/Blokedex-Trem/blob/main/README.rst) précise les limites, la migration et les données réseau reçues par GitHub. Aucun historique de lecture ou contenu du fil n’est conservé par le filtre. Les empreintes des ZIP sont dans \`SHA256SUMS.txt\`.
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
