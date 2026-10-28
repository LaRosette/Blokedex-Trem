export const FIREFOX_ID = "{c81fc17d-5e98-492d-9265-ddf2d0e672bd}";

export function manifestFor(source, browser) {
  const manifest = structuredClone(source);
  if (!["chrome", "edge", "firefox"].includes(browser)) {
    throw new Error(`Navigateur inconnu : ${browser}`);
  }
  if (browser === "firefox") {
    delete manifest.key;
    delete manifest.minimum_chrome_version;
    manifest.background = {
      scripts: ["background.js"],
      type: "module",
    };
    manifest.browser_specific_settings = {
      gecko: {
        id: FIREFOX_ID,
        update_url:
          "https://raw.githubusercontent.com/LaRosette/Blokedex-Trem/main/updates/firefox.json",
        strict_min_version: "142.0",
        data_collection_permissions: { required: ["none"] },
      },
    };
  }
  return manifest;
}
