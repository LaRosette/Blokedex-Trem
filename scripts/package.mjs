import { readdir, readFile, lstat } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";

const fileLimit = 2 * 1024 * 1024;
const packageLimit = 32 * 1024 * 1024;
const countLimit = 4096;
const extensions = new Set([".js", ".css", ".html", ".json", ".png"]);

function checkName(name, file = true) {
  if (
    name.length > 1024 ||
    name
      .split("/")
      .some((part) => !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(part)) ||
    (file && !extensions.has(extname(name).toLowerCase()))
  )
    throw Error("Chemin de paquet non autorisé : " + name);
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++)
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

async function entries(folder, prefix = "", limits = { count: 0, bytes: 0 }) {
  const result = [];
  const sorted = (await readdir(folder, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name, "en"),
  );
  for (const entry of sorted) {
    const name = prefix + entry.name;
    const path = join(folder, entry.name);
    const info = await lstat(path);
    if (info.isSymbolicLink())
      throw Error("Lien symbolique interdit dans le paquet : " + name);
    checkName(name, !info.isDirectory());
    if (info.isDirectory())
      result.push(...(await entries(path, prefix + entry.name + "/", limits)));
    else if (info.isFile() && info.size <= fileLimit) {
      limits.count++;
      limits.bytes += info.size;
      if (limits.count > countLimit || limits.bytes > packageLimit)
        throw Error("Le paquet dépasse la taille autorisée.");
      result.push({ name, data: await readFile(path) });
    } else throw Error("Fichier de paquet non autorisé : " + name);
  }
  return result;
}

export async function packageEntries(folder) {
  const path = resolve(folder instanceof URL ? fileURLToPath(folder) : folder);
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory())
    throw Error("Le dossier du paquet doit être un dossier réel.");
  const result = await entries(path);
  if (
    result.length > countLimit ||
    result.reduce((size, file) => size + file.data.length, 0) > packageLimit
  )
    throw Error("Le paquet dépasse la taille autorisée.");
  return result;
}

// Le lecteur n’extrait aucun fichier. Il vérifie les deux index et les CRC
// pour refuser une archive dont les lecteurs pourraient voir des contenus différents.
export function readPackageArchive(bytes) {
  if (bytes.length < 22 || bytes.length > packageLimit)
    throw Error("Taille ZIP incorrecte.");
  const end = bytes.length - 22;
  if (
    bytes.readUInt32LE(end) !== 0x06054b50 ||
    bytes.readUInt16LE(end + 4) !== 0 ||
    bytes.readUInt16LE(end + 6) !== 0 ||
    bytes.readUInt16LE(end + 20) !== 0
  )
    throw Error("Archive ZIP invalide.");
  const count = bytes.readUInt16LE(end + 10);
  const index = bytes.readUInt32LE(end + 16);
  if (
    count > countLimit ||
    bytes.readUInt16LE(end + 8) !== count ||
    index + bytes.readUInt32LE(end + 12) !== end
  )
    throw Error("Répertoire ZIP invalide.");
  let offset = index,
    localOffset = 0,
    total = 0;
  const result = new Map();
  for (let number = 0; number < count; number++) {
    if (offset + 46 > end || bytes.readUInt32LE(offset) !== 0x02014b50)
      throw Error("Entrée ZIP invalide.");
    const flags = bytes.readUInt16LE(offset + 8);
    const method = bytes.readUInt16LE(offset + 10);
    const crc = bytes.readUInt32LE(offset + 16);
    const packedSize = bytes.readUInt32LE(offset + 20);
    const size = bytes.readUInt32LE(offset + 24);
    const nameSize = bytes.readUInt16LE(offset + 28);
    const extraSize = bytes.readUInt16LE(offset + 30);
    const commentSize = bytes.readUInt16LE(offset + 32);
    const local = bytes.readUInt32LE(offset + 42);
    const next = offset + 46 + nameSize + extraSize + commentSize;
    if (next > end || local !== localOffset || local + 30 > index)
      throw Error("Position ZIP incorrecte.");
    const nameBytes = bytes.subarray(offset + 46, offset + 46 + nameSize);
    const name = nameBytes.toString("utf8");
    checkName(name);
    if (
      !Buffer.from(name).equals(nameBytes) ||
      result.has(name) ||
      flags !== 0x800 ||
      ![0, 8].includes(method) ||
      size > fileLimit ||
      bytes.readUInt16LE(offset + 34) !== 0 ||
      bytes.readUInt32LE(local) !== 0x04034b50 ||
      bytes.readUInt16LE(local + 6) !== flags ||
      bytes.readUInt16LE(local + 8) !== method ||
      bytes.readUInt32LE(local + 14) !== crc ||
      bytes.readUInt32LE(local + 18) !== packedSize ||
      bytes.readUInt32LE(local + 22) !== size ||
      bytes.readUInt16LE(local + 26) !== nameSize
    )
      throw Error("Métadonnées ZIP incohérentes : " + name);
    const start = local + 30 + nameSize + bytes.readUInt16LE(local + 28);
    if (
      start + packedSize > index ||
      !bytes.subarray(local + 30, local + 30 + nameSize).equals(nameBytes)
    )
      throw Error("Nom ou contenu ZIP incohérent : " + name);
    total += size;
    if (total > packageLimit) throw Error("Contenu ZIP trop volumineux.");
    const packed = bytes.subarray(start, start + packedSize);
    const data =
      method === 0
        ? packed
        : inflateRawSync(packed, { maxOutputLength: fileLimit });
    if (data.length !== size || crc32(data) !== crc)
      throw Error("Contenu ZIP corrompu : " + name);
    result.set(name, data);
    localOffset = start + packedSize;
    offset = next;
  }
  if (offset !== end || localOffset !== index)
    throw Error("Contenu ZIP non référencé.");
  return result;
}

// Paquets ZIP standards, sans dépendance ajoutée à l’extension.
export async function packageDirectory(folder) {
  const locals = [],
    central = [];
  let offset = 0;
  for (const file of await packageEntries(folder)) {
    const name = Buffer.from(file.name),
      crc = crc32(file.data),
      header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x800, 6);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(file.data.length, 18);
    header.writeUInt32LE(file.data.length, 22);
    header.writeUInt16LE(name.length, 26);
    locals.push(header, name, file.data);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50);
    directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(0x800, 8);
    directory.writeUInt32LE(crc, 16);
    directory.writeUInt32LE(file.data.length, 20);
    directory.writeUInt32LE(file.data.length, 24);
    directory.writeUInt16LE(name.length, 28);
    directory.writeUInt32LE(offset, 42);
    central.push(directory, name);
    offset += header.length + name.length + file.data.length;
  }
  const end = Buffer.alloc(22),
    index = Buffer.concat(central);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(central.length / 2, 8);
  end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(index.length, 12);
  end.writeUInt32LE(offset, 16);
  const archive = Buffer.concat([...locals, index, end]);
  if (archive.length > packageLimit)
    throw Error("Le paquet dépasse la taille autorisée.");
  return archive;
}
