import { EditorView, WidgetType } from "@codemirror/view";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { recursiveImageSearchSetting } from "../settings/app";
import { attachAltClickEdit } from "./wikilink";
import { requestImageOpen } from "./image-open";
import { boundedCache } from "./bounded-cache";
import { imageSearchRoot, VAULT_IMAGE_SCAN_DEPTH } from "./image-search-root";

/** A literal target is a remote/data URL — it never gets the recursive-search
 *  fallback (the scan is a filesystem walk under baseDir; only local files can be
 *  rediscovered). Named so every caller (resolveImageSrc/resolveImageUrl below,
 *  the onerror handler, the click handler, and the image viewer) asks the SAME
 *  question instead of each re-testing its own regex — `resolveImageUrl` used
 *  to carry a variant (`/^https?:|^data:/i`, no `//` required) that had already
 *  drifted from this one; unifying onto a single test removes that drift
 *  without changing which URLs count as remote (both variants agree on every
 *  well-formed `http(s)://…`/`data:…` input; the variant only differed on
 *  malformed ones like a bare `https:` with no host, which isRemoteSrc also
 *  still matches). Pure query. */
export function isRemoteSrc(rawSrc: string): boolean {
  return /^https?:\/\//i.test(rawSrc) || rawSrc.startsWith("data:");
}

/** Resolve a markdown image target to an absolute filesystem path (or pass through URLs). */
export function resolveImageSrc(src: string, baseDir: string): string {
  if (isRemoteSrc(src)) return src;
  if (src.startsWith("/")) return src;
  return `${baseDir.replace(/\/$/, "")}/${src}`;
}

/** Same, but local paths become webview-loadable asset URLs. */
export function resolveImageUrl(src: string, baseDir: string): string {
  const abs = resolveImageSrc(src, baseDir);
  return isRemoteSrc(abs) ? abs : convertFileSrc(abs);
}

/** How far (in CSS pixels) the pointer may move between mousedown and click
 *  on the image and still count as a click, not a drag release. A drag that
 *  starts and ends ON the image never fires a native `click` in most cases,
 *  but a tiny in-place jitter still does — this guard's actual job is the
 *  in-place-drag case (dragging a selection that starts and ends on the
 *  image itself). Pure query. */
const CLICK_DRAG_SLOP_PX = 4;

/** Whether the pointer moved far enough between mousedown and click to call
 *  this a drag release rather than a click — the domain rule "the end of a
 *  drag is not a click" named once instead of as an inline distance check.
 *  Pure query. */
export function dragExceededClickSlop(downX: number, downY: number, e: MouseEvent): boolean {
  return Math.hypot(e.clientX - downX, e.clientY - downY) > CLICK_DRAG_SLOP_PX;
}

/** What clicking this widget should hand to the image viewer — pure query.
 *  `resolvedPath` (set once the recursive-search fallback in `onerror` found
 *  the real file) wins when present, so the viewer opens the SAME file the
 *  widget ended up showing, not the literal target that failed to load.
 *  Otherwise a remote/data `rawSrc` passes through untouched (never resolved
 *  against a `baseDir` it doesn't belong to), and a local path resolves to an
 *  absolute filesystem path the viewer can open. An empty `rawSrc` (the
 *  legacy no-arg constructor default) has nothing to open. */
export function viewerSourceFor(
  rawSrc: string,
  baseDir: string,
  resolvedPath: string | null,
): string | null {
  if (resolvedPath) return resolvedPath;
  if (!rawSrc) return null;
  if (isRemoteSrc(rawSrc)) return rawSrc;
  return resolveImageSrc(rawSrc, baseDir);
}

/** How the recursive-search fallback should run for one onerror firing — the
 *  ONE place that decides base directory / depth / whether the setting gates
 *  it, so `onerror` doesn't carry the branch inline (mermark-frontend §7).
 *
 *  `"vault"` scope (a `![[name]]` embed — wikilink.ts) with a resolved owning
 *  vault root (image-search-root.ts's `owningVaultRoot`, NOT the active
 *  vault) searches the whole vault: depth `VAULT_IMAGE_SCAN_DEPTH`, ungated —
 *  the setting only ever governed the OLD document-folder convenience
 *  fallback, and vault-wide name search is now `![[…]]`'s CONTRACTED
 *  meaning, not an opt-in nicety a setting should be able to silently break
 *  (design §분기1's SSOT-gate judgment). Every other case — `"folder"` scope
 *  (a standard `![](name)`), or `"vault"` scope with no owning root (global
 *  vault, or a document outside every registered vault) — keeps the
 *  pre-existing document-folder behavior: depth 3, gated by the setting.
 *  Pure query. */
function searchPlanFor(
  scope: "vault" | "folder",
  root: string | null,
  baseDir: string,
): { readonly baseDir: string; readonly maxDepth: number; readonly gated: boolean } {
  if (scope === "vault" && root !== null) return { baseDir: root, maxDepth: VAULT_IMAGE_SCAN_DEPTH, gated: false };
  return { baseDir, maxDepth: 3, gated: true };
}

/** Reports a `![[name]]` (vault-scope) embed's whole-vault search silently
 *  downgrading to the document-folder fallback because the document isn't
 *  inside any REGISTERED permanent vault (`imageSearchRoot()` returned
 *  `null` — CLI-opened files, or a folder never registered as a vault). Kept
 *  OUT of `searchPlanFor` (a pure query, CQS) — this is the one place the
 *  downgrade gets reported, so the rule stays testable/observable without
 *  splitting judgment across two functions (design 결함 B). Only a
 *  console.warn in production: no packaged-app UI channel exists for this
 *  yet, but the values it carries (target name, the document's baseDir, and
 *  the plan actually applied) are exactly what a dev/QA session needs to
 *  diagnose "vault syntax used, nothing found". Deduped per (baseDir, name)
 *  — a document with several unresolved embeds sharing a target, or repeated
 *  onerror retries of the same widget, would otherwise spam one warning per
 *  firing for a single underlying cause. Command, void. */
const reportedVaultDowngrades = new Set<string>();

/** Drop the vault-downgrade dedup memory — a test-only escape hatch, mirroring
 *  `clearImageSearchCache` above, for suites that reuse the same (baseDir,
 *  name) pair across cases expecting independent warning counts. Never
 *  called by the app itself. */
export function clearVaultDowngradeReports(): void {
  reportedVaultDowngrades.clear();
}

function reportVaultScopeDowngrade(
  rawSrc: string,
  baseDir: string,
  plan: { readonly baseDir: string; readonly maxDepth: number; readonly gated: boolean },
): void {
  const key = searchCacheKey(baseDir, rawSrc);
  if (reportedVaultDowngrades.has(key)) return;
  reportedVaultDowngrades.add(key);
  console.warn(
    `[mermark] ![[${rawSrc}]] wanted a vault-wide search but "${baseDir}" is not inside ` +
      `any registered vault, so it fell back to a document-folder scan ` +
      `(baseDir=${plan.baseDir}, maxDepth=${plan.maxDepth}, gated=${plan.gated}). ` +
      `Register the containing folder as a vault to restore vault-wide ![[…]] search.`,
  );
}

/** Dedupes concurrent `resolve_image` lookups for the SAME (search base,
 *  name) pair — several `![[pic.png]]` embeds in one document would
 *  otherwise each fire their own vault-wide scan. Keyed on the search plan's
 *  OWN baseDir (vault root or document folder) so a vault-scope and a
 *  folder-scope lookup sharing a basename never collide (different bases,
 *  different candidates). `boundedCache` — the same FIFO-eviction cache
 *  math-widget/mermaid-widget use for their renders — bounds it. */
const searchCache = boundedCache<string, Promise<string | null>>(64);
const searchCacheKey = (baseDir: string, name: string): string => `${baseDir} ${name}`;

/** Drop every cached `resolve_image` lookup — a test-only escape hatch for
 *  suites that reuse the same (baseDir, name) pair across cases expecting
 *  independent invoke counts. Never called by the app itself: a `null`
 *  result already self-evicts (see searchCache.delete below), so production
 *  code has no occasion to need a blanket reset. */
export function clearImageSearchCache(): void {
  searchCache.clear();
}

export class ImageWidget extends WidgetType {
  /** `url` is the literal-resolved asset URL (the cheap, no-cost path that
   *  preserves current behavior). `rawSrc`/`baseDir` are kept so a load failure
   *  can ask the backend to rediscover the file by basename under baseDir.
   *  `searchScope` picks which rule (`searchPlanFor` above) governs that
   *  fallback: `"vault"` for a `![[name]]` embed (wikilink.ts), `"folder"`
   *  (the default) for a standard `![](name)` image. */
  constructor(
    readonly url: string,
    readonly alt: string,
    readonly rawSrc = "",
    readonly baseDir = "",
    readonly searchScope: "vault" | "folder" = "folder",
  ) {
    super();
  }
  eq(o: ImageWidget) {
    // The fallback result is a pure function of (url, rawSrc, baseDir,
    // searchScope), so identity must include all four — otherwise selection
    // churn that rebuilds with the same url but a stale rawSrc/baseDir/scope
    // would reuse the wrong DOM (or re-trigger a resolve under the wrong
    // rule). Same widget ⇒ same rendered+resolved image.
    return (
      o.url === this.url &&
      o.rawSrc === this.rawSrc &&
      o.baseDir === this.baseDir &&
      o.searchScope === this.searchScope
    );
  }
  toDOM(view: EditorView) {
    const img = document.createElement("img");
    img.className = "cm-image";
    img.alt = this.alt;
    img.src = this.url;

    // Recursive-search fallback: when the literal src fails to load AND the
    // setting is on AND it's a local path, ask the backend to find the file by
    // basename under baseDir, then swap the src in. WikilinkWidget's
    // pending→invoke→DOM-swap pattern, adapted for <img onerror>.
    // `triedFallback` is a domain rule, not an optimization: onerror fires again
    // when the resolved src ALSO fails, so without this guard the fallback loops.
    let triedFallback = false;
    // Recorded when the fallback above actually finds the file — so a click
    // opens the viewer on the SAME file the widget ends up displaying, not
    // the literal target that failed (viewerSourceFor's first priority).
    let resolvedPath: string | null = null;
    img.onerror = () => {
      if (triedFallback) return;
      triedFallback = true;
      if (isRemoteSrc(this.rawSrc)) return; // remote/data never rediscovered
      if (!this.rawSrc) return; // nothing to search by name
      const root = imageSearchRoot();
      const plan = searchPlanFor(this.searchScope, root, this.baseDir);
      if (this.searchScope === "vault" && root === null) {
        reportVaultScopeDowngrade(this.rawSrc, this.baseDir, plan);
      }
      if (plan.gated && recursiveImageSearchSetting.get() !== "on") return; // user opted out (folder scope only)
      if (!plan.baseDir) return; // nothing to resolve against
      const key = searchCacheKey(plan.baseDir, this.rawSrc);
      let pending = searchCache.get(key);
      if (!pending) {
        pending = invoke<string | null>("resolve_image", {
          baseDir: plan.baseDir,
          name: this.rawSrc,
          maxDepth: plan.maxDepth,
        }).catch(() => null); // best-effort: a backend error leaves the broken image as-is
        searchCache.put(key, pending);
      }
      pending.then((found) => {
        if (found) {
          resolvedPath = found;
          img.src = convertFileSrc(found);
        } else {
          // Not a permanent miss — the file may show up later (e.g. right
          // after an attach), so don't remember "not found" forever.
          searchCache.delete(key);
        }
      });
    };

    // Click → open the image viewer (one click, no modifier — user-confirmed
    // decision, _workspace/01_architect_design_imgclick.md). A broken image
    // opens the viewer too (no branch): the viewer's own onerror stance
    // ("stay open with a failure caption") already covers it.
    let downX = 0;
    let downY = 0;
    img.addEventListener("mousedown", (e) => {
      downX = e.clientX;
      downY = e.clientY;
    });
    img.addEventListener("click", (e) => {
      if (e.altKey) return; // Alt+click = edit source (attachAltClickEdit below)
      if (dragExceededClickSlop(downX, downY, e)) return; // drag release, not a click
      e.preventDefault();
      const source = viewerSourceFor(this.rawSrc, this.baseDir, resolvedPath);
      if (source) requestImageOpen(source);
    });
    attachAltClickEdit(img, view);

    return img;
  }
  ignoreEvent() {
    return true;
  }
}
