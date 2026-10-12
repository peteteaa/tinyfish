import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Resolve paths from the project root, not cwd: the MCP server is launched from wherever the client lives.
// WM_ROOT overrides it for bundlers (Next.js) where import.meta.url may not point at the source file.
// On Vercel the build machine's path (baked into WM_ROOT at build time) doesn't exist at runtime, so use the first
// candidate that actually has seeds/ (traced into the function bundle by web/next.config.ts).
function findRoot(): string {
  const candidates = [
    process.env.WM_ROOT,
    path.join(path.dirname(fileURLToPath(import.meta.url)), ".."),
    process.cwd(),
    path.join(process.cwd(), ".."),
  ].filter((c): c is string => !!c);
  return path.resolve(candidates.find((c) => fs.existsSync(path.join(c, "seeds"))) ?? candidates[0]);
}
export const ROOT = findRoot();

const envFile = path.join(ROOT, ".env");
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

export const DATA_DIR = path.resolve(process.env.WM_DATA_DIR ?? path.join(ROOT, "data"));
export const SEEDS_DIR = path.join(ROOT, "seeds");
/** Postgres connection string (set by the Neon integration on Vercel). When present, storage defaults to Postgres. */
export const DATABASE_URL = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
export const STORAGE: "sqlite" | "files" | "postgres" =
  process.env.STORAGE === "files" || process.env.STORAGE === "sqlite" || process.env.STORAGE === "postgres"
    ? process.env.STORAGE
    : DATABASE_URL
      ? "postgres"
      : "sqlite";
export const DEBUG = process.env.WM_DEBUG === "1";
/** Where others get the code, for the "use this workflow elsewhere" instructions. */
export const REPO_URL = process.env.WM_REPO_URL ?? "https://github.com/peteteaa/tinyfish";

/** All diagnostics go to stderr so stdout stays clean for results (and for the MCP stdio transport). */
export function log(...args: unknown[]) {
  console.error(...args);
}

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set. Copy .env.example to .env and fill it in.`);
  return v;
}
