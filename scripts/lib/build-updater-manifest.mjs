// SSOT for updater.json's shape. scripts/write-updater-json.mjs is the only
// writer of updater.json (release.sh calls it once, after both macOS and
// Windows assets are confirmed uploaded) — this module exists so that
// contract can be unit-tested without touching the filesystem or GitHub.
//
// Deliberately NOT a merge with any existing updater.json on disk: each
// release fully replaces the platforms map from the entries it's given.
// A merge-with-old-file design is exactly the kind of thing that lets a
// stale platform entry from a previous version survive into a new one —
// building fresh from scratch makes that bug class structurally impossible.

/**
 * @param {{version: string, notes: string, pubDate: string, platforms: Record<string, {signature: string, url: string}>}} args
 */
export function buildUpdaterManifest({ version, notes, pubDate, platforms }) {
  if (!version) throw new Error("version is required");
  if (!pubDate) throw new Error("pubDate is required");
  if (!platforms || Object.keys(platforms).length === 0) {
    throw new Error("platforms must include at least one entry");
  }
  for (const [name, entry] of Object.entries(platforms)) {
    if (!entry || !entry.signature || !entry.url) {
      throw new Error(`platform "${name}" is missing signature or url`);
    }
  }
  return {
    version,
    notes: notes ?? "",
    pub_date: pubDate,
    platforms,
  };
}

/** @param {{tag: string, signature: string}} args */
export function darwinAarch64Platform({ tag, signature }) {
  return {
    "darwin-aarch64": {
      signature,
      url: `https://github.com/wis-graph/mermark/releases/download/${tag}/mermark.app.tar.gz`,
    },
  };
}

/** @param {{tag: string, exeName: string, signature: string}} args */
export function windowsX64Platform({ tag, exeName, signature }) {
  return {
    "windows-x86_64": {
      signature,
      url: `https://github.com/wis-graph/mermark/releases/download/${tag}/${exeName}`,
    },
  };
}
