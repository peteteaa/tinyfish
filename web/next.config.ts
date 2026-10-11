import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Core code in ../src is imported through the `@core/*` alias (see tsconfig.json paths),
// e.g. `import { listWorkflows } from "@core/store.js"`. Core files use ".js" specifiers that
// point at .ts files; webpack's extensionAlias (below) resolves those to .ts.
// WM_ROOT is set below so src/env.ts resolves ROOT to the repo root when bundled.
process.env.WM_ROOT = repoRoot;

const nextConfig: NextConfig = {
  env: { WM_ROOT: repoRoot },
  outputFileTracingRoot: repoRoot,
  // Core code reads seeds/ at runtime (seeding the store, the compiler's example workflow); ship it with every function.
  outputFileTracingIncludes: { "/**": ["../seeds/**/*"] },
  turbopack: { root: repoRoot },
  // Turbopack has no extensionAlias, so ".js" specifiers in src/ do not resolve to .ts there.
  // The web scripts therefore run webpack (`next dev --webpack`, `next build --webpack`).
  webpack(config, { isServer }) {
    config.resolve.extensionAlias = { ".js": [".ts", ".tsx", ".js"], ".mjs": [".mts", ".mjs"] };
    if (isServer) {
      const prev = config.externals ?? [];
      // node:* builtins (node:sqlite, node:fs, ...) stay external; webpack would otherwise try to bundle them.
      config.externals = [...(Array.isArray(prev) ? prev : [prev]), ({ request }: { request?: string }, cb: (e?: Error | null, r?: string) => void) =>
        request?.startsWith("node:") ? cb(null, `node-commonjs ${request}`) : cb()];
    }
    return config;
  },
};

export default nextConfig;
