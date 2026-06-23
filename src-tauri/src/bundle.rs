//! LLM context packager: starting from a root markdown file, follow its
//! wikilinks one hop, collect the linked documents, and wrap them in an XML
//! envelope a model can read. This is the single source of truth for three
//! concerns — wikilink scanning, baseDir containment (the CRITICAL security
//! gate), and the output format — so the CLI (`mermark bundle`) and the
//! `bundle_doc` IPC command produce identical output by sharing one core.
//!
//! Read-only: it never creates or modifies a file.

use crate::commands::normalize_path;
use std::collections::HashSet;
use std::path::{Path, PathBuf};

/// How far to follow wikilinks from the root. `1` means "the root plus the
/// documents the root links directly" (1 hop / immediate neighbours), not the
/// full transitive closure. A note graph's transitive closure can pull in an
/// entire vault — token-budget poison for an LLM — so the default is one hop.
/// The traversal itself is written as a depth-capped recursion (with a visited
/// set), so raising this constant is all that's needed to widen the closure
/// later without restructuring.
const DEFAULT_BUNDLE_DEPTH: usize = 1;

/// A markdown document that survived containment and was read off disk, ready
/// to be placed in the bundle envelope. `rel` is the baseDir-relative path used
/// for the `path=` attribute (absolute paths are never leaked); `title` is the
/// file stem; `body` is the raw markdown, inserted verbatim.
struct ResolvedDoc {
    rel: String,
    title: String,
    body: String,
}

// ---------------------------------------------------------------------------
// Wikilink scanning (byte-scan, mirrors src/markdown/parser.ts — no regex crate)
// ---------------------------------------------------------------------------

/// Scan markdown for wikilink targets in document order, mirroring the
/// `parseInline` logic in `src/markdown/parser.ts`: recognise `[[target]]`,
/// `[[target|alias]]`, `[[target#heading]]`, and `![[embed]]`. A link is
/// invalid (skipped) if a newline or a nested `[` appears before the closing
/// `]]`. The returned target is the raw text between the brackets *before* any
/// `|` alias (alias and `#heading` are split out later by `resolve_target_path`).
///
/// Unlike parser.ts — which rides the Lezer tree, so fenced code disables inline
/// parsing for free — this byte-scan has no tree, so it tracks ``` fences itself
/// and ignores any `[[…]]` inside a code block. That keeps the bundler from
/// chasing fake links shown as code examples. This fence tracking is the one
/// piece of extra complexity over a literal port, and it is pinned by unit test.
pub fn scan_wikilink_targets(md: &str) -> Vec<String> {
    let mut targets = Vec::new();
    let mut in_fence = false;
    for line in md.lines() {
        let trimmed = line.trim_start();
        // A line whose first non-space content is ``` (or ~~~) toggles a fenced
        // code block. Everything between an opening and closing fence is code,
        // so wikilinks there are ignored (matches the tree's behaviour).
        if is_fence_line(trimmed) {
            in_fence = !in_fence;
            continue;
        }
        if in_fence {
            continue;
        }
        scan_line_targets(line.as_bytes(), &mut targets);
    }
    targets
}

/// True when a line opens or closes a fenced code block — its first non-space
/// run is at least three backticks or three tildes. Named so the fence rule
/// reads as one fact instead of an inline byte check in `scan_wikilink_targets`.
fn is_fence_line(trimmed: &str) -> bool {
    let b = trimmed.as_bytes();
    (b.len() >= 3 && b[0] == b'`' && b[1] == b'`' && b[2] == b'`')
        || (b.len() >= 3 && b[0] == b'~' && b[1] == b'~' && b[2] == b'~')
}

/// Scan a single (non-fenced) line's bytes for `[[…]]` / `![[…]]` openers and
/// push each valid target (raw text before any `|` alias) onto `out`. Mirrors
/// parser.ts: stop the inner scan at a newline (handled by line splitting) or a
/// nested `[`, require a `]]` close, and treat the first `|` as the alias
/// divider so only the target portion is captured.
fn scan_line_targets(line: &[u8], out: &mut Vec<String>) {
    let n = line.len();
    let mut i = 0;
    while i < n {
        // Detect an opener: `![[` (embed) or `[[` (plain).
        let (is_open, open) = if line[i] == b'!'
            && i + 2 < n
            && line[i + 1] == b'['
            && line[i + 2] == b'['
        {
            (true, i + 3)
        } else if line[i] == b'[' && i + 1 < n && line[i + 1] == b'[' {
            (true, i + 2)
        } else {
            (false, 0)
        };
        if !is_open {
            i += 1;
            continue;
        }
        // Scan forward to `]]`, tracking the first `|`. A nested `[` invalidates
        // (mirrors parser.ts: `if (ch === BRACKET_L) return -1`).
        let mut pipe: Option<usize> = None;
        let mut close: Option<usize> = None;
        let mut j = open;
        let mut invalid = false;
        while j < n {
            let ch = line[j];
            if ch == b'[' {
                invalid = true;
                break;
            }
            if ch == b'|' && pipe.is_none() {
                pipe = Some(j);
            }
            if ch == b']' {
                if j + 1 < n && line[j + 1] == b']' {
                    close = Some(j);
                }
                break;
            }
            j += 1;
        }
        match (invalid, close) {
            (false, Some(c)) if c > open => {
                let end = pipe.map(|p| p.min(c)).unwrap_or(c);
                if let Ok(target) = std::str::from_utf8(&line[open..end]) {
                    let t = target.trim();
                    if !t.is_empty() {
                        out.push(t.to_string());
                    }
                }
                i = c + 2; // resume past the `]]`
            }
            _ => {
                i = open; // not a valid link; resume scanning just inside the opener
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Target resolution + containment (security gate)
// ---------------------------------------------------------------------------

/// True when an embed target (`![[…]]`) is an image we inline rather than bundle
/// as text — mirrors `isImageTarget` in `src/markdown/wikilink.ts`
/// (png/jpe?g/gif/webp/svg/avif/bmp), checked against the `#`-stripped target.
/// Image embeds are skipped: the bundle is text for an LLM, not binaries.
pub fn is_image_embed(target: &str) -> bool {
    let file = target.split('#').next().unwrap_or("").trim();
    let lower = file.to_ascii_lowercase();
    const IMAGE_EXTS: [&str; 8] = [
        ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".avif", ".bmp",
    ];
    IMAGE_EXTS.iter().any(|ext| lower.ends_with(ext))
}

/// Resolve a wikilink target to a candidate path under `base_dir`, mirroring
/// `wikilinkPath` in `src/markdown/wikilink.ts`: strip any `#heading`/`#^block`
/// suffix, add `.md` when the target has no extension, and treat a `/`-prefixed
/// target as an absolute path (joined as-is). Returns `None` for an empty target
/// (e.g. a bare `[[#heading]]`, which points at the current file, not a new one).
/// This does NOT enforce containment — that is `is_within_base`'s job, called
/// after this on the result — so a `..`-laden or absolute target resolves here
/// and is rejected there.
fn resolve_target_path(target: &str, base_dir: &Path) -> Option<PathBuf> {
    let file = target.split('#').next().unwrap_or("").trim();
    if file.is_empty() {
        return None;
    }
    let with_ext = if has_extension(file) {
        file.to_string()
    } else {
        format!("{file}.md")
    };
    if with_ext.starts_with('/') {
        Some(PathBuf::from(with_ext))
    } else {
        Some(base_dir.join(with_ext))
    }
}

/// True when a target's filename already carries an extension (`.md`, `.png`,
/// …), mirroring the `/\.[a-z0-9]+$/i` test in `wikilinkPath`. Named so the
/// "needs a `.md` appended?" rule in `resolve_target_path` reads by intent.
fn has_extension(file: &str) -> bool {
    file.rsplit('/')
        .next()
        .and_then(|name| name.rsplit_once('.'))
        .is_some_and(|(_, ext)| {
            !ext.is_empty() && ext.chars().all(|c| c.is_ascii_alphanumeric())
        })
}

/// **CRITICAL security gate.** True only when `candidate`, after textual
/// normalization, is contained within `base` (the root file's directory). This
/// is what blocks a wikilink from escaping the base directory —
/// `[[../../etc/passwd]]` normalizes to `/etc/passwd`, which is not under
/// `base`, so it is rejected; an absolute `[[/etc/passwd]]` likewise lands
/// outside `base`. `normalize_path` collapses `..` purely textually and *can*
/// rise above `base`, which is exactly why this prefix check is mandatory after
/// it. A pure query (CQS) — no I/O, no side effects.
pub fn is_within_base(candidate: &Path, base: &Path) -> bool {
    let normalized = normalize_path(candidate);
    let normalized_base = normalize_path(base);
    normalized.starts_with(&normalized_base)
}

/// Resolve a scanned target to an existing, *contained* markdown file path, or
/// `None` if it is an image embed, an empty target, escapes the base directory
/// (containment failure), or simply doesn't exist on disk. Folding all the
/// "this link is not bundleable" reasons behind one name keeps `collect` from
/// scattering the skip rules across inline conditions.
fn bundleable_path(target: &str, base_dir: &Path) -> Option<PathBuf> {
    if is_image_embed(target) {
        return None;
    }
    let candidate = resolve_target_path(target, base_dir)?;
    if !is_within_base(&candidate, base_dir) {
        return None; // containment: refuse to read outside base_dir
    }
    let normalized = normalize_path(&candidate);
    if normalized.is_file() {
        Some(normalized)
    } else {
        None // missing / unreadable link is silently skipped (not an error)
    }
}

// ---------------------------------------------------------------------------
// Traversal
// ---------------------------------------------------------------------------

/// Recursively collect the root document plus every document reachable within
/// `max_depth` hops of wikilinks, in discovery order (document order within each
/// file), deduplicated by a `visited` set so a document is bundled at most once
/// even under link cycles (`[[a]]…[[b]]…[[a]]`). The visited set is mandatory
/// even at depth 1: a single file can link the same target twice. `base_dir` is
/// fixed to the root's directory for the whole traversal, so containment is
/// measured against one stable base; relative `path=` attributes are computed
/// against it later in `format_document`.
fn collect_linked_docs(
    path: &Path,
    base_dir: &Path,
    max_depth: usize,
    visited: &mut HashSet<PathBuf>,
    out: &mut Vec<ResolvedDoc>,
) {
    let normalized = normalize_path(path);
    if !visited.insert(normalized.clone()) {
        return; // already bundled — cycle / duplicate guard
    }
    let body = match std::fs::read_to_string(&normalized) {
        Ok(text) => text,
        Err(_) => return, // unreadable: skip silently (root errors are caught upstream)
    };
    out.push(ResolvedDoc {
        rel: relative_to_base(&normalized, base_dir),
        title: stem_of(&normalized),
        body: body.clone(),
    });
    if max_depth == 0 {
        return; // depth cap reached: don't follow this document's links
    }
    for target in scan_wikilink_targets(&body) {
        if let Some(child) = bundleable_path(&target, base_dir) {
            collect_linked_docs(&child, base_dir, max_depth - 1, visited, out);
        }
    }
}

/// The path written into a document's `path=` attribute: baseDir-relative when
/// the file is under base (the normal case — `deep/leaf.md`, or just `note.md`
/// for the root), falling back to the file name if it somehow isn't. Never an
/// absolute path — that would leak the user's directory layout into the bundle.
fn relative_to_base(path: &Path, base_dir: &Path) -> String {
    let normalized = normalize_path(path);
    let normalized_base = normalize_path(base_dir);
    normalized
        .strip_prefix(&normalized_base)
        .ok()
        .map(|rel| rel.to_string_lossy().into_owned())
        .unwrap_or_else(|| stem_with_ext(&normalized))
}

/// File stem (name without extension) used for the `title=` attribute.
fn stem_of(path: &Path) -> String {
    path.file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// File name with extension, used as the relative-path fallback.
fn stem_with_ext(path: &Path) -> String {
    path.file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Formatting (XML envelope, Claude-friendly)
// ---------------------------------------------------------------------------

/// Render one document as a `<document>` element. The body is inserted **raw**,
/// without XML-escaping: an LLM reads markdown more accurately as the original
/// bytes, and `<`/`&` in the body don't confuse it about the envelope tags. The
/// `path=` attribute is baseDir-relative and `title=` is the file stem.
fn format_document(doc: &ResolvedDoc) -> String {
    format!(
        "<document path=\"{}\" title=\"{}\">\n{}\n</document>",
        doc.rel, doc.title, doc.body
    )
}

/// Wrap the collected documents in the `<documents>…</documents>` envelope,
/// root first, then linked documents in discovery order. Always wrapped — even
/// a single document with no links — so the model receives one consistent
/// structure. This format spec lives only here (and in `format_document`); the
/// frontend never reconstructs it, because the IPC command shares this core.
fn format_bundle(docs: &[ResolvedDoc]) -> String {
    let mut out = String::from("<documents>\n");
    for (i, doc) in docs.iter().enumerate() {
        if i > 0 {
            out.push('\n');
        }
        out.push_str(&format_document(doc));
        out.push('\n');
    }
    out.push_str("</documents>");
    out
}

// ---------------------------------------------------------------------------
// Public entry point (shared by CLI dispatch and the bundle_doc command)
// ---------------------------------------------------------------------------

/// Package `root_path` and its one-hop linked documents into the bundle string.
/// `base_dir` is the root file's parent directory; all containment is measured
/// against it, and the root itself is opened as given (the user explicitly
/// chose it, so it isn't containment-checked — only links it reaches are).
/// Returns `Err` only when the *root* file can't be read; missing/unreadable
/// *links* are skipped silently. Single entry point so the CLI and `bundle_doc`
/// share depth, containment, and format.
pub fn bundle_to_string(root_path: &str) -> Result<String, String> {
    let root = normalize_path(Path::new(root_path));
    // Fail loudly only for the root — confirm it's readable before traversal so
    // a bad CLI/IPC argument produces a clear error rather than an empty bundle.
    std::fs::read_to_string(&root).map_err(|e| format!("bundle read {}: {e}", root.display()))?;
    let base_dir = root
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| PathBuf::from("."));
    let mut visited: HashSet<PathBuf> = HashSet::new();
    let mut docs: Vec<ResolvedDoc> = Vec::new();
    collect_linked_docs(&root, &base_dir, DEFAULT_BUNDLE_DEPTH, &mut visited, &mut docs);
    Ok(format_bundle(&docs))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::{AtomicU64, Ordering};

    static BUNDLE_TEST_SEQ: AtomicU64 = AtomicU64::new(1);

    /// An isolated base directory under the temp dir, PID- and tag-keyed like
    /// the other backend tests so concurrent test binaries don't collide.
    fn base_dir(tag: &str) -> PathBuf {
        let n = BUNDLE_TEST_SEQ.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir()
            .join(format!("mermark_bundle_{}_{n}_{tag}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write(dir: &Path, rel: &str, body: &str) -> PathBuf {
        let p = dir.join(rel);
        if let Some(parent) = p.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(&p, body).unwrap();
        p
    }

    // ----- A1: containment (CRITICAL) -----

    #[test]
    fn dot_dot_escape_secret_never_appears_in_bundle() {
        // The headline security test: a `[[../escape]]` link must NOT pull a
        // file outside the base directory into the bundle.
        let dir = base_dir("escape");
        let base = dir.join("base");
        fs::create_dir_all(&base).unwrap();
        write(&base, "root.md", "[[child]] and [[../escape]] and [[deep/leaf]]");
        write(&base, "child.md", "child body [[root]]"); // cycle back to root
        write(&base, "deep/leaf.md", "leaf body");
        // The secret lives OUTSIDE base (a sibling of base/).
        write(&dir, "escape.md", "SECRET — must NOT appear");

        let bundle = bundle_to_string(&base.join("root.md").to_string_lossy()).unwrap();
        assert!(
            !bundle.contains("SECRET"),
            "`..` escape must be blocked by containment; bundle was:\n{bundle}"
        );
    }

    #[test]
    fn is_within_base_blocks_dot_dot_and_allows_child() {
        let base = base_dir("within").join("base");
        fs::create_dir_all(&base).unwrap();
        assert!(
            !is_within_base(&base.join("../escape.md"), &base),
            "../escape must be outside base"
        );
        assert!(
            is_within_base(&base.join("deep/leaf.md"), &base),
            "deep/leaf must be inside base"
        );
    }

    #[test]
    fn absolute_path_target_is_blocked_by_containment() {
        // `[[/etc/passwd]]` resolves to an absolute path outside base → rejected.
        let base = base_dir("abs").join("base");
        fs::create_dir_all(&base).unwrap();
        // An extensionless absolute target gets `.md` appended (wikilinkPath
        // mirror) but stays absolute, so it lands outside base → rejected.
        let resolved = resolve_target_path("/etc/passwd", &base).unwrap();
        assert!(resolved.is_absolute(), "absolute target stays absolute: {resolved:?}");
        assert!(
            !is_within_base(&resolved, &base),
            "absolute path outside base must be rejected"
        );
        // An absolute target that already has an extension is left untouched.
        assert_eq!(
            resolve_target_path("/etc/hosts.conf", &base).unwrap(),
            PathBuf::from("/etc/hosts.conf")
        );
    }

    #[test]
    fn absolute_link_secret_never_appears_in_bundle() {
        // End-to-end: a root that links an absolute path outside base must not
        // bundle that file's contents.
        let dir = base_dir("abs_secret");
        let base = dir.join("base");
        fs::create_dir_all(&base).unwrap();
        let secret = dir.join("secret.md");
        fs::write(&secret, "ABSOLUTE-SECRET").unwrap();
        let link = format!("[[{}]]", secret.to_string_lossy());
        write(&base, "root.md", &link);

        let bundle = bundle_to_string(&base.join("root.md").to_string_lossy()).unwrap();
        assert!(
            !bundle.contains("ABSOLUTE-SECRET"),
            "absolute-path link outside base must be blocked; bundle:\n{bundle}"
        );
    }

    // ----- A2: wikilink scan -----

    #[test]
    fn scans_plain_alias_and_heading_targets() {
        let t = scan_wikilink_targets("see [[a]] and [[b|alias]] and [[c#sec]]");
        assert_eq!(t, vec!["a".to_string(), "b".to_string(), "c#sec".to_string()]);
    }

    #[test]
    fn embed_target_is_scanned() {
        // `![[note]]` (non-image embed) yields its target like a plain link.
        let t = scan_wikilink_targets("![[note]]");
        assert_eq!(t, vec!["note".to_string()]);
    }

    #[test]
    fn image_embed_is_classified_as_image() {
        assert!(is_image_embed("pic.png"));
        assert!(is_image_embed("photo.JPEG"));
        assert!(is_image_embed("d.svg#frag"));
        assert!(!is_image_embed("note"));
        assert!(!is_image_embed("note.md"));
    }

    #[test]
    fn wikilinks_inside_a_code_fence_are_ignored() {
        // byte-scan fence tracking: a `[[fake]]` inside ``` must not be scanned.
        let md = "real [[keep]]\n```\n[[fake]]\n```\nafter [[also]]";
        let t = scan_wikilink_targets(md);
        assert_eq!(t, vec!["keep".to_string(), "also".to_string()]);
    }

    #[test]
    fn newline_and_nested_bracket_invalidate_link() {
        // parser.ts mirror: a `[` before the close, or a newline, invalidates.
        assert!(scan_wikilink_targets("[[a\nb]]").is_empty());
        assert!(scan_wikilink_targets("[[a[b]]").is_empty());
    }

    // ----- A3: traversal, dedup, depth cap, format -----

    #[test]
    fn bundle_has_root_first_then_links_each_once() {
        let dir = base_dir("traverse");
        let base = dir.join("base");
        fs::create_dir_all(&base).unwrap();
        // root links child twice + deep/leaf; child cycles back to root.
        write(&base, "root.md", "[[child]] x [[child]] y [[deep/leaf]]");
        write(&base, "child.md", "child body [[root]]");
        write(&base, "deep/leaf.md", "leaf body [[grandchild]]");
        write(&base, "grandchild.md", "GRANDCHILD body"); // depth 2 — excluded

        let bundle = bundle_to_string(&base.join("root.md").to_string_lossy()).unwrap();

        // root is the first document.
        let root_pos = bundle.find("path=\"root.md\"").expect("root present");
        let child_pos = bundle.find("path=\"child.md\"").expect("child present");
        assert!(root_pos < child_pos, "root must come first");

        // child appears exactly once (dedup despite being linked twice + cycle).
        assert_eq!(bundle.matches("path=\"child.md\"").count(), 1);
        // deep/leaf present with a baseDir-relative path (forward slashes).
        assert!(bundle.contains("path=\"deep/leaf.md\""), "relative path:\n{bundle}");
        // depth cap = 1: grandchild (2 hops) excluded.
        assert!(!bundle.contains("GRANDCHILD"), "depth cap must exclude grandchild:\n{bundle}");
        // wrapped in the envelope.
        assert!(bundle.starts_with("<documents>"));
        assert!(bundle.ends_with("</documents>"));
        // no absolute path leaked into a path= attribute.
        assert!(!bundle.contains(&format!("path=\"{}", base.to_string_lossy())));
    }

    #[test]
    fn missing_link_is_skipped_not_an_error() {
        let dir = base_dir("ghost");
        let base = dir.join("base");
        fs::create_dir_all(&base).unwrap();
        write(&base, "root.md", "[[ghost]] and [[real]]");
        write(&base, "real.md", "real body");

        let bundle = bundle_to_string(&base.join("root.md").to_string_lossy()).unwrap();
        assert!(bundle.contains("path=\"real.md\""));
        // The missing link is skipped: no <document> is emitted for it. (The raw
        // `[[ghost]]` text survives in the root's verbatim body — that's the
        // body, not a resolved document — so we assert on the path= attribute.)
        assert!(
            !bundle.contains("path=\"ghost.md\""),
            "missing link must not become a document:\n{bundle}"
        );
    }

    #[test]
    fn empty_graph_bundles_root_only() {
        let dir = base_dir("solo");
        let base = dir.join("base");
        fs::create_dir_all(&base).unwrap();
        write(&base, "root.md", "no links here");
        let bundle = bundle_to_string(&base.join("root.md").to_string_lossy()).unwrap();
        assert!(bundle.starts_with("<documents>"));
        assert!(bundle.contains("path=\"root.md\" title=\"root\""));
        assert_eq!(bundle.matches("<document ").count(), 1, "root only:\n{bundle}");
    }

    #[test]
    fn body_is_inserted_verbatim_without_escaping() {
        let dir = base_dir("raw");
        let base = dir.join("base");
        fs::create_dir_all(&base).unwrap();
        write(&base, "root.md", "a < b && c > d ```code [[x]]```");
        write(&base, "x.md", "x body");
        let bundle = bundle_to_string(&base.join("root.md").to_string_lossy()).unwrap();
        // raw `<`, `&`, `>` preserved (no XML-escaping of the body).
        assert!(bundle.contains("a < b && c > d"), "body must be raw:\n{bundle}");
    }

    #[test]
    fn unreadable_root_is_an_error() {
        let dir = base_dir("noroot");
        let missing = dir.join("does-not-exist.md");
        let err = bundle_to_string(&missing.to_string_lossy()).unwrap_err();
        assert!(err.contains("bundle read"), "root error message: {err}");
    }
}
