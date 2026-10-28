import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  writeFile,
  readFile,
  cp,
  symlink,
  rm,
} from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  packageDirectory,
  packageEntries,
  readPackageArchive,
} from "../scripts/package.mjs";

const scratch = resolve(
  fileURLToPath(new URL("../../../work/package-tests/", import.meta.url)),
);

async function fixture(t) {
  await mkdir(scratch, { recursive: true });
  const folder = await mkdtemp(join(scratch, "case-"));
  t.after(async () => {
    const inside = relative(scratch, resolve(folder));
    assert.ok(inside && !inside.startsWith("..") && !inside.includes(":"));
    await rm(folder, { recursive: true, force: true });
  });
  return folder;
}

async function archive(t) {
  const folder = await fixture(t);
  await writeFile(join(folder, "file.js"), "export const value = 1;\n");
  return packageDirectory(folder);
}

test("le paquet conserve exactement les fichiers autorisés", async (t) => {
  const folder = await fixture(t);
  await mkdir(join(folder, "icons"));
  await writeFile(join(folder, "manifest.json"), '{"version":"1.0.0"}\n');
  await writeFile(join(folder, "icons", "icon16.png"), Buffer.from([0, 1, 2]));
  const zip = await packageDirectory(folder);
  const files = readPackageArchive(zip);
  assert.deepEqual([...files.keys()], ["icons/icon16.png", "manifest.json"]);
  assert.equal(files.get("manifest.json").toString(), '{"version":"1.0.0"}\n');
  assert.deepEqual(files.get("icons/icon16.png"), Buffer.from([0, 1, 2]));
  assert.deepEqual(await packageDirectory(folder), zip);
});

for (const name of [".env", "private.pem", "nested/.env"]) {
  test(
    "un fichier inattendu est refusé avant publication : " + name,
    async (t) => {
      const folder = await fixture(t);
      if (name.startsWith("nested/")) await mkdir(join(folder, "nested"));
      await writeFile(join(folder, name), "exemple sans secret");
      await assert.rejects(packageDirectory(folder), /non autorisé/);
    },
  );
}

test("une jonction ou un lien de dossier n’est pas suivi", async (t) => {
  const folder = await fixture(t);
  const source = join(folder, "source"),
    outside = join(folder, "outside");
  await mkdir(source);
  await mkdir(outside);
  await writeFile(join(outside, "hidden.json"), "{}");
  await symlink(
    outside,
    join(source, "icons"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(packageDirectory(source), /Lien symbolique/);
});

test("un lien utilisé comme racine du paquet est refusé, même avec slash final", async (t) => {
  const folder = await fixture(t);
  const target = join(folder, "target"),
    link = join(folder, "link");
  await mkdir(target);
  await symlink(
    target,
    link,
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(
    packageEntries(pathToFileURL(link + "/")),
    /dossier réel/,
  );
});

test("un fichier trop volumineux est refusé", async (t) => {
  const folder = await fixture(t);
  await writeFile(
    join(folder, "large.json"),
    Buffer.alloc(2 * 1024 * 1024 + 1),
  );
  await assert.rejects(
    packageDirectory(folder),
    /Fichier de paquet non autorisé/,
  );
});

test("un nom local différent de l’index central est refusé", async (t) => {
  const zip = await archive(t);
  Buffer.from("evil.js").copy(zip, 30);
  assert.throws(() => readPackageArchive(zip), /Nom ou contenu ZIP incohérent/);
});

test("un chemin ZIP sortant du dossier est refusé", async (t) => {
  const zip = await archive(t);
  const central = zip.readUInt32LE(zip.length - 6);
  Buffer.from("../a.js").copy(zip, 30);
  Buffer.from("../a.js").copy(zip, central + 46);
  assert.throws(() => readPackageArchive(zip), /Chemin de paquet non autorisé/);
});

test("un contenu dont le CRC a changé est refusé", async (t) => {
  const zip = await archive(t);
  zip[30 + Buffer.byteLength("file.js")] ^= 1;
  assert.throws(() => readPackageArchive(zip), /Contenu ZIP corrompu/);
});

test("un CRC local différent de l’index central est refusé", async (t) => {
  const zip = await archive(t);
  zip.writeUInt32LE(0, 14);
  assert.throws(() => readPackageArchive(zip), /Métadonnées ZIP incohérentes/);
});

test("une entrée non référencée avant les fichiers est refusée", async (t) => {
  const original = await archive(t);
  const zip = Buffer.concat([Buffer.from([0]), original]);
  const end = zip.length - 22;
  const central = zip.readUInt32LE(end + 16) + 1;
  zip.writeUInt32LE(central, end + 16);
  zip.writeUInt32LE(1, central + 42);
  assert.throws(() => readPackageArchive(zip), /Position ZIP incorrecte/);
});

test("la construction refuse un dossier dist lié avant de supprimer ses cibles", async (t) => {
  const folder = await fixture(t);
  const project = join(folder, "project"),
    outside = join(folder, "outside");
  await mkdir(join(project, "scripts"), { recursive: true });
  await mkdir(join(project, "extension"));
  await mkdir(join(outside, "chrome"), { recursive: true });
  for (const name of ["build.mjs", "package.mjs", "manifests.mjs"])
    await cp(
      new URL("../scripts/" + name, import.meta.url),
      join(project, "scripts", name),
    );
  await writeFile(join(project, "package.json"), '{"type":"module"}');
  await writeFile(
    join(project, "extension", "config.js"),
    "export const CONFIG={listUrl:'https://example.invalid/list.json'};",
  );
  await writeFile(
    join(project, "extension", "core.js"),
    "export const readListResponse=()=>{};",
  );
  await writeFile(
    join(project, "extension", "manifest.json"),
    '{"version":"1.0.0"}',
  );
  const marker = join(outside, "chrome", "keep.js");
  await writeFile(marker, "do not remove");
  await symlink(
    outside,
    join(project, "dist"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const result = spawnSync(
    process.execPath,
    [
      join(project, "scripts", "build.mjs"),
      "--development",
      "--browser",
      "chrome",
    ],
    { encoding: "utf8" },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /dossier dist doit être un dossier réel/);
  assert.equal(await readFile(marker, "utf8"), "do not remove");
});
