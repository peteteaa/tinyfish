// Enforces design doc 4.1: TinyFish is the only web layer.
// Static checker (pure functions) + self-tests + a scan of the real repo.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TINYFISH_FILE = "src/tinyfish.ts";
const SCAN_DIRS = ["src", "web", "cli"];
const EXTS = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs"]);
const SKIP_DIRS = new Set(["node_modules", ".next", "dist", "build"]);

export interface Violation {
  file: string;
  line: number;
  rule: string;
  snippet: string;
}

// ---------- banned lists ----------

const BANNED_PACKAGES = [
  "playwright", "playwright-core", "@playwright/*", "puppeteer", "puppeteer-core", "puppeteer-extra",
  "selenium-webdriver", "webdriverio", "cheerio", "jsdom", "linkedom", "happy-dom", "node-html-parser",
  "htmlparser2", "parse5", "@mozilla/readability", "axios", "got", "ky", "node-fetch", "cross-fetch",
  "undici", "superagent", "request", "needle", "crawlee", "@crawlee/*", "firecrawl",
  "@mendable/firecrawl-js", "@browserbasehq/*", "serpapi", "@tavily/*", "tavily", "exa-js", "@exa/*",
  "apify-client", "scrapingbee", "openai", "@google/generative-ai", "langchain", "@langchain/*", "ai",
  "@anthropic-ai/sdk",
];
// The only LLM SDK is @google/genai, used for reasoning only.

const NET_MODULES = ["http", "https", "net", "tls"];

export function isBannedPackage(spec: string): boolean {
  return BANNED_PACKAGES.some((b) =>
    b.endsWith("/*") ? spec.startsWith(b.slice(0, -1)) : spec === b || spec.startsWith(b + "/"),
  );
}

// ---------- lexing: blank comments, mask string contents ----------

const MASK = "\u0000";

/**
 * Returns `code` (comments blanked, strings intact) and `masked` (comments blanked,
 * string contents replaced by MASK). Both have the same length/offsets as the input.
 * Template literals are treated as plain strings (their `${}` parts are masked too).
 */
export function lex(src: string): { code: string; masked: string } {
  let code = "";
  let masked = "";
  let lastSig = ""; // last significant (non-space, non-comment) char, for regex detection
  const n = src.length;
  let i = 0;
  const blank = (c: string) => (c === "\n" || c === "\r" ? c : " ");
  while (i < n) {
    const c = src[i]!;
    const d = src[i + 1];
    if (c === "/" && d === "/") {
      while (i < n && src[i] !== "\n") { code += " "; masked += " "; i++; }
      continue;
    }
    if (c === "/" && d === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end === -1 ? n : end + 2;
      for (; i < stop; i++) { code += blank(src[i]!); masked += blank(src[i]!); }
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      code += c; masked += c; i++;
      while (i < n && src[i] !== c) {
        if (src[i] === "\\" && i + 1 < n) {
          code += src[i]! + src[i + 1]!; masked += MASK + MASK; i += 2; continue;
        }
        if (src[i] === "\n" && c !== "`") break; // unterminated
        code += src[i]!; masked += src[i] === "\n" ? "\n" : MASK; i++;
      }
      if (i < n && src[i] === c) { code += c; masked += c; i++; }
      lastSig = c;
      continue;
    }
    if (c === "/" && (lastSig === "" || "(,=:[!&|?{};+-*%<>~^".includes(lastSig))) {
      // regex literal
      let j = i + 1;
      let inClass = false;
      while (j < n && src[j] !== "\n") {
        if (src[j] === "\\") { j += 2; continue; }
        if (src[j] === "[") inClass = true;
        else if (src[j] === "]") inClass = false;
        else if (src[j] === "/" && !inClass) break;
        j++;
      }
      if (j < n && src[j] === "/") {
        j++;
        for (; i < j; i++) { code += src[i]!; masked += MASK; }
        lastSig = "/";
        continue;
      }
    }
    code += c; masked += c;
    if (!/\s/.test(c)) lastSig = c;
    i++;
  }
  return { code, masked };
}

function lineOf(text: string, idx: number): number {
  let l = 1;
  for (let i = 0; i < idx; i++) if (text.charCodeAt(i) === 10) l++;
  return l;
}

function snippetAt(lines: string[], line: number): string {
  return (lines[line - 1] ?? "").trim().slice(0, 160);
}

const ALLOW_RE = /\/\/\s*web-boundary:\s*(own-server|gemini)\b/;

function hasAllowComment(lines: string[], line: number): boolean {
  return ALLOW_RE.test(lines[line - 1] ?? "") || ALLOW_RE.test(lines[line - 2] ?? "");
}

// ---------- rules ----------

/** Rules 2 (imports), 3 (network), 4 (tinyfish URLs), 5 (LLM built-in web tools) for one file. */
export function checkSource(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  const lines = src.split(/\r?\n/);
  const { code, masked } = lex(src);
  const add = (idx: number, rule: string) => {
    const line = lineOf(src, idx);
    out.push({ file, line, rule, snippet: snippetAt(lines, line) });
  };
  const isTinyfish = file === TINYFISH_FILE;

  // Imports / requires
  const importRe = /\b(?:from|import|require)\s*\(?\s*(["'`])([^"'`\n]+)\1/g;
  for (let m: RegExpExecArray | null; (m = importRe.exec(code)); ) {
    if (masked[m.index] === MASK) continue; // keyword is inside a string/regex
    const spec = m[2]!;
    if (isBannedPackage(spec)) add(m.index, "banned-import");
    const bare = spec.replace(/^node:/, "");
    if (!isTinyfish && NET_MODULES.includes(bare.split("/")[0]!) && bare.split("/").length === 1) {
      if (!hasAllowComment(lines, lineOf(src, m.index))) add(m.index, "net-import-outside-tinyfish");
    }
  }

  // Network calls
  if (!isTinyfish) {
    const callPatterns: RegExp[] = [
      /(?<![\w$.])fetch\s*\(/g,
      /\b(?:globalThis|window|self)\s*\.\s*fetch\s*\(/g,
      /(?<![\w$.])(?:https?|net|tls)\s*\.\s*(?:request|get|connect|createConnection)\s*\(/g,
      /\bnew\s+WebSocket\s*\(/g,
      /\bnew\s+EventSource\s*\(/g,
    ];
    for (const re of callPatterns) {
      for (let m: RegExpExecArray | null; (m = re.exec(masked)); ) {
        const before = masked.slice(Math.max(0, m.index - 20), m.index);
        if (/\b(?:function|async|get|set)\s+$/.test(before)) continue; // declaration, not a call
        const line = lineOf(src, m.index);
        if (hasAllowComment(lines, line)) continue;
        const argStart = m.index + m[0].length;
        const arg = code.slice(argStart, argStart + 40).trimStart();
        if (/^["'`]\/(?!\/)/.test(arg)) continue; // same-origin path
        add(m.index, "network-call-outside-tinyfish");
      }
    }
  }

  // Hard-coded URLs in tinyfish.ts must be *.tinyfish.ai
  if (isTinyfish) {
    const urlRe = /https?:\/\/([^\s"'`\\/)?#]*)/gi;
    for (let m: RegExpExecArray | null; (m = urlRe.exec(code)); ) {
      if (masked[m.index] !== MASK) continue; // only inside strings
      const host = m[1]!.toLowerCase().replace(/:\d+$/, "");
      if (host.startsWith("$")) continue; // dynamic template host
      if (!/^(?:[a-z0-9-]+\.)*tinyfish\.ai$/.test(host)) add(m.index, "tinyfish-url-host");
    }
  }

  // Built-in LLM web tools (Gemini + Anthropic server-side); comments are ignored
  const toolRe = /web_search_\d{8}|web_fetch_\d{8}|\bcomputer_(?:20|toolset)|\b(?:googleSearchRetrieval|googleSearch|google_search|urlContext|url_context|computerUse|computer_use)\b/g;
  for (let m: RegExpExecArray | null; (m = toolRe.exec(code)); ) {
    add(m.index, "llm-builtin-web-tool");
  }

  return out;
}

export function checkPackageJson(file: string, text: string): Violation[] {
  const out: Violation[] = [];
  let pkg: Record<string, unknown>;
  try { pkg = JSON.parse(text); } catch { return [{ file, line: 1, rule: "package-json-parse", snippet: "invalid JSON" }]; }
  const lines = text.split(/\r?\n/);
  for (const key of ["dependencies", "devDependencies"]) {
    const deps = pkg[key];
    if (!deps || typeof deps !== "object") continue;
    for (const name of Object.keys(deps)) {
      if (isBannedPackage(name)) {
        const idx = lines.findIndex((l) => l.includes(JSON.stringify(name)));
        out.push({ file, line: idx + 1, rule: "banned-dependency", snippet: `${key}: ${name}` });
      }
    }
  }
  return out;
}

// ---------- repo walking ----------

function walk(dir: string, acc: string[] = []): string[] {
  if (!fs.existsSync(dir)) return acc;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.isDirectory()) {
      if (!SKIP_DIRS.has(ent.name)) walk(path.join(dir, ent.name), acc);
    } else if (ent.isFile() && EXTS.has(path.extname(ent.name))) {
      acc.push(path.join(dir, ent.name));
    }
  }
  return acc;
}

export function scanRepo(root: string): Violation[] {
  const out: Violation[] = [];
  for (const d of SCAN_DIRS) {
    for (const abs of walk(path.join(root, d))) {
      const rel = path.relative(root, abs).split(path.sep).join("/");
      out.push(...checkSource(rel, fs.readFileSync(abs, "utf8")));
    }
  }
  for (const p of ["package.json", "web/package.json", "cli/package.json"]) {
    const abs = path.join(root, p);
    if (fs.existsSync(abs)) out.push(...checkPackageJson(p, fs.readFileSync(abs, "utf8")));
  }
  return out;
}

const fmt = (vs: Violation[]) => vs.map((v) => `${v.file}:${v.line} ${v.rule}: ${v.snippet}`).join("\n");
const rules = (file: string, src: string) => checkSource(file, src).map((v) => v.rule);

// ---------- self-tests ----------

test("self: banned imports fire and do not false-positive", () => {
  assert.deepEqual(rules("src/a.ts", `import { chromium } from "playwright";`), ["banned-import"]);
  assert.deepEqual(rules("src/a.ts", `import x from "playwright/test";`), ["banned-import"]);
  assert.deepEqual(rules("src/a.ts", `import x from "@playwright/test";`), ["banned-import"]);
  assert.deepEqual(rules("src/a.ts", `const c = require("cheerio");`), ["banned-import"]);
  assert.deepEqual(rules("src/a.ts", `const p = await import("puppeteer-core");`), ["banned-import"]);
  assert.deepEqual(rules("src/a.ts", `import OpenAI from 'openai';`), ["banned-import"]);
  assert.deepEqual(rules("src/a.ts", `import "@crawlee/core";`), ["banned-import"]);
  assert.deepEqual(rules("src/a.ts", `import x from "playwright-ish";`), []);
  assert.deepEqual(rules("src/a.ts", `import x from "gotcha";`), []);
  assert.deepEqual(rules("src/a.ts", `import Anthropic from "@anthropic-ai/sdk";`), ["banned-import"]);
  assert.deepEqual(rules("src/a.ts", `import { GoogleGenAI } from "@google/genai";`), []);
  assert.deepEqual(rules("src/a.ts", `// import x from "playwright"`), []);
  assert.deepEqual(rules("src/a.ts", `const s = 'import x from "playwright"';`), []);
  // banned imports also apply in tinyfish.ts
  assert.deepEqual(rules(TINYFISH_FILE, `import axios from "axios";`), ["banned-import"]);
});

test("self: node net module imports", () => {
  assert.deepEqual(rules("src/a.ts", `import https from "node:https";`), ["net-import-outside-tinyfish"]);
  assert.deepEqual(rules("src/a.ts", `import { connect } from "tls";`), ["net-import-outside-tinyfish"]);
  assert.deepEqual(rules("src/a.ts", `import http from "node:http"; // web-boundary: own-server`), []);
  assert.deepEqual(rules("src/a.ts", `import path from "node:path";`), []);
  assert.deepEqual(rules("src/a.ts", `import x from "http-proxy-ish";`), []);
  assert.deepEqual(rules(TINYFISH_FILE, `import https from "node:https";`), []);
});

test("self: network calls", () => {
  assert.deepEqual(rules("web/a.ts", `await fetch("/api/workflows");`), []);
  assert.deepEqual(rules("web/a.ts", "await fetch(`/api/workflows/${id}`);"), []);
  assert.deepEqual(rules("web/a.ts", `await fetch("//evil.com/x");`), ["network-call-outside-tinyfish"]);
  assert.deepEqual(rules("web/a.ts", `await fetch("https://example.com");`), ["network-call-outside-tinyfish"]);
  assert.deepEqual(rules("web/a.ts", `await fetch(url);`), ["network-call-outside-tinyfish"]);
  assert.deepEqual(rules("web/a.ts", `await globalThis.fetch(url);`), ["network-call-outside-tinyfish"]);
  assert.deepEqual(rules("web/a.ts", `fetch(url) // web-boundary: own-server`), []);
  assert.deepEqual(rules("web/a.ts", `// web-boundary: gemini\nfetch(url)`), []);
  assert.deepEqual(rules("web/a.ts", `// web-boundary: gemini\n\nfetch(url)`), ["network-call-outside-tinyfish"]);
  assert.deepEqual(rules("web/a.ts", `// fetch(x)`), []);
  assert.deepEqual(rules("web/a.ts", `/* fetch(x)\n fetch(y) */`), []);
  assert.deepEqual(rules("web/a.ts", `const s = "call fetch(x) later";`), []);
  assert.deepEqual(rules("web/a.ts", `const r = /["']fetch(/; fetchPages(x); tf.fetch(x);`), []);
  assert.deepEqual(rules("src/a.ts", `function fetch(x) {}`), []);
  assert.deepEqual(rules("src/a.ts", `https.request(opts)`), ["network-call-outside-tinyfish"]);
  assert.deepEqual(rules("src/a.ts", `http.get(u)`), ["network-call-outside-tinyfish"]);
  assert.deepEqual(rules("src/a.ts", `net.connect(80)`), ["network-call-outside-tinyfish"]);
  assert.deepEqual(rules("src/a.ts", `net.createConnection(80)`), ["network-call-outside-tinyfish"]);
  assert.deepEqual(rules("src/a.ts", `tls.connect(443)`), ["network-call-outside-tinyfish"]);
  assert.deepEqual(rules("src/a.ts", `new WebSocket("wss://x")`), ["network-call-outside-tinyfish"]);
  assert.deepEqual(rules("src/a.ts", `new EventSource("/events")`), []);
  assert.deepEqual(rules("src/a.ts", `new EventSource(u)`), ["network-call-outside-tinyfish"]);
  // tinyfish.ts is the one place allowed to call out
  assert.deepEqual(rules(TINYFISH_FILE, `await fetch(url, { method: "POST" });`), []);
});

test("self: tinyfish.ts URL hosts", () => {
  assert.deepEqual(rules(TINYFISH_FILE, `const u = "https://example.com";`), ["tinyfish-url-host"]);
  assert.deepEqual(rules(TINYFISH_FILE, `const u = "https://tinyfish.ai.evil.com/x";`), ["tinyfish-url-host"]);
  assert.deepEqual(rules(TINYFISH_FILE, `const u = "https://api.search.tinyfish.ai";`), []);
  assert.deepEqual(rules(TINYFISH_FILE, `const u = "https://tinyfish.ai/x";`), []);
  assert.deepEqual(rules(TINYFISH_FILE, "const u = `https://${host}`;"), []);
  assert.deepEqual(rules(TINYFISH_FILE, `// see https://example.com\nconst r = /^https?:\\/\\//i;`), []);
  assert.deepEqual(rules("src/other.ts", `const u = "https://example.com";`), []);
});

test("self: gemini built-in web tools", () => {
  assert.deepEqual(rules("src/a.ts", `tools: [{ googleSearch: {} }]`), ["llm-builtin-web-tool"]);
  assert.deepEqual(rules("src/a.ts", `tools: [{ googleSearchRetrieval: {} }]`), ["llm-builtin-web-tool"]);
  assert.deepEqual(rules("src/a.ts", `tools: [{ google_search: {} }]`), ["llm-builtin-web-tool"]);
  assert.deepEqual(rules("src/a.ts", `tools: [{ urlContext: {} }]`), ["llm-builtin-web-tool"]);
  assert.deepEqual(rules("src/a.ts", `tools: [{ url_context: {} }]`), ["llm-builtin-web-tool"]);
  assert.deepEqual(rules("src/a.ts", `tools: [{ computerUse: {} }]`), ["llm-builtin-web-tool"]);
  assert.deepEqual(rules("src/a.ts", `tools: [{ functionDeclarations: [] }]`), []);
  assert.deepEqual(rules("src/a.ts", `// googleSearch is banned`), []);
  assert.deepEqual(rules("src/a.ts", `import { GoogleGenAI } from "@google/genai";`), []);
  assert.deepEqual(rules("src/a.ts", `import { GoogleGenerativeAI } from "@google/generative-ai";`), ["banned-import"]);
  assert.deepEqual(rules("src/a.ts", `import { generateText } from "ai";`), ["banned-import"]);
  assert.deepEqual(rules("src/a.ts", `import x from "@langchain/core";`), ["banned-import"]);
  assert.deepEqual(rules("src/a.ts", `import x from "aiohttp-ish";`), []);
  assert.deepEqual(rules("src/a.ts", `fetch(u) // web-boundary: gemini`), []);
});

test("self: anthropic server-side tools", () => {
  assert.deepEqual(rules("src/a.ts", `tools: [{ type: "web_search_20250305", name: "web_search" }]`), ["llm-builtin-web-tool"]);
  assert.deepEqual(rules("src/a.ts", `type: "web_fetch_20250910"`), ["llm-builtin-web-tool"]);
  assert.deepEqual(rules("src/a.ts", `type: "computer_20250124"`), ["llm-builtin-web-tool"]);
  assert.deepEqual(rules("src/a.ts", `type: "computer_toolset"`), ["llm-builtin-web-tool"]);
  assert.deepEqual(rules("src/a.ts", `// never use web_search_20250305`), []);
  assert.deepEqual(rules("src/a.ts", `const name = "web_search";`), []);
});

test("self: package.json dependencies", () => {
  const bad = JSON.stringify({ dependencies: { zod: "1", playwright: "1" }, devDependencies: { "@crawlee/core": "1" } }, null, 2);
  assert.deepEqual(checkPackageJson("package.json", bad).map((v) => v.snippet), [
    "dependencies: playwright",
    "devDependencies: @crawlee/core",
  ]);
  assert.deepEqual(checkPackageJson("package.json", JSON.stringify({ dependencies: { "@google/genai": "1", next: "1" } })), []);
});

// ---------- repo check ----------

test("repo: TinyFish is the only web layer (zero violations)", () => {
  const vs = scanRepo(ROOT);
  assert.equal(vs.length, 0, `web-boundary violations:\n${fmt(vs)}`);
});
