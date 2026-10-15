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

/** The built SPA: its output directory and every file in it. */
export interface WebBuild {
  /** Absolute path of the output directory. */
  distDir: string;
  /** Output files relative to {@link WebBuild.distDir}, e.g. `index.html`, `chunk-x.js`. */
  files: string[];
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

  const files = result.outputs.map((output) => output.path.slice(distDir.length + 1)).sort();
  return { distDir, files };
}

if (import.meta.main) {
  console.log("🎨 Building web SPA...");
  const { distDir, files } = await buildWeb();
  console.log(`✅ Built ${files.length} files into ${distDir}`);
}
