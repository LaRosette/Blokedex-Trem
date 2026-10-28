import { readFile, writeFile, readdir, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve, join } from "node:path";
import assert from "node:assert/strict";
import { readPackageArchive } from "./package.mjs";
import { inspectSignedXpi, verifyWithFirefox } from "./firefox-xpi.mjs";

const issuer = process.env.AMO_JWT_ISSUER,
  secret = process.env.AMO_JWT_SECRET;
assert.ok(
  issuer && secret,
  "Configurer AMO_JWT_ISSUER et AMO_JWT_SECRET dans les secrets GitHub Actions. Ne pas les publier dans le dépôt.",
);
const original = await readFile("release/extension-firefox.zip");
const expected = readPackageArchive(original);
const source = resolve("firefox-source"),
  artifacts = resolve("firefox-signing"),
  output = resolve("signed-ready");
await mkdir(source, { recursive: true });
assert.equal(
  (await readdir(source)).length,
  0,
  "Le dossier de signature doit être neuf",
);
for (const [name, data] of expected) {
  const target = join(source, name);
  await mkdir(resolve(target, ".."), { recursive: true });
  await writeFile(target, data);
}
await mkdir(artifacts, { recursive: true });
assert.equal(
  (await readdir(artifacts)).length,
  0,
  "Le dossier des signatures doit être neuf",
);
const signed = spawnSync(
  process.execPath,
  [
    fileURLToPath(
      new URL("../node_modules/web-ext/bin/web-ext.js", import.meta.url),
    ),
    "sign",
    "--channel",
    "unlisted",
    "--source-dir",
    source,
    "--artifacts-dir",
    artifacts,
    "--approval-timeout",
    "900000",
  ],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      WEB_EXT_API_KEY: issuer,
      WEB_EXT_API_SECRET: secret,
    },
  },
);
assert.equal(
  signed.status,
  0,
  "La signature Mozilla n’a pas abouti. Aucun flux Firefox ne sera publié.",
);
const names = (await readdir(artifacts)).filter((name) =>
  name.endsWith(".xpi"),
);
assert.equal(names.length, 1, "Un seul XPI signé est attendu");
const path = join(artifacts, names[0]),
  bytes = await readFile(path);
const manifest = inspectSignedXpi(bytes, expected);
await verifyWithFirefox(path);
await mkdir(output, { recursive: true });
const name = "extension-firefox.xpi",
  digest = createHash("sha256").update(bytes).digest("hex");
await writeFile(join(output, name), bytes);
await writeFile(join(output, name + ".sha256"), digest + "  " + name + "\n");
await writeFile(
  join(output, "firefox-signature.json"),
  JSON.stringify(
    {
      schemaVersion: 1,
      version: manifest.version,
      sha256: digest,
      verifiedBy: "Firefox Release permanent installation",
    },
    null,
    2,
  ) + "\n",
);
console.log(
  "XPI signé, sources identiques et signature acceptée par Firefox Release.",
);
