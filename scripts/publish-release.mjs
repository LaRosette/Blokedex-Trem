import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { readPackageArchive } from "./package.mjs";
import { inspectSignedXpi } from "./firefox-xpi.mjs";
import { FIREFOX_ID } from "./manifests.mjs";

const repository = "LaRosette/Blokedex-Trem";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const json = (value) => JSON.stringify(value, null, 2) + "\n";
const versionPattern = /^(?:0|[1-9]\d{0,4})(?:\.(?:0|[1-9]\d{0,4})){2,3}$/;
function validVersion(value) {
  assert.ok(
    typeof value === "string" &&
      versionPattern.test(value) &&
      value.split(".").every((part) => Number(part) <= 65535),
    "Version invalide",
  );
  return value;
}
function compare(a, b) {
  const av = validVersion(a).split(".").map(Number),
    bv = validVersion(b).split(".").map(Number);
  for (let i = 0; i < 4; i++)
    if ((av[i] || 0) !== (bv[i] || 0)) return (av[i] || 0) - (bv[i] || 0);
  return 0;
}
export function runGitHub(args, input) {
  const result = spawnSync("gh", args, {
    input,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  assert.equal(
    result.status,
    0,
    "GitHub a refusé l’opération : " +
      (result.stderr || result.error?.message || "erreur inconnue"),
  );
  return result.stdout;
}
function api(gh, endpoint, method = "GET", body) {
  const args = ["api", endpoint, "--method", method];
  if (body !== undefined) args.push("--input", "-");
  return JSON.parse(
    gh(args, body === undefined ? undefined : JSON.stringify(body)),
  );
}
export async function loadRelease(directory) {
  const description = JSON.parse(
    await readFile(join(directory, "RELEASE.json"), "utf8"),
  );
  assert.equal(description.schemaVersion, 1);
  validVersion(description.version);
  assert.equal(description.tag, "v" + description.version);
  assert.deepEqual(description.assets.map((asset) => asset.name).sort(), [
    "extension-chrome.zip",
    "extension-edge.zip",
    "extension-firefox.zip",
  ]);
  const assets = [];
  for (const item of description.assets) {
    const bytes = await readFile(join(directory, item.name));
    assert.equal(hash(bytes), item.sha256, "Empreinte ZIP incorrecte");
    assert.equal(bytes.length, item.bytes, "Taille ZIP incorrecte");
    const files = readPackageArchive(bytes);
    assert.equal(
      JSON.parse(files.get("manifest.json").toString()).version,
      description.version,
    );
    assert.equal(
      await readFile(join(directory, item.name + ".sha256"), "utf8"),
      item.sha256 + "  " + item.name + "\n",
    );
    assets.push(item.name, item.name + ".sha256");
  }
  assert.equal(
    await readFile(join(directory, "SHA256SUMS.txt"), "utf8"),
    description.assets
      .map((asset) => asset.sha256 + "  " + asset.name + "\n")
      .join(""),
  );
  assets.push("SHA256SUMS.txt");
  let signed;
  try {
    signed = JSON.parse(
      await readFile(join(directory, "firefox-signature.json"), "utf8"),
    );
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (signed) {
    assert.equal(signed.schemaVersion, 1);
    assert.equal(signed.version, description.version);
    assert.equal(signed.verifiedBy, "Firefox Release permanent installation");
    const bytes = await readFile(join(directory, "extension-firefox.xpi"));
    assert.equal(hash(bytes), signed.sha256, "Empreinte XPI incorrecte");
    const source = readPackageArchive(
      await readFile(join(directory, "extension-firefox.zip")),
    );
    inspectSignedXpi(bytes, source);
    assert.equal(
      await readFile(join(directory, "extension-firefox.xpi.sha256"), "utf8"),
      signed.sha256 + "  extension-firefox.xpi\n",
    );
    assets.push("extension-firefox.xpi", "extension-firefox.xpi.sha256");
  }
  const digests = new Map();
  for (const name of assets)
    digests.set(name, "sha256:" + hash(await readFile(join(directory, name))));
  return { ...description, directory, files: assets, digests, signed };
}
function assertContext(release, { repo, tag, commit }) {
  assert.equal(repo, repository, "Dépôt de publication incorrect");
  assert.equal(tag, release.tag, "Tag incorrect");
  assert.match(commit, /^[a-f0-9]{40}$/, "Commit incorrect");
}
function verifyAssets(release, remote) {
  assert.deepEqual(
    remote.assets.map((asset) => asset.name).sort(),
    [...release.files].sort(),
    "Fichiers GitHub incomplets ou inattendus",
  );
  for (const asset of remote.assets) {
    assert.equal(asset.state, "uploaded");
    assert.equal(
      asset.digest,
      release.digests.get(asset.name),
      "Empreinte GitHub incorrecte : " + asset.name,
    );
  }
}
function remoteReleases(gh) {
  const pages = JSON.parse(
    gh([
      "api",
      `repos/${repository}/releases?per_page=100`,
      "--paginate",
      "--slurp",
    ]),
  );
  return pages.flat();
}
export async function publishRelease(release, context, gh = runGitHub) {
  assertContext(release, context);
  assert.ok(
    !remoteReleases(gh).some((item) => item.tag_name === release.tag),
    "Cette release existe déjà",
  );
  const refs = api(
    gh,
    `repos/${repository}/git/matching-refs/tags/${release.tag}`,
  );
  if (!refs.some((ref) => ref.ref === "refs/tags/" + release.tag))
    api(gh, `repos/${repository}/git/refs`, "POST", {
      ref: "refs/tags/" + release.tag,
      sha: context.commit,
    });
  const checkTag = () =>
    assert.equal(
      api(gh, `repos/${repository}/commits/tags/${release.tag}`).sha,
      context.commit,
      "Le tag a changé",
    );
  checkTag();
  const finalNotes =
    (await readFile(join(release.directory, "NOTES.txt"), "utf8")) +
    (release.signed
      ? "\n## Firefox signé\n\nLe fichier `extension-firefox.xpi` joint a été signé par Mozilla et sa signature a été acceptée par Firefox Release. Il permet une installation permanente. Après la première installation du XPI signé, Firefox peut recevoir les mises à jour signées du flux de ce projet. Son empreinte finale est dans `extension-firefox.xpi.sha256`.\n"
      : "\nAucun XPI signé n’est joint à cette release. Le ZIP Firefox reste destiné au chargement temporaire ; cette publication ne crée pas de mise à jour permanente Firefox.\n");
  await writeFile(join(release.directory, "PUBLISHED_NOTES.txt"), finalNotes);
  gh([
    "release",
    "create",
    release.tag,
    ...release.files.map((name) => join(release.directory, name)),
    "--repo",
    repository,
    "--target",
    context.commit,
    "--title",
    release.tag,
    "--notes-file",
    join(release.directory, "PUBLISHED_NOTES.txt"),
    "--draft",
    "--verify-tag",
  ]);
  const draft = remoteReleases(gh).find(
    (item) => item.tag_name === release.tag,
  );
  assert.ok(draft?.draft, "Le brouillon attendu est absent");
  const uploaded = api(gh, `repos/${repository}/releases/${draft.id}`);
  verifyAssets(release, uploaded);
  checkTag();
  gh([
    "release",
    "edit",
    release.tag,
    "--repo",
    repository,
    "--draft=false",
    "--latest",
  ]);
}
export async function promoteMetadata(release, context, gh = runGitHub) {
  assertContext(release, context);
  const remote = api(gh, `repos/${repository}/releases/tags/${release.tag}`);
  assert.equal(remote.draft, false, "Release encore en brouillon");
  assert.equal(remote.prerelease, false, "Préversion non distribuée");
  assert.equal(remote.immutable, true, "La release publiée doit être immuable");
  verifyAssets(release, remote);
  assert.equal(
    api(gh, `repos/${repository}/commits/tags/${release.tag}`).sha,
    context.commit,
    "Tag incorrect",
  );
  for (let attempt = 0; attempt < 3; attempt++) {
    const head = api(gh, `repos/${repository}/git/ref/heads/main`).object.sha;
    const currentFile = api(
      gh,
      `repos/${repository}/contents/updates/latest.json?ref=${head}`,
    );
    const current = JSON.parse(
      Buffer.from(currentFile.content, "base64").toString(),
    );
    assert.ok(
      compare(current.version, release.version) <= 0,
      "Refus de rétrograder les métadonnées",
    );
    const files = {
      "updates/latest.json": json({
        schemaVersion: 1,
        version: release.version,
      }),
    };
    if (release.signed)
      files["updates/firefox.json"] = json({
        addons: {
          [FIREFOX_ID]: {
            updates: [
              {
                version: release.version,
                update_link: `https://github.com/${repository}/releases/download/${release.tag}/extension-firefox.xpi`,
                update_hash: "sha256:" + release.signed.sha256,
                applications: { gecko: { strict_min_version: "142.0" } },
              },
            ],
          },
        },
      });
    const base = api(gh, `repos/${repository}/git/commits/${head}`);
    const tree = api(gh, `repos/${repository}/git/trees`, "POST", {
      base_tree: base.tree.sha,
      tree: Object.entries(files).map(([path, content]) => ({
        path,
        mode: "100644",
        type: "blob",
        content,
      })),
    });
    if (tree.sha === base.tree.sha) return;
    const commit = api(gh, `repos/${repository}/git/commits`, "POST", {
      message: "Publication des mises à jour " + release.tag,
      tree: tree.sha,
      parents: [head],
    });
    try {
      api(gh, `repos/${repository}/git/refs/heads/main`, "PATCH", {
        sha: commit.sha,
        force: false,
      });
      return;
    } catch (error) {
      if (attempt === 2) throw error;
    }
  }
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const mode = process.argv[2],
    release = await loadRelease(resolve(process.argv[3] || "release"));
  const context = {
    repo: process.env.GITHUB_REPOSITORY,
    tag: process.env.RELEASE_TAG,
    commit: process.env.RELEASE_COMMIT,
  };
  if (mode === "publish") await publishRelease(release, context);
  else if (mode === "promote") await promoteMetadata(release, context);
  else throw Error("Mode attendu : publish ou promote");
  console.log(
    mode === "publish"
      ? "Release complète publiée."
      : "Métadonnées de mise à jour publiées.",
  );
}
