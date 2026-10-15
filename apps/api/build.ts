/**
 * Production build: the whole of Bunbooru as ONE standalone executable.
 *
 * Three stages:
 * 1. Embed migrations, so the binary carries SQL that matches the current
 *    drizzle/ folders (a compiled binary has no drizzle/ on disk; see
 *    BUN_DATABASE.md). Fails on journal/folder drift.
 * 2. Build the web SPA (`apps/web/build.ts`) into static files.
 * 3. Compile `apps/api` with every one of those files embedded, so the binary
 *    serves the SPA and `/api/v1` from one port. The two apps stay separate
 *    projects: the API never imports web source, only embeds its build output.
 *
 * Used by the Docker build stage; also runnable locally via `bun run build`.
 * Paths are anchored to this file so the script works regardless of CWD.
 */
import { $, type BunPlugin } from "bun";

import { buildWeb, type WebBuild } from "../web/build";

const entrypoint = `${import.meta.dir}/src/index.ts`;
const outfile = `${import.meta.dir}/dist/bunbooru`;
/** The source stub (an empty asset list) that stage 3 swaps for the real manifest. */
const embeddedAssetsModule = `${import.meta.dir}/src/web/embedded-assets.ts`;

/**
 * Generated replacement for `src/web/embedded-assets.ts`. Each `with { type:
 * "file" }` import makes the compiler embed that file and resolve the binding to
 * its `/$bunfs/…` path, which `Bun.file` can open inside the executable.
 */
function renderAssetManifest({ distDir, files }: WebBuild): string {
  const imports = files.map(
    ({ path }, i) =>
      `import asset${i} from ${JSON.stringify(`${distDir}/${path}`)} with { type: "file" };`,
  );
  const entries = files.map(
    ({ path, hashedName }, i) =>
      `  { urlPath: ${JSON.stringify(`/${path}`)}, file: asset${i}, immutable: ${hashedName} },`,
  );
  return [
    ...imports,
    "",
    "export const WEB_ASSETS = [",
    ...entries,
    "];",
    "",
  ].join("\n");
}

/** Bundler plugin that serves the generated manifest in place of the stub module. */
function embedWebAssets(manifest: string): BunPlugin {
  return {
    name: "embed-web-assets",
    setup(build) {
      build.onLoad({ filter: new RegExp(`^${RegExp.escape(embeddedAssetsModule)}$`) }, () => ({
        contents: manifest,
        loader: "ts",
      }));
    },
  };
}

console.log("📝 Embedding migrations...");
await $`bun ${import.meta.dir}/../../scripts/embed-migrations.ts`;

console.log("🎨 Building web SPA...");
const web = await buildWeb();
if (!web.files.some((file) => file.path === "index.html")) {
  console.error(`❌ Web build produced no index.html in ${web.distDir}`);
  process.exit(1);
}
console.log(`   ${web.files.length} files`);

console.log("📦 Compiling Bunbooru (API + embedded SPA)...");
const result = await Bun.build({
  entrypoints: [entrypoint],
  compile: { outfile },
  target: "bun",
  minify: true,
  sourcemap: "none",
  plugins: [embedWebAssets(renderAssetManifest(web))],
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
});

if (!result.success) {
  console.error("❌ Build failed:");
  for (const log of result.logs) console.error(`   ${log.message}`);
  process.exit(1);
}

// result.outputs[0].size is 0 for compiled binaries — read the real size from disk.
const sizeMb = (Bun.file(outfile).size / 1024 / 1024).toFixed(1);
console.log(`✅ Built ${outfile} (${sizeMb} MB)`);
