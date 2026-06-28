/**
 * Architecture boundary rules (see CLAUDE.md / ARCHITECTURE.md).
 *
 * Allowed dependency direction (inward only):
 *   apps → plugins → plugin-sdk → core → db
 * with events/storage/search as leaf packages alongside db.
 *
 * Cross-package imports always use the `@bunbooru/<pkg>` specifier, so the rules
 * match on that specifier (robust regardless of TS/workspace resolution).
 *
 * @type {import('dependency-cruiser').IConfiguration}
 */
module.exports = {
  forbidden: [
    {
      name: "no-circular",
      comment: "No circular dependencies.",
      severity: "error",
      from: {},
      to: { circular: true },
    },
    {
      name: "plugins-only-plugin-sdk",
      comment:
        "Plugins may import ONLY @bunbooru/plugin-sdk (deny-by-default: any other @bunbooru/* package, including future ones, is rejected).",
      severity: "error",
      from: { path: "^plugins/" },
      to: { path: "^@bunbooru/", pathNot: "^@bunbooru/plugin-sdk$" },
    },
    {
      name: "db-is-leaf",
      comment: "db is a leaf: it must not import other workspace packages.",
      severity: "error",
      from: { path: "^packages/db/" },
      to: { path: "^@bunbooru/", pathNot: "^@bunbooru/db$" },
    },
    {
      name: "core-only-leaf-packages",
      comment:
        "core may import ONLY the leaf packages db/events/storage/search (deny-by-default: any other @bunbooru/* package, including future ones, is rejected).",
      severity: "error",
      from: { path: "^packages/core/" },
      to: { path: "^@bunbooru/", pathNot: "^@bunbooru/(db|events|storage|search)$" },
    },
    {
      name: "no-import-plugins",
      comment: "Library packages must never import a plugin.",
      severity: "error",
      from: { path: "^packages/" },
      to: { path: "^@bunbooru/plugin-(?!sdk$)" },
    },
    {
      name: "no-import-from-apps",
      comment: "Library packages and plugins must never import from an app.",
      severity: "error",
      from: { path: "^(packages|plugins)/" },
      to: { path: "^@bunbooru/(api|web|worker)$" },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsConfig: { fileName: "tsconfig.json" },
    tsPreCompilationDeps: true,
  },
};
