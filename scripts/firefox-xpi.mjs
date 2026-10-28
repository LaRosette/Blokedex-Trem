import assert from "node:assert/strict";
import { inflateRawSync } from "node:zlib";
import { FIREFOX_ID } from "./manifests.mjs";

// Les XPI de Mozilla ont des signatures et peuvent utiliser des descripteurs ZIP.
// Lecture en mémoire uniquement ; la confiance cryptographique est vérifiée ensuite
// par Firefox Release lui-même, jamais par la seule présence de META-INF.
export function inspectSignedXpi(bytes, expected) {
  assert.ok(
    bytes.length >= 22 && bytes.length <= 32 * 1024 * 1024,
    "Taille XPI incorrecte",
  );
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--)
    if (
      bytes.readUInt32LE(i) === 0x06054b50 &&
      i + 22 + bytes.readUInt16LE(i + 20) === bytes.length
    ) {
      end = i;
      break;
    }
  assert.ok(end >= 0, "XPI invalide");
  const count = bytes.readUInt16LE(end + 10);
  assert.ok(count > 0 && count <= 512, "Nombre de fichiers XPI incorrect");
  const files = new Map();
  let offset = bytes.readUInt32LE(end + 16),
    total = 0;
  for (let i = 0; i < count; i++) {
    assert.ok(
      offset + 46 <= end && bytes.readUInt32LE(offset) === 0x02014b50,
      "Index XPI invalide",
    );
    const flags = bytes.readUInt16LE(offset + 8),
      method = bytes.readUInt16LE(offset + 10);
    const packedSize = bytes.readUInt32LE(offset + 20),
      size = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28),
      local = bytes.readUInt32LE(offset + 42);
    const next =
      offset +
      46 +
      nameLength +
      bytes.readUInt16LE(offset + 30) +
      bytes.readUInt16LE(offset + 32);
    assert.ok(
      next <= end && local + 30 <= bytes.length,
      "Position XPI invalide",
    );
    const name = bytes
      .subarray(offset + 46, offset + 46 + nameLength)
      .toString("utf8");
    assert.ok(
      name &&
        !name.startsWith("/") &&
        !/[\\\x00-\x1f]/.test(name) &&
        !name.split("/").some((p) => p === ".." || p === "."),
      "Chemin XPI interdit",
    );
    assert.ok(
      !(flags & 1) && [0, 8].includes(method) && size <= 2 * 1024 * 1024,
      "Compression XPI invalide",
    );
    assert.ok(
      ((bytes.readUInt32LE(offset + 38) >>> 16) & 0xf000) !== 0xa000,
      "Lien XPI interdit",
    );
    assert.equal(bytes.readUInt32LE(local), 0x04034b50, "En-tête XPI invalide");
    const localNameLength = bytes.readUInt16LE(local + 26);
    assert.equal(
      bytes.subarray(local + 30, local + 30 + localNameLength).toString("utf8"),
      name,
      "Noms XPI incohérents",
    );
    const start = local + 30 + localNameLength + bytes.readUInt16LE(local + 28);
    assert.ok(
      start + packedSize <= bytes.readUInt32LE(end + 16),
      "XPI tronqué",
    );
    total += size;
    assert.ok(total <= 32 * 1024 * 1024, "XPI trop volumineux");
    const packed = bytes.subarray(start, start + packedSize);
    const data =
      method === 0
        ? packed
        : inflateRawSync(packed, { maxOutputLength: 2 * 1024 * 1024 });
    assert.equal(data.length, size, "Taille de fichier XPI incorrecte");
    assert.ok(!files.has(name), "Fichier XPI en double");
    if (!name.endsWith("/")) files.set(name, data);
    offset = next;
  }
  assert.equal(offset, end, "Fin XPI incorrecte");
  const signatures = [...files.keys()].filter((name) =>
    name.startsWith("META-INF/"),
  );
  assert.ok(
    signatures.includes("META-INF/mozilla.rsa") ||
      (signatures.includes("META-INF/cose.sig") &&
        signatures.includes("META-INF/cose.manifest")),
    "XPI non signé : signature Mozilla absente",
  );
  assert.deepEqual(
    [...files.keys()].filter((name) => !name.startsWith("META-INF/")).sort(),
    [...expected.keys()].sort(),
    "Fichiers XPI différents du paquet testé",
  );
  for (const [name, data] of expected)
    assert.ok(data.equals(files.get(name)), "Source XPI modifiée : " + name);
  const manifest = JSON.parse(files.get("manifest.json").toString());
  assert.equal(
    manifest.browser_specific_settings?.gecko?.id,
    FIREFOX_ID,
    "Identifiant Firefox incorrect",
  );
  return manifest;
}

export async function verifyWithFirefox(path) {
  const { Builder } = await import("selenium-webdriver");
  const { default: firefox } = await import("selenium-webdriver/firefox.js");
  const options = new firefox.Options()
    .setBrowserVersion("stable")
    .addArguments("-headless")
    .setPreference("xpinstall.signatures.required", true);
  if (process.env.FIREFOX_BINARY) options.setBinary(process.env.FIREFOX_BINARY);
  let driver;
  try {
    driver = await new Builder()
      .forBrowser("firefox")
      .setFirefoxOptions(options)
      .build();
    const installed = await driver.installWebExtension(path, {
      permanent: true,
    });
    assert.equal(
      installed.id,
      FIREFOX_ID,
      "Firefox n’a pas installé la bonne extension signée",
    );
  } finally {
    await driver?.quit();
  }
}
