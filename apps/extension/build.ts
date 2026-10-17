/**
 * Build the browser extension for Chrome (and Chromium browsers) and Firefox
 * from one source: `dist/chrome/` and `dist/firefox/`, each loadable unpacked
 * (Chrome: chrome://extensions → Load unpacked; Firefox: about:debugging →
 * Load Temporary Add-on → manifest.json). The bundles are identical; only the
 * manifest differs, where the two browsers do (background service worker vs.
 * event-page scripts, and Firefox's add-on id).
 *
 * Paths are anchored to this file so the script works regardless of CWD.
 */
import pkg from "./package.json";

const SRC = `${import.meta.dir}/src`;
const DIST = `${import.meta.dir}/dist`;

/** One target browser's manifest differences. */
type Browser = "chrome" | "firefox";

/** The parts both browsers share (Manifest V3). */
function baseManifest() {
  return {
    manifest_version: 3,
    name: "Bunbooru",
    short_name: "Bunbooru",
    version: pkg.version,
    description: "Right-click any image to upload it to your Bunbooru.",
    icons: { "16": "icons/icon-16.png", "32": "icons/icon-32.png", "48": "icons/icon-48.png", "128": "icons/icon-128.png" },
    action: { default_title: "Bunbooru", default_popup: "popup.html", default_icon: { "16": "icons/icon-16.png", "32": "icons/icon-32.png" } },
    options_ui: { page: "options.html", open_in_tab: true },
    // contextMenus: the right-click entries. scripting + activeTab: read the
    // image list of the page the user invoked us on (no standing access to
    // any page). notifications: report the result. storage: settings.
    permissions: ["contextMenus", "activeTab", "scripting", "notifications", "storage"],
    // Requested at runtime from the options page: the user's server (needed to
    // reach it), and optionally every site (to fetch images with their cookies).
    optional_host_permissions: ["<all_urls>"],
  };
}

function manifestFor(browser: Browser) {
  if (browser === "chrome") {
    return { ...baseManifest(), background: { service_worker: "background.js" } };
  }
  return {
    ...baseManifest(),
    background: { scripts: ["background.js"] },
    browser_specific_settings: { gecko: { id: "extension@bunbooru.app", strict_min_version: "128.0" } },
  };
}

/** Build into `dist/<browser>/`. Throws with the bundler's messages on failure. */
export async function buildExtension(): Promise<string[]> {
  await Bun.$`rm -rf ${DIST}`;
  const out = `${DIST}/chrome`;
  const result = await Bun.build({
    entrypoints: [`${SRC}/background.ts`, `${SRC}/popup.html`, `${SRC}/options.html`],
    outdir: out,
    target: "browser",
    minify: true,
    // Stable names: the manifest points at background.js and the pages.
    naming: { entry: "[name].[ext]", chunk: "[name]-[hash].[ext]", asset: "[name]-[hash].[ext]" },
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
  });
  if (!result.success) {
    throw new Error(`Extension build failed:\n${result.logs.map((log) => `   ${log.message}`).join("\n")}`);
  }
  await Bun.$`cp -r ${SRC}/icons ${out}/icons`;
  await Bun.write(`${out}/manifest.json`, JSON.stringify(manifestFor("chrome"), null, 2));

  await Bun.$`cp -r ${out} ${DIST}/firefox`;
  await Bun.write(`${DIST}/firefox/manifest.json`, JSON.stringify(manifestFor("firefox"), null, 2));
  return [`${DIST}/chrome`, `${DIST}/firefox`];
}

if (import.meta.main) {
  console.log("🧩 Building the browser extension...");
  const dirs = await buildExtension();
  for (const dir of dirs) console.log(`✅ ${dir}`);
}
