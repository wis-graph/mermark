import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";

// The import fence (design §2.3): repo carries no ESLint, so this is enforced
// with a grep-based vitest check instead of a lint rule — it runs in the same
// `npm test` gate, so it has the same enforcement power as CI would give a
// lint rule. Two directions:
//   1. src/extensions/** may import ONLY "../api" (any relative depth) or a
//      bare (npm) specifier — never a mermark internal module directly.
//   2. src/api/** may import ONLY the whitelisted registry/core modules
//      (api → registries is the fixed dependency direction) — and, checked
//      separately, none of those registry/core modules may import api/ back
//      (no cycle).
// Honest limitation (also noted in the design doc): this is a test, not a
// physical barrier — sufficient for a single-owner repo, not for a hostile
// contributor.

const ROOT = resolve(__dirname, "..");
const SRC = join(ROOT, "src");
const EXTENSIONS_DIR = join(SRC, "extensions");
const API_DIR = join(SRC, "api");

const WHITELIST_ABS = [
  join(SRC, "markdown", "live-preview", "feature-registry"),
  join(SRC, "markdown", "live-preview", "core"),
  join(SRC, "shortcuts", "registry"),
  join(SRC, "shortcuts", "actions"),
  join(SRC, "settings", "registry"),
  join(SRC, "settings", "store"),
];

function walkTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walkTsFiles(p));
    else if (/\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

/** The single scanner regex for both fence directions (extensions→api and
 *  api→registries). Defined once so the two directions can never drift out
 *  of sync with each other — a fence whose two halves see different import
 *  shapes is a fence with a hole on one side.
 *  Matches three import shapes: `from "x"` / `export ... from "x"`, dynamic
 *  `import("x")`, and **bare side-effect imports** (`import "x";` with no
 *  binding) — the last is the idiom self-registering extension modules use
 *  (`import "../markdown/live-preview";`) and is exactly the shape a naive
 *  `from`/`import(`-only scanner misses, since it has neither. Anchored to
 *  line start (`^\s*import\s+`, `m` flag) so it only fires on an actual
 *  import statement, not incidental text containing the word "import". */
const IMPORT_SPECIFIER_RE = /(?:from\s+|import\s*\(|^\s*import\s+)["']([^"']+)["']/gm;

/** Every import/export specifier a file references. Pure query over source
 *  text — good enough for a fence test, not a full parser. */
function importSpecifiers(file: string): string[] {
  const src = readFileSync(file, "utf8");
  const specs: string[] = [];
  const re = new RegExp(IMPORT_SPECIFIER_RE);
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) specs.push(m[1]);
  return specs;
}

function isRelative(spec: string): boolean {
  return spec.startsWith(".");
}

/** Resolve a relative import specifier (no extension) from `file`'s directory
 *  to an absolute path with the extension stripped, so it can be compared
 *  against WHITELIST_ABS / API_DIR regardless of how deep the importer sits. */
function resolveSpec(file: string, spec: string): string {
  return resolve(dirname(file), spec).replace(/\.tsx?$/, "");
}

describe("api fence (design §2.3 / plan Stage C-1)", () => {
  it("src/extensions/** imports only \"../api\" (any depth) or bare npm packages", () => {
    const files = walkTsFiles(EXTENSIONS_DIR);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      for (const spec of importSpecifiers(file)) {
        if (!isRelative(spec)) continue; // npm package — allowed
        const resolved = resolveSpec(file, spec);
        expect(
          resolved === API_DIR || resolved.startsWith(API_DIR + "/"),
          `${file} imports "${spec}" (resolves to ${resolved}) — extensions may only import the api facade or npm packages`,
        ).toBe(true);
      }
    }
  });

  it("src/api/** imports only the whitelisted registry/core modules", () => {
    const files = walkTsFiles(API_DIR);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      for (const spec of importSpecifiers(file)) {
        if (!isRelative(spec)) continue; // npm package — allowed
        const resolved = resolveSpec(file, spec);
        expect(
          WHITELIST_ABS.includes(resolved),
          `${file} imports "${spec}" (resolves to ${resolved}) — not in the api whitelist`,
        ).toBe(true);
      }
    }
  });

  it("no whitelisted registry/core module imports back from src/api (no cycle)", () => {
    for (const modBase of WHITELIST_ABS) {
      const file = `${modBase}.ts`;
      try {
        statSync(file);
      } catch {
        continue; // module resolves via index.ts etc. — nothing to check here
      }
      for (const spec of importSpecifiers(file)) {
        if (!isRelative(spec)) continue;
        const resolved = resolveSpec(file, spec);
        expect(
          resolved === API_DIR || resolved.startsWith(API_DIR + "/"),
          `${file} imports "${spec}" from src/api — reverses the fixed api → registries dependency direction`,
        ).toBe(false);
      }
    }
  });

  it("the facade RE-EXPORTS (not wraps): registerBlockFeature from ../src/api is the same reference as feature-registry's", async () => {
    const api = await import("../src/api");
    const registry = await import("../src/markdown/live-preview/feature-registry");
    expect(api.registerBlockFeature).toBe(registry.registerBlockFeature);
    expect(api.registerInlineFeature).toBe(registry.registerInlineFeature);
    const shortcuts = await import("../src/shortcuts/registry");
    expect(api.registerCommand).toBe(shortcuts.registerCommand);
    const settingsRegistry = await import("../src/settings/registry");
    expect(api.registerSetting).toBe(settingsRegistry.registerSetting);
    const core = await import("../src/markdown/live-preview/core");
    expect(api.hide).toBe(core.hide);
    expect(api.fencedInfo).toBe(core.fencedInfo);
  });
});
