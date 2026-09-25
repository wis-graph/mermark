// Shared wire-shape types for the read-only file IPC surface (list_dir,
// list_files_recursive, list_link_targets). These used to live one-per-panel
// (explorer-panel.ts, search-panel.ts, wikilink-complete.ts) since each panel
// only needed its own shape — file-host.ts now needs all three in one place
// to describe `FileHostBackend`, so they're canonicalized here and
// re-exported from their original homes to keep existing imports working.
//
// serde serializes Rust field names verbatim, so the snake_case fields
// (`is_dir`, `rel_path`) mirror the Rust structs and the browser mock
// (`src/mocks/tauri-core.ts`) exactly — this 3-way boundary parity is a
// first-class contract, not a style choice.

/** A single directory entry as returned by the backend `list_dir` command. */
export interface DirEntry {
  name: string;
  path: string;
  is_dir: boolean;
}

/** One file hit from the backend recursive scan (`list_files_recursive`). */
export interface FileHit {
  name: string;
  path: string;
  rel_path: string;
}

/** The recursive scan's result. `truncated` is surfaced to the user — a
 *  silently-clipped result set would be a lie about what's actually on disk. */
export interface ScanResult {
  files: FileHit[];
  truncated: boolean;
}

/** One filesystem drive/volume root, as returned by the backend `list_drives`
 *  command — the explorer's "내 컴퓨터" (My Computer) virtual root listing.
 *  Same convention as `DirEntry`: no `rename_all`, so `display_name` wires
 *  snake_case verbatim (Rust `DriveEntry`, `src-tauri/src/fs/drives.rs`). */
export interface DriveEntry {
  path: string;
  display_name: string;
}

/** One linkable file in a base folder, as returned by `list_link_targets`.
 *  `kind` drives the wikilink completion's insert rule (markdown → basename,
 *  image → filename with extension). */
export interface LinkTarget {
  /** Insert label: markdown = basename (no `.md`); image = filename (with ext). */
  name: string;
  /** Path relative to the base dir — kept for future dedup/recursive expansion. */
  rel: string;
  /** "markdown" | "image" — selects the insert rule. The Rust `LinkTarget.kind`
   *  is the SSOT for these exact strings (see fs/link_targets.rs classify_link_target). */
  kind: "markdown" | "image";
}
