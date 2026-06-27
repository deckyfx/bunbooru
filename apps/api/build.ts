/**
 * Production build for the Bunbooru backend engine.
 *
 * Compiles `apps/api` (and its bundled workspace packages) into a single
 * standalone executable with no external runtime dependencies. Used by the
 * Docker build stage; also runnable locally via `bun run build:api`.
 *
 * Paths are anchored to this file so the script works regardless of CWD.
 */
const entrypoint = `${import.meta.dir}/src/index.ts`;
const outfile = `${import.meta.dir}/dist/bunbooru`;

console.log("📦 Building Bunbooru backend engine...");

const result = await Bun.build({
  entrypoints: [entrypoint],
  compile: { outfile },
  target: "bun",
  minify: true,
  sourcemap: "none",
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
