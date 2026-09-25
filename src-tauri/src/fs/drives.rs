use std::path::{Path, PathBuf};

use super::listing::is_hidden_entry;

/// One filesystem root/volume for the explorer's "내 컴퓨터" (My Computer)
/// virtual root, shown when the user navigates `..` above a filesystem root
/// (`isFilesystemRoot` on the frontend). Same wire-shape convention as
/// `DirEntry`: no `rename_all`, so `display_name` stays snake_case on the
/// wire. Mirrored in `src/document/types.ts` and `src/mocks/tauri-core.ts`
/// (3-boundary parity).
#[derive(serde::Serialize, serde::Deserialize)]
pub struct DriveEntry {
    /// Root path to hand back to `list_dir`/`changeRoot` (`C:\`, `/`, `/Volumes/USB`).
    pub path: String,
    /// Human-facing label (`C:`, `/`, `USB`) — no volume-label lookup, kept
    /// consistent with how the root is already shown elsewhere (breadcrumb).
    pub display_name: String,
}

/// Enumerate Windows drive letters `C:` through `Z:` that exist, probing with
/// the injected `is_dir` so this stays pure and testable on any OS. **Starts
/// at `C`, not `A`**: probing legacy floppy letters (`A:`/`B:`) can stall or
/// pop a "no disk" prompt on older hardware, and modern machines have nothing
/// meaningful mapped there — a drive genuinely at A:/B: can still be opened by
/// typing the path directly (orchestrator ruling, 2026-09-21). `path` carries
/// a trailing `\` (`C:\`) — what `read_dir`/`is_dir` expect as a drive root —
/// `display_name` omits it (`C:`).
pub(crate) fn windows_drives(is_dir: impl Fn(&Path) -> bool) -> Vec<DriveEntry> {
    (b'C'..=b'Z')
        .filter_map(|letter| {
            let letter = letter as char;
            let path = PathBuf::from(format!("{letter}:\\"));
            is_dir(&path).then(|| DriveEntry {
                path: format!("{letter}:\\"),
                display_name: format!("{letter}:"),
            })
        })
        .collect()
}

/// Immediate subdirectories of each `mount_dirs` entry, excluding hidden
/// (dotfile) names — how macOS's `/Volumes` and Linux's `/media`/`/mnt` mount
/// points enumerate actual volumes. `children`/`is_dir` are injected (the real
/// caller wires `std::fs::read_dir` and `Path::is_dir`) so this stays pure.
/// Non-directory children (stray files dropped in a mount dir) are excluded.
/// Results from every `mount_dirs` entry are combined and sorted by display
/// name so two mount roots merge into one deterministic list.
pub(crate) fn mounted_volumes(
    mount_dirs: &[&str],
    children: impl Fn(&Path) -> Vec<PathBuf>,
    is_dir: impl Fn(&Path) -> bool,
) -> Vec<DriveEntry> {
    let mut entries: Vec<DriveEntry> = mount_dirs
        .iter()
        .flat_map(|dir| children(Path::new(dir)))
        .filter(|child| is_dir(child))
        .filter_map(|child| {
            let name = child.file_name()?.to_str()?.to_owned();
            if is_hidden_entry(&name) {
                return None;
            }
            Some(DriveEntry { path: child.to_string_lossy().into_owned(), display_name: name })
        })
        .collect();
    entries.sort_by(|a, b| a.display_name.cmp(&b.display_name));
    entries
}

/// Drop an entry when its canonical filesystem target duplicates an
/// *earlier* entry's — macOS mounts `/` a second time under
/// `/Volumes/<name>` via a firmlink, and this collapses that alias out of the
/// list (root itself is kept; the `/Volumes/...` duplicate is dropped).
/// `canonical_of` is injected (real caller: `std::fs::canonicalize`) so this
/// stays pure. **Fail-open**: an entry whose canonical target can't be
/// resolved (a broken/inaccessible mount) is kept rather than dropped —
/// hiding it would make a broken mount invisible instead of merely unusable.
pub(crate) fn dedupe_root_aliases(
    entries: Vec<DriveEntry>,
    canonical_of: impl Fn(&Path) -> Option<PathBuf>,
) -> Vec<DriveEntry> {
    let mut seen_canonicals = std::collections::HashSet::new();
    entries
        .into_iter()
        .filter(|entry| match canonical_of(Path::new(&entry.path)) {
            Some(canonical) => seen_canonicals.insert(canonical),
            None => true,
        })
        .collect()
}

/// IO shell for `mounted_volumes`' `children` param: a mount directory's
/// direct entries, or none when it doesn't exist/can't be read (no `/mnt` on
/// this machine is not an error — it's just an empty candidate list).
#[cfg(not(windows))]
fn read_dir_children(dir: &Path) -> Vec<PathBuf> {
    std::fs::read_dir(dir)
        .map(|entries| entries.filter_map(|e| e.ok()).map(|e| e.path()).collect())
        .unwrap_or_default()
}

/// List filesystem roots/volumes for the explorer's "내 컴퓨터" virtual root.
/// Read-only, no args, cannot fail (an unreadable mount dir simply
/// contributes no entries, per `read_dir_children`). Never cached — the
/// explorer re-queries on every entry into "내 컴퓨터" so a just-inserted USB
/// drive shows up.
pub(crate) fn list_drives() -> Vec<DriveEntry> {
    #[cfg(windows)]
    {
        windows_drives(|p| p.is_dir())
    }
    #[cfg(target_os = "macos")]
    {
        let mut candidates = vec![DriveEntry { path: "/".to_string(), display_name: "/".to_string() }];
        candidates.extend(mounted_volumes(&["/Volumes"], read_dir_children, |p| p.is_dir()));
        dedupe_root_aliases(candidates, |p| std::fs::canonicalize(p).ok())
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let mut candidates = vec![DriveEntry { path: "/".to_string(), display_name: "/".to_string() }];
        candidates.extend(mounted_volumes(&["/media", "/mnt"], read_dir_children, |p| p.is_dir()));
        candidates
    }
}

#[cfg(test)]
mod list_drives_tests {
    use super::{dedupe_root_aliases, mounted_volumes, windows_drives, DriveEntry};
    use std::path::{Path, PathBuf};

    fn names(entries: &[DriveEntry]) -> Vec<&str> {
        entries.iter().map(|e| e.display_name.as_str()).collect()
    }

    #[test]
    fn windows_drives_lists_only_existing_letters_c_through_z() {
        let got = windows_drives(|p| p == Path::new(r"C:\") || p == Path::new(r"D:\"));
        assert_eq!(got.len(), 2);
        assert_eq!(got[0].path, r"C:\");
        assert_eq!(got[0].display_name, "C:");
        assert_eq!(got[1].path, r"D:\");
        assert_eq!(got[1].display_name, "D:");
    }

    #[test]
    fn windows_drives_excludes_a_and_b_even_when_present() {
        // Ruling: A:/B: are never probed, so even an injected is_dir that
        // would accept them can't surface them — the function never asks.
        let got = windows_drives(|_| true);
        assert!(!names(&got).contains(&"A:"));
        assert!(!names(&got).contains(&"B:"));
        assert_eq!(names(&got).first(), Some(&"C:"));
        assert_eq!(names(&got).last(), Some(&"Z:"));
    }

    #[test]
    fn windows_drives_empty_when_nothing_exists() {
        assert!(windows_drives(|_| false).is_empty());
    }

    #[test]
    fn mounted_volumes_excludes_hidden_and_non_dir_children() {
        let usb = PathBuf::from("/Volumes/USB");
        let hidden = PathBuf::from("/Volumes/.hidden");
        let file = PathBuf::from("/Volumes/file.txt");
        let file_for_is_dir = file.clone();
        let got = mounted_volumes(
            &["/Volumes"],
            move |_| vec![usb.clone(), hidden.clone(), file.clone()],
            move |p| p != file_for_is_dir,
        );
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].path, "/Volumes/USB");
        assert_eq!(got[0].display_name, "USB");
    }

    #[test]
    fn mounted_volumes_empty_when_children_is_empty() {
        let got = mounted_volumes(&["/Volumes"], |_| Vec::new(), |_| true);
        assert!(got.is_empty());
    }

    #[test]
    fn mounted_volumes_merges_multiple_mount_dirs_sorted_by_name() {
        let got = mounted_volumes(
            &["/media", "/mnt"],
            |dir| {
                if dir == Path::new("/media") {
                    vec![PathBuf::from("/media/zeta")]
                } else {
                    vec![PathBuf::from("/mnt/alpha")]
                }
            },
            |_| true,
        );
        assert_eq!(names(&got), vec!["alpha", "zeta"]);
    }

    #[test]
    fn dedupe_root_aliases_drops_later_duplicate_canonical() {
        let entries = vec![
            DriveEntry { path: "/".to_string(), display_name: "/".to_string() },
            DriveEntry {
                path: "/Volumes/Macintosh HD".to_string(),
                display_name: "Macintosh HD".to_string(),
            },
            DriveEntry { path: "/Volumes/USB".to_string(), display_name: "USB".to_string() },
        ];
        let got = dedupe_root_aliases(entries, |p| match p.to_str() {
            Some("/Volumes/Macintosh HD") => Some(PathBuf::from("/")),
            Some("/Volumes/USB") => Some(PathBuf::from("/Volumes/USB")),
            Some("/") => Some(PathBuf::from("/")),
            _ => None,
        });
        assert_eq!(names(&got), vec!["/", "USB"]);
    }

    #[test]
    fn dedupe_root_aliases_keeps_entries_with_unresolvable_canonical() {
        let entries = vec![DriveEntry {
            path: "/Volumes/Broken".to_string(),
            display_name: "Broken".to_string(),
        }];
        let got = dedupe_root_aliases(entries, |_| None);
        assert_eq!(names(&got), vec!["Broken"]);
    }
}
