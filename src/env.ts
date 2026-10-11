import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Resolve paths from the project root, not cwd: the MCP server is launched from wherever the client lives.
// WM_ROOT overrides it for bundlers (Next.js) where import.meta.url may not point at the source file.
export const ROOT = path.resolve(process.env.WM_ROOT ?? path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));

const envFile = path.join(ROOT, ".env");
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

export const MODEL = process.env.WM_MODEL ?? "claude-opus-5-5";
export const DATA_DIR = path.resolve(process.env.WM_DATA_DIR ?? path.join(ROOT, "data"));
export const SEEDS_DIR = path.join(ROOT, "seeds");
export const STORAGE: "sqlite" | "files" = process.env.STORAGE === "files" ? "files" : "sqlite";
export const DEBUG = process.env.WM_DEBUG === "1";

/** All diagnostics go to stderr so stdout stays clean for results (and for the MCP stdio transport). */
export function log(...args: unknown[]) {
  console.error(...args);
}

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set. Copy .env.example to .env and fill it in.`);
  return v;
}
