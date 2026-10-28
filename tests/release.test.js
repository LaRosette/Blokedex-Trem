import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { packageDirectory, readPackageArchive } from "../scripts/package.mjs";
import {
  loadRelease,
  publishRelease,
  promoteMetadata,
} from "../scripts/publish-release.mjs";
import { inspectSignedXpi } from "../scripts/firefox-xpi.mjs";
import { FIREFOX_ID } from "../scripts/manifests.mjs";

const scratch = resolve(
  fileURLToPath(new URL("../../../work/release-tests/", import.meta.url)),
);
const context = {
  repo: "LaRosette/Blokedex-Trem",
  tag: "v2.4.0",
  commit: "a".repeat(40),
};
const hash = (value) => createHash("sha256").update(value).digest("hex");

async function fixture(t, signed = false) {
  await mkdir(scratch, { recursive: true });
  const folder = await mkdtemp(join(scratch, "case-"));
  t.after(async () => {
    const inside = relative(scratch, resolve(folder));
    assert.ok(inside && !inside.startsWith("..") && !inside.includes(":"));
    await rm(folder, { recursive: true, force: true });
  });
  const source = join(folder, "source");
  await mkdir(source);
  await writeFile(
    join(source, "manifest.json"),
    JSON.stringify({
      manifest_version: 3,
      name: "Test",
      version: "2.4.0",
      browser_specific_settings: { gecko: { id: FIREFOX_ID } },
    }),
  );
  const zip = await packageDirectory(source),
    assets = [];
  for (const browser of ["chrome", "edge", "firefox"]) {
    const name = "extension-" + browser + ".zip";
    await writeFile(join(folder, name), zip);
    await writeFile(
      join(folder, name + ".sha256"),
      hash(zip) + "  " + name + "\n",
    );
    assets.push({ name, sha256: hash(zip), bytes: zip.length });
  }
  await writeFile(
    join(folder, "SHA256SUMS.txt"),
    assets.map((asset) => asset.sha256 + "  " + asset.name + "\n").join(""),
  );
  await writeFile(
    join(folder, "RELEASE.json"),
    JSON.stringify({
      schemaVersion: 1,
      tag: context.tag,
      version: "2.4.0",
      assets,
    }),
  );
  await writeFile(
    join(folder, "NOTES.txt"),
    "Fixture de publication hors ligne",
  );
  if (signed) {
    // Simulation de l’artefact issu du job de signature, pas une vraie signature.
    // Le test ne remplace pas la validation native obligatoire dans signer_firefox.
    await mkdir(join(source, "META-INF"));
    await writeFile(join(source, "META-INF", "cose.css"), "fixture");
    await writeFile(join(source, "META-INF", "cosexxxxx.css"), "fixture");
    let encoded = (await packageDirectory(source)).toString("latin1");
    encoded = encoded
      .replaceAll("cose.css", "cose.sig")
      .replaceAll("cosexxxxx.css", "cose.manifest");
    const xpi = Buffer.from(encoded, "latin1");
    await writeFile(join(folder, "extension-firefox.xpi"), xpi);
    await writeFile(
      join(folder, "extension-firefox.xpi.sha256"),
      hash(xpi) + "  extension-firefox.xpi\n",
    );
    await writeFile(
      join(folder, "firefox-signature.json"),
      JSON.stringify({
        schemaVersion: 1,
        version: "2.4.0",
        sha256: hash(xpi),
        verifiedBy: "Firefox Release permanent installation",
      }),
    );
  }
  return { folder, zip, release: await loadRelease(folder) };
}

function fakeGitHub(release, options = {}) {
  const state = {
    calls: [],
    releases: [],
    trees: [],
    patches: [],
    refs: options.tagExists !== false,
    published: options.published || false,
  };
  const remote = () => ({
    id: 7,
    tag_name: context.tag,
    draft: options.draft ?? !state.published,
    prerelease: false,
    immutable: options.immutable ?? true,
    assets: release.files.map((name, index) => ({
      name,
      state: "uploaded",
      digest:
        options.badDigest && index === 0
          ? "sha256:wrong"
          : release.digests.get(name),
    })),
  });
  const gh = (args, input) => {
    state.calls.push(args);
    if (args[0] === "release") {
      if (args[1] === "create") state.releases = [remote()];
      if (args[1] === "edit") state.published = true;
      return "";
    }
    const endpoint = args[1],
      method = args[args.indexOf("--method") + 1];
    const body = input ? JSON.parse(input) : undefined;
    let value;
    if (endpoint.includes("/releases?"))
      value = [options.existing ? [{ tag_name: context.tag }] : state.releases];
    else if (endpoint.includes("/git/matching-refs/"))
      value = state.refs ? [{ ref: "refs/tags/" + context.tag }] : [];
    else if (endpoint.endsWith("/git/refs") && method === "POST") {
      state.refs = true;
      value = {};
    } else if (endpoint.includes("/commits/tags/"))
      value = { sha: options.wrongTag ? "b".repeat(40) : context.commit };
    else if (endpoint.includes("/releases/")) value = remote();
    else if (endpoint.includes("/git/ref/heads/main"))
      value = {
        object: { sha: state.patches.length ? "c".repeat(40) : "d".repeat(40) },
      };
    else if (endpoint.includes("/contents/updates/latest.json"))
      value = {
        content: Buffer.from(
          JSON.stringify({
            schemaVersion: 1,
            version: options.latest || "2.3.1",
          }),
        ).toString("base64"),
      };
    else if (endpoint.includes("/git/commits/") && method === "GET")
      value = { tree: { sha: "old-tree" } };
    else if (endpoint.endsWith("/git/trees")) {
      state.trees.push(body);
      value = { sha: "new-tree" };
    } else if (endpoint.endsWith("/git/commits"))
      value = { sha: "e".repeat(40) };
    else if (endpoint.endsWith("/git/refs/heads/main")) {
      state.patches.push(body);
      if (options.conflict && state.patches.length === 1)
        throw Error("Conflit simulé");
      value = {};
    } else throw Error("Appel GitHub inattendu : " + args.join(" "));
    return JSON.stringify(value);
  };
  return { gh, state };
}

test("un ZIP non signé est refusé comme XPI", async (t) => {
  const { zip } = await fixture(t);
  assert.throws(
    () => inspectSignedXpi(zip, readPackageArchive(zip)),
    /non signé/,
  );
});
test("une fausse attestation ne transforme pas un ZIP non signé en XPI", async (t) => {
  const { folder, zip } = await fixture(t);
  await writeFile(join(folder, "extension-firefox.xpi"), zip);
  await writeFile(
    join(folder, "firefox-signature.json"),
    JSON.stringify({
      schemaVersion: 1,
      version: "2.4.0",
      sha256: hash(zip),
      verifiedBy: "Firefox Release permanent installation",
    }),
  );
  await assert.rejects(loadRelease(folder), /non signé/);
});
test("publie les ZIP dans un brouillon puis publie après contrôle des empreintes", async (t) => {
  const { release } = await fixture(t),
    { gh, state } = fakeGitHub(release, { tagExists: false });
  await publishRelease(release, context, gh);
  assert.ok(state.refs && state.published);
  const create = state.calls.find(
    (args) => args[0] === "release" && args[1] === "create",
  );
  assert.ok(create.includes("--draft") && create.includes("--verify-tag"));
  assert.ok(!create.some((arg) => arg.endsWith(".xpi")));
});
for (const [option, message] of [
  ["existing", /existe déjà/],
  ["wrongTag", /tag a changé/],
  ["badDigest", /Empreinte GitHub/],
]) {
  test("refuse publication : " + option, async (t) => {
    const { release } = await fixture(t),
      { gh, state } = fakeGitHub(release, { [option]: true });
    await assert.rejects(publishRelease(release, context, gh), message);
    assert.equal(state.published, false);
  });
}
test("une release signée ajoute le XPI avant publication", async (t) => {
  const { release } = await fixture(t, true),
    { gh, state } = fakeGitHub(release);
  await publishRelease(release, context, gh);
  assert.ok(
    state.calls
      .find((args) => args[0] === "release" && args[1] === "create")
      .some((arg) => arg.endsWith("extension-firefox.xpi")),
  );
});
test("la promotion sans XPI ne touche jamais le flux Firefox", async (t) => {
  const { release } = await fixture(t),
    { gh, state } = fakeGitHub(release, { published: true });
  await promoteMetadata(release, context, gh);
  assert.deepEqual(
    state.trees[0].tree.map((file) => file.path),
    ["updates/latest.json"],
  );
  assert.deepEqual(JSON.parse(state.trees[0].tree[0].content), {
    schemaVersion: 1,
    version: "2.4.0",
  });
});
test("la promotion signée écrit les deux métadonnées dans un seul commit", async (t) => {
  const { release } = await fixture(t, true),
    { gh, state } = fakeGitHub(release, { published: true, conflict: true });
  await promoteMetadata(release, context, gh);
  assert.equal(state.trees[0].tree.length, 2);
  const update = JSON.parse(
    state.trees[0].tree.find((file) => file.path === "updates/firefox.json")
      .content,
  ).addons[FIREFOX_ID].updates[0];
  assert.equal(update.update_hash, "sha256:" + release.signed.sha256);
  assert.equal(
    update.update_link,
    "https://github.com/LaRosette/Blokedex-Trem/releases/download/v2.4.0/extension-firefox.xpi",
  );
  assert.equal(state.patches.length, 2);
  assert.ok(state.patches.every((patch) => patch.force === false));
});
for (const options of [
  { draft: true },
  { immutable: false },
  { badDigest: true },
  { latest: "2.5.0" },
]) {
  test(
    "aucune métadonnée publiée après contrôle refusé " +
      JSON.stringify(options),
    async (t) => {
      const { release } = await fixture(t),
        { gh, state } = fakeGitHub(release, { published: true, ...options });
      await assert.rejects(promoteMetadata(release, context, gh));
      assert.equal(state.trees.length, 0);
    },
  );
}
