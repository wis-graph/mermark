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
export function activateExtensions(): void {
  // Register personal extensions here, e.g.:
  //   import { registerBlockFeature } from "../api";
  //   registerBlockFeature(myCalloutFeature);
}
