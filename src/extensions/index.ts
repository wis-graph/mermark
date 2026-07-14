// The home for personal editor extensions. Import ONLY from "../api" (the
// facade, src/api/index.ts) or npm packages — never a mermark internal module
// directly (tests/api-fence.test.ts enforces this with a grep-based check,
// since this repo carries no ESLint to write a real import-restriction rule
// for). Register features/commands/settings here; main.ts calls
// activateExtensions() once at boot, right after the registerHandler block
// and before the first editor mounts — early enough that a registration lands
// in the very first mount's snapshot (no reloadFeatures() needed for boot-time
// extensions; that path exists for extensions that register LATE, e.g. after
// an async init).
import { registerExcelViewer } from "./excel-viewer";
import { registerHtmlViewer } from "./html-viewer";

export function activateExtensions(): void {
  // registerExcelViewer() only registers the {id, extensions, open} catalog
  // entry (registerViewer, ../api) — it does NOT import the ~1MB `xlsx`
  // library. That import is deferred to the viewer's own open() call (R11
  // design §7), so this boot-time call stays cold-load-cheap.
  registerExcelViewer();
  // registerHtmlViewer() (R11 2단계, _workspace/01_html_viewer.md §0/§7): zero
  // new dependencies to defer — DOMParser/TextDecoder are browser-native, so
  // this call is cold-load-cheap by construction, not by a dynamic-import
  // trick like Excel's.
  registerHtmlViewer();
}
