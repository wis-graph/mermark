use std::path::Path;

use super::listing::is_mermark_artifact;
use super::paths::normalize_path;

/// A `[[`-pickable target in a directory: a markdown note or an inlineable image.
/// `name` is the insertion label, `rel` is the directory-relative path (always the
/// file name today — non-recursive — but kept so a future recursive scan can fill
/// `sub/note.md` without changing the shape), and `kind` lets the frontend branch
/// its insertion rule. The frontend mirrors this exact shape in
/// `src/mocks/tauri-core.ts` and its `invoke<LinkTarget[]>("list_link_targets")`.
#[derive(serde::Serialize, serde::Deserialize)]
pub struct LinkTarget {
    /// Insertion label: a markdown note's basename (no `.md`), or an image's full
    /// file name (extension included, Obsidian embed convention).
    pub name: String,
    /// Path relative to the listed directory. Equals the file name today (current
    /// folder only); reserved for a future recursive scan / duplicate-name split.
    pub rel: String,
    /// `"markdown"` or `"image"` — the frontend's `![[…]]`-vs-`[[…]]` branch.
    pub kind: String,
}

/// Whether `ext` (without the dot) names an image mermark can inline. This is the
/// Rust half of one truth shared with `wikilink.ts`'s `isImageTarget` regex
/// (`png|jpe?g|gif|webp|svg|avif|bmp`); the two sets must stay identical so the
/// picker and the embed renderer agree on what counts as an image. Case-insensitive
/// to match the TS `/i` flag.
pub(crate) fn is_image_ext(ext: &str) -> bool {
    matches!(
        ext.to_ascii_lowercase().as_str(),
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" | "avif" | "bmp"
    )
}

/// Whether `ext` (without the dot) names a file the editor opens as a live-preview
/// document — `.md` and `.txt` are treated identically once inside the editor, so
/// both share this one gate. This is the Rust mirror of `file-icons.ts`'s
/// `EDITABLE_TEXT_EXTENSIONS`/`isEditableTextFile`; the two sets must stay
/// identical so the picker (here), the explorer/search dim-gate, and the wikilink
/// open-vs-external-app branch all agree on what the editor can open.
/// Case-insensitive to match that TS set's `extensionOf` lowercasing.
fn is_editor_text_ext(ext: &str) -> bool {
    matches!(ext.to_ascii_lowercase().as_str(), "md" | "txt")
}

/// Whether an editor-openable extension is inserted by *stem* (extension
/// stripped) rather than by full file name. Only `.md` qualifies: `wikilinkPath`
/// appends `.md` to an extension-less insertion, so a stem-only `note` still
/// resolves back to `note.md`. Every other editor-openable extension (currently
/// just `.txt`) must keep its extension in `name` — a stem-only `note` for
/// `note.txt` would make `[[note]]` resolve to `note.md` instead, the wrong file.
/// This is a *separate* concept from `is_editor_text_ext`: that gate asks "can the
/// editor open this at all," this one asks "does its insertion label drop the
/// extension." Keeping them as two named facts (instead of letting the `.md`
/// branch re-test `"md"` inline) is what stops a future editable extension from
/// silently bypassing the SSOT gate.
fn uses_stem_as_link_name(ext: &str) -> bool {
    ext.eq_ignore_ascii_case("md")
}

/// Classify a single directory entry into a `LinkTarget`, or `None` when it isn't
/// a pickable target. The domain rule lives here as one named function instead of
/// being scattered through `list_link_targets`: an editor-openable file
/// (`is_editor_text_ext`) becomes a markdown-kind target — labeled by stem or by
/// full file name per `uses_stem_as_link_name` — and a file with an image
/// extension becomes an image target labeled by its full name; everything else —
/// directories, dotfiles, mermark artifacts, and non-target files — is excluded.
/// `path` is expected to be directory-local (a single entry name); `rel` is set to
/// that file name.
fn classify_link_target(path: &Path) -> Option<LinkTarget> {
    if path.is_dir() {
        return None;
    }
    let file_name = path.file_name()?.to_str()?.to_owned();
    // Hidden dotfiles and the editor's own scratch/recovery files are never targets.
    if file_name.starts_with('.') || is_mermark_artifact(&file_name) {
        return None;
    }
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
    if is_editor_text_ext(ext) {
        let name = if uses_stem_as_link_name(ext) {
            path.file_stem()?.to_str()?.to_owned()
        } else {
            file_name.clone()
        };
        return Some(LinkTarget { name, rel: file_name, kind: "markdown".into() });
    }
    if is_image_ext(ext) {
        return Some(LinkTarget { name: file_name.clone(), rel: file_name, kind: "image".into() });
    }
    None
}

/// Display rank for the "markdown first, then images" ordering. Encoded as an
/// explicit ordinal rather than relying on the alphabetical order of the `kind`
/// string — `"image"` sorts *before* `"markdown"` lexically, which is the opposite
/// of what we want, so the intent ("notes before images") gets its own number.
fn link_target_kind_rank(kind: &str) -> u8 {
    match kind {
        "markdown" => 0,
        _ => 1, // images (and any future kinds) after notes
    }
}

/// Sort key for a deterministic picker list: markdown targets before images
/// (by `link_target_kind_rank`), then case-insensitively by `name`. Pulled out so
/// the "markdown first, then name" ordering is one named rule, not an inline closure.
fn link_target_sort_key(t: &LinkTarget) -> (u8, String) {
    (link_target_kind_rank(&t.kind), t.name.to_ascii_lowercase())
}

/// List the markdown notes and inlineable images directly inside `dir` (current
/// folder only — non-recursive) as `[[`-pickable targets. Read-only: enumerates,
/// never writes, so the atomic-write/conflict-guard machinery doesn't apply.
///
/// Graceful by design: a missing/unreadable directory returns `Err(String)`
/// (never panics), while an individual unreadable entry (broken symlink, permission
/// hiccup) is skipped via `filter_map(ok)` so one bad entry can't sink the whole
/// list. An empty directory yields `Ok(vec![])`. Output is sorted (markdown first,
/// then case-insensitive name) for stable tests and golden snapshots.
pub(crate) fn list_link_targets(dir: String) -> Result<Vec<LinkTarget>, String> {
    let normalized = normalize_path(Path::new(&dir));
    let entries = std::fs::read_dir(&normalized)
        .map_err(|e| format!("list {}: {e}", normalized.display()))?;
    let mut targets: Vec<LinkTarget> = entries
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| classify_link_target(&entry.path()))
        .collect();
    targets.sort_by_key(link_target_sort_key);
    Ok(targets)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use crate::fs::test_support::temp_dir;

    // --- list_link_targets (`[[` file picker enumeration) ---

    #[test]
    fn lists_md_and_image_targets() {
        let dir = temp_dir("md_and_img");
        fs::write(dir.join("a.md"), "x").unwrap();
        fs::write(dir.join("note.md"), "x").unwrap();
        fs::write(dir.join("pic.png"), "x").unwrap();
        let got = list_link_targets(dir.to_string_lossy().into_owned()).unwrap();
        assert_eq!(got.len(), 3, "two md + one image");
        // markdown is labeled by stem (no `.md`); image by full file name.
        let a = got.iter().find(|t| t.rel == "a.md").unwrap();
        assert_eq!(a.name, "a");
        assert_eq!(a.kind, "markdown");
        let pic = got.iter().find(|t| t.rel == "pic.png").unwrap();
        assert_eq!(pic.name, "pic.png");
        assert_eq!(pic.kind, "image");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn excludes_non_targets() {
        let dir = temp_dir("non_targets");
        fs::write(dir.join("data.json"), "x").unwrap();
        fs::write(dir.join("script.ts"), "x").unwrap();
        fs::write(dir.join("notes.markdown"), "x").unwrap(); // out of scope (md/txt only)
        fs::write(dir.join("out.log"), "x").unwrap();
        let got = list_link_targets(dir.to_string_lossy().into_owned()).unwrap();
        assert!(got.is_empty(), "non-md/non-txt/non-image files are excluded, got {:?}", got.iter().map(|t| &t.rel).collect::<Vec<_>>());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn txt_target_is_labeled_by_full_file_name() {
        // `.txt` gets markdown `kind` (the editor treats it identically to `.md`),
        // but `name` must be the full file name — not the stem — because
        // `wikilinkPath` appends `.md` to a stem-only insertion, which would
        // resolve `[[note]]` to the wrong file (`note.md` instead of `note.txt`).
        let dir = temp_dir("txt_target");
        fs::write(dir.join("note.txt"), "x").unwrap();
        let got = list_link_targets(dir.to_string_lossy().into_owned()).unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].name, "note.txt", "txt name is the full file name, not the stem");
        assert_eq!(got[0].rel, "note.txt");
        assert_eq!(got[0].kind, "markdown", "txt is editor-openable, same kind as md");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn txt_classification_is_case_insensitive() {
        let dir = temp_dir("txt_case");
        fs::write(dir.join("Note.TXT"), "x").unwrap();
        let got = list_link_targets(dir.to_string_lossy().into_owned()).unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].name, "Note.TXT");
        assert_eq!(got[0].kind, "markdown");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn txt_sorts_alongside_markdown_ahead_of_images() {
        // txt shares markdown's kind_rank (0), so it sorts before images and
        // alphabetically alongside real .md notes.
        let dir = temp_dir("txt_sort");
        fs::write(dir.join("z.md"), "x").unwrap();
        fs::write(dir.join("a.png"), "x").unwrap();
        fs::write(dir.join("m.txt"), "x").unwrap();
        let got = list_link_targets(dir.to_string_lossy().into_owned()).unwrap();
        let order: Vec<&str> = got.iter().map(|t| t.rel.as_str()).collect();
        assert_eq!(order, vec!["m.txt", "z.md", "a.png"], "txt sorts by name among notes, before images");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn non_editor_text_ext_excluded_from_link_targets() {
        // Scope guard: only md/txt are editor-openable; .markdown and .log are not,
        // even though they're also plain text files.
        let dir = temp_dir("txt_scope");
        fs::write(dir.join("a.markdown"), "x").unwrap();
        fs::write(dir.join("b.log"), "x").unwrap();
        let got = list_link_targets(dir.to_string_lossy().into_owned()).unwrap();
        assert!(got.is_empty(), "only md/txt are editor-openable link targets, got {:?}", got.iter().map(|t| &t.rel).collect::<Vec<_>>());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn excludes_dirs_and_dotfiles_and_artifacts() {
        let dir = temp_dir("excludes");
        fs::create_dir_all(dir.join("sub")).unwrap(); // a subdirectory
        fs::write(dir.join("sub/buried.md"), "x").unwrap(); // not recursed into
        fs::write(dir.join(".hidden.md"), "x").unwrap(); // dotfile
        fs::write(dir.join("x.md.mermark-tmp.1"), "x").unwrap(); // autosave temp
        fs::write(dir.join("y.md.mermark-recovered"), "x").unwrap(); // recovery marker
        fs::write(dir.join("real.md"), "x").unwrap(); // the only valid target
        let got = list_link_targets(dir.to_string_lossy().into_owned()).unwrap();
        assert_eq!(got.len(), 1, "only real.md survives, got {:?}", got.iter().map(|t| &t.rel).collect::<Vec<_>>());
        assert_eq!(got[0].name, "real");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn empty_dir_returns_empty() {
        let dir = temp_dir("empty");
        let got = list_link_targets(dir.to_string_lossy().into_owned()).unwrap();
        assert!(got.is_empty(), "an empty directory yields an empty vec");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn missing_dir_is_graceful_err() {
        // A path that doesn't exist must return Err (graceful), never panic.
        let missing = std::env::temp_dir()
            .join(format!("mermark_links_missing_{}", std::process::id()))
            .to_string_lossy()
            .into_owned();
        let res = list_link_targets(missing);
        assert!(res.is_err(), "missing directory is a graceful error");
    }

    #[test]
    fn sorted_markdown_first_then_name() {
        let dir = temp_dir("sorted");
        fs::write(dir.join("z.md"), "x").unwrap();
        fs::write(dir.join("a.png"), "x").unwrap();
        fs::write(dir.join("b.md"), "x").unwrap();
        let got = list_link_targets(dir.to_string_lossy().into_owned()).unwrap();
        // kind asc (markdown before image), then name asc (case-insensitive).
        let order: Vec<&str> = got.iter().map(|t| t.rel.as_str()).collect();
        assert_eq!(order, vec!["b.md", "z.md", "a.png"], "markdown first, then by name");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn image_ext_set_matches_isimagetarget() {
        // Every extension wikilink.ts's isImageTarget accepts must classify as an
        // image here too, case-insensitively — one shared truth across the boundary.
        let dir = temp_dir("img_exts");
        for name in ["t.PNG", "t.jpeg", "t.webp", "t.svg", "t.avif", "t.bmp", "t.gif", "t.jpg"] {
            fs::write(dir.join(name), "x").unwrap();
        }
        let got = list_link_targets(dir.to_string_lossy().into_owned()).unwrap();
        assert_eq!(got.len(), 8, "all eight image extensions are recognized");
        assert!(got.iter().all(|t| t.kind == "image"), "all classify as image kind");
        fs::remove_dir_all(&dir).ok();
    }
}
