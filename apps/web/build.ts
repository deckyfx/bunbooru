/**
 * Production build for the web SPA — stage 1 of the fullstack binary.
 *
 * Bundles `src/index.html` (and everything it references: the React app,
 * Tailwind CSS, images) into static files under `dist/`. `apps/api/build.ts`
 * calls {@link buildWeb} and embeds exactly those files into its compiled
 * executable, so one binary on one port serves both the SPA and `/api/v1`.
 * Runnable on its own (`bun run build:web`) to inspect the output.
 *
 * Paths are anchored to this file so the script works regardless of CWD.
 */
import tailwind from "bun-plugin-tailwind";

/** One file the build emitted. */
export interface WebBuildFile {
  /** Path relative to {@link WebBuild.distDir}, e.g. `index.html`, `chunk-x.js`. */
  path: string;
  /**
   * Whether the file NAME carries its content hash, so its URL can never point at
   * different bytes and may be cached forever. Read from the bundler's own record,
   * not assumed from a naming convention: `index.html` has a hash but keeps a
   * stable name, and a future build option could give other outputs stable names.
   */
  hashedName: boolean;
}

/** The built SPA: its output directory and every file in it. */
export interface WebBuild {
  /** Absolute path of the output directory. */
  distDir: string;
  files: WebBuildFile[];
}

/** Build the SPA into `dist/`. Throws with the bundler's messages on failure. */
export async function buildWeb(): Promise<WebBuild> {
  const distDir = `${import.meta.dir}/dist`;

  // Start clean: content-hashed names change every build, so stale chunks would
  // otherwise pile up in dist/.
  await Bun.$`rm -rf ${distDir}`;

  const result = await Bun.build({
    entrypoints: [`${import.meta.dir}/src/index.html`],
    outdir: distDir,
    target: "browser",
    minify: true,
    // Code-split dynamic imports, so each plugin's lazy-loaded UI is its own
    // chunk, fetched only when shown, instead of riding in the main bundle.
    splitting: true,
    // Absolute asset URLs. The default is relative (`./chunk-x.js`), which breaks
    // every deep link: on `/posts/12` the browser would request
    // `/posts/chunk-x.js`, and the SPA fallback answers that with HTML.
    publicPath: "/",
    plugins: [tailwind],
    define: {
      "process.env.NODE_ENV": JSON.stringify("production"),
    },
  });

  if (!result.success) {
    const messages = result.logs.map((log) => `   ${log.message}`).join("\n");
    throw new Error(`Web build failed:\n${messages}`);
  }

  const files = result.outputs.map((output) => {
    const path = output.path.slice(distDir.length + 1);
    const name = path.slice(path.lastIndexOf("/") + 1);
    return { path, hashedName: output.hash !== null && name.includes(output.hash) };
  });
  files.push(...(await buildPwa(distDir)));
  return { distDir, files: files.sort((a, b) => a.path.localeCompare(b.path)) };
}

/** The PWA files copied verbatim to the site root (stable names the manifest and browsers ask for). */
const PWA_STATIC = ["manifest.webmanifest", "icon-192.png", "icon-512.png", "icon-maskable-512.png"];

/**
 * The PWA's root-level files, with stable (unhashed) names: `sw.js` must sit
 * at the root to control the whole site, and the manifest and its icons are
 * requested by fixed URL. Served revalidated, never cached forever.
 */
async function buildPwa(distDir: string): Promise<WebBuildFile[]> {
  const worker = await Bun.build({
    entrypoints: [`${import.meta.dir}/src/pwa/sw.ts`],
    outdir: distDir,
    naming: "sw.js",
    target: "browser",
    minify: true,
  });
  if (!worker.success) {
    const messages = worker.logs.map((log) => `   ${log.message}`).join("\n");
    throw new Error(`Service worker build failed:\n${messages}`);
  }
  for (const name of PWA_STATIC) {
    await Bun.write(`${distDir}/${name}`, Bun.file(`${import.meta.dir}/src/pwa/${name}`));
  }
  return ["sw.js", ...PWA_STATIC].map((path) => ({ path, hashedName: false }));
}

if (import.meta.main) {
  console.log("🎨 Building web SPA...");
  const { distDir, files } = await buildWeb();
  console.log(`✅ Built ${files.length} files into ${distDir}`);
}
