export const MAX_LIST_BYTES = 2_000_000;
export function validateList(value) {
  if (
    !value ||
    value.schemaVersion !== 1 ||
    typeof value.version !== "string" ||
    !value.version.trim() ||
    value.version.length > 100 ||
    !Array.isArray(value.accounts) ||
    value.accounts.length > 10000
  )
    throw new Error("Format de liste invalide.");
  const seen = new Set(),
    usernames = new Set();
  const accounts = value.accounts.map((a) => {
    if (
      !a ||
      typeof a.id !== "string" ||
      !/^[1-9]\d{0,24}$/.test(a.id) ||
      typeof a.username !== "string" ||
      !/^[A-Za-z0-9_]{1,15}$/.test(a.username) ||
      seen.has(a.id) ||
      usernames.has(a.username.toLowerCase())
    )
      throw new Error("Compte invalide ou identifiant en double.");
    seen.add(a.id);
    usernames.add(a.username.toLowerCase());
    return { id: a.id, username: a.username };
  });
  return { schemaVersion: 1, version: value.version, accounts };
}
export const base64url = (bytes) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
export async function fingerprint(value) {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(validateList(value))),
  );
  return base64url(new Uint8Array(hash));
}
export async function readListResponse(response) {
  if (!response.ok) throw new Error("Liste indisponible. Réessayez plus tard.");
  if (Number(response.headers.get("content-length")) > MAX_LIST_BYTES)
    throw new Error("Liste trop volumineuse.");
  const reader = response.body.getReader(),
    decoder = new TextDecoder();
  let text = "",
    length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_LIST_BYTES) throw new Error("Liste trop volumineuse.");
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    try {
      return validateList(JSON.parse(text));
    } catch {
      throw new Error("Le fichier de comptes est invalide.");
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
