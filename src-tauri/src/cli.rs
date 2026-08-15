use std::path::{Path, PathBuf};

#[derive(Debug, PartialEq)]
pub enum CliError {
    Missing,
    IsDirectory(PathBuf),
}

/// Where the editor should read its document from. `parse_args` classifies the
/// launch intent into one of these without performing any I/O: `Stdin` means the
/// first positional was the `-` token (vim's piped-stdin convention) and the
/// caller must read piped stdin into a scratch file; `File` is a path already
/// resolved against the cwd by `resolve_target`. Keeping the intent in an enum
/// rather than a sentinel `PathBuf` lets `lib.rs` branch on a name (`match`)
/// instead of inspecting magic path values.
#[derive(Debug, PartialEq)]
pub enum Target {
    Stdin,
    File(PathBuf),
}

/// The launch intent parsed from the process argv: where to read the document
/// from and whether the window should claim the right half of the screen
/// (`--right`). Geometry and stdin I/O decisions live in `lib.rs`; this struct
/// only carries the facts.
#[derive(Debug, PartialEq)]
pub struct LaunchArgs {
    pub target: Target,
    pub right: bool,
}

/// True when an argv token is a flag rather than a positional file argument.
/// Anything starting with `--` is a flag; only `--right` carries meaning, the
/// rest are silently ignored (see `parse_args`). Keeping this a named predicate
/// keeps the flag-vs-file rule out of inline conditions.
fn is_flag(arg: &str) -> bool {
    arg.starts_with("--")
}

/// True when an argv token is the single-dash stdin marker (`-`). By the vim
/// convention, `mermark -` means "read the document from piped stdin" rather
/// than open a file literally named `-`. Sits next to `is_flag` so the whole
/// argv-token classification rule lives in one place; named so `parse_args`
/// reads "first positional is the stdin token" instead of an inline `== "-"`.
fn is_stdin_token(arg: &str) -> bool {
    arg == "-"
}

/// True when argv carries a version flag (`-v` or `--version`), anywhere in
/// the argument list. This is a *pure query*, deliberately outside
/// `parse_args`/`is_flag`: `-v` is single-dash, so it would otherwise be
/// treated as a positional file argument (`is_flag` only recognizes `--`),
/// and `--version` would just join the pile of silently-ignored unknown
/// `--xxx` flags. `lib.rs` checks this before any of that parsing runs, so a
/// version request short-circuits straight to printing and exit — no window,
/// no file resolution.
pub fn is_version_flag(args: &[String]) -> bool {
    args.iter().any(|a| a == "-v" || a == "--version")
}

/// Split argv into the recognized `--right` flag plus positional file
/// arguments, then classify the first positional. If it is the stdin token
/// (`-`) the target is `Target::Stdin` and `resolve_target` is *not* called (no
/// filesystem access for a token that isn't a real path); otherwise the first
/// positional is resolved to a file path (existing or to-be-created; a directory
/// is rejected). The flag may appear anywhere
/// (`mermark --right f.md` and `mermark f.md --right` are equivalent); unknown
/// `--xxx` flags are dropped silently so the scope stays limited to `--right`.
/// This stays a pure query (no I/O) — stdin reading is the caller's effect in
/// `lib.rs`. `cwd` is injected for testability.
pub fn parse_args(args: &[String], cwd: &Path) -> Result<LaunchArgs, CliError> {
    let mut right = false;
    let mut positionals: Vec<String> = Vec::new();
    for arg in args {
        if is_flag(arg) {
            if arg == "--right" {
                right = true;
            }
            // Unknown flags are intentionally ignored.
        } else {
            positionals.push(arg.clone());
        }
    }
    // First positional wins (matching resolve_target's `.first()` contract). If
    // it is the stdin token, the intent is piped stdin and we skip path
    // resolution entirely; any further positionals are ignored as before.
    if positionals.first().is_some_and(|a| is_stdin_token(a)) {
        return Ok(LaunchArgs { target: Target::Stdin, right });
    }
    let path = resolve_target(&positionals, cwd)?;
    Ok(LaunchArgs { target: Target::File(path), right })
}

/// The two `LaunchClass::Headless` reasons a process prints to stdout/stderr
/// and exits with no window at all.
#[derive(Debug, PartialEq)]
pub enum Headless {
    Version,
    Bundle,
}

/// Which launch pipeline this process's argv selects, decided once in
/// `lib.rs::run()` *before* `tauri::Builder` is constructed — the classifier
/// runs, then `run()` builds the app around the answer, never the other way
/// around. This ordering is load-bearing: `Isolated` processes must never
/// install the single-instance plugin (`LaunchClass::joins_singleton`), and
/// the only way to guarantee that is to know the class before the plugin
/// would be installed, not after.
#[derive(Debug, PartialEq)]
pub enum LaunchClass {
    /// No window: print to stdout/stderr and exit (`--version` / `bundle`).
    Headless(Headless),
    /// Independent process, independent window: piped stdin (`-`) or an
    /// explicit `--right` placement. Never installs the singleton plugin, so
    /// it can never be intercepted by a running instance — installation
    /// itself is the only thing that could route it away.
    Isolated(LaunchArgs),
    /// Wants to participate in the running singleton (or become it): an
    /// ordinary file open (`Some`) or a bare launch with no document
    /// (`None`, which still joins — it's "singleton, no file", not "no
    /// singleton").
    SingletonRouted(Option<PathBuf>),
}

impl LaunchClass {
    /// True only for `SingletonRouted` — the single fact `run()` gates
    /// installing the single-instance plugin on. Keeping this as one named
    /// predicate (rather than re-deriving "is this isolated" at each call
    /// site) means the isolated-launch guarantee lives behind one name that
    /// a unit test can lock down directly, rather than being implied by
    /// several `match` arms staying in sync by convention.
    pub fn joins_singleton(&self) -> bool {
        matches!(self, LaunchClass::SingletonRouted(_))
    }

    /// The file path this class wants opened/created *before* any window
    /// exists, if any. `Isolated(File)` and `SingletonRouted(Some)` share
    /// this pre-builder "create on launch" step (vim's `:e newfile.md`
    /// convention, performed by `lib.rs::ensure_file_target`); every other
    /// variant — `Isolated(Stdin)`, `SingletonRouted(None)`, and all of
    /// `Headless` — has no file to create ahead of the window.
    pub fn file_target(&self) -> Option<&Path> {
        match self {
            LaunchClass::Isolated(LaunchArgs { target: Target::File(p), .. }) => Some(p),
            LaunchClass::SingletonRouted(Some(p)) => Some(p),
            _ => None,
        }
    }
}

/// Classify this process's launch intent, pure and I/O-free: reuses
/// `is_version_flag` and `crate::is_bundle_subcommand` for the two headless
/// cases (version wins over bundle, matching `run()`'s pre-existing
/// priority), then delegates the rest to `parse_args`. A missing argument
/// (`CliError::Missing`) is *not* propagated as an error here — a bare
/// `mermark` launch is a valid intent ("join the singleton, no document"),
/// so it's absorbed into `SingletonRouted(None)`. Only `IsDirectory`
/// propagates, since the caller (`run()`, or the primary process's secondary
/// invocation handler) is the one with a terminal/exit code to report it to.
pub fn classify_launch(args: &[String], cwd: &Path) -> Result<LaunchClass, CliError> {
    if is_version_flag(args) {
        return Ok(LaunchClass::Headless(Headless::Version));
    }
    if crate::is_bundle_subcommand(args) {
        return Ok(LaunchClass::Headless(Headless::Bundle));
    }
    match parse_args(args, cwd) {
        Ok(parsed @ LaunchArgs { target: Target::Stdin, .. }) => Ok(LaunchClass::Isolated(parsed)),
        Ok(parsed @ LaunchArgs { right: true, .. }) => Ok(LaunchClass::Isolated(parsed)),
        Ok(LaunchArgs { target: Target::File(p), right: false }) => {
            Ok(LaunchClass::SingletonRouted(Some(p)))
        }
        Err(CliError::Missing) => Ok(LaunchClass::SingletonRouted(None)),
        Err(e) => Err(e),
    }
}

/// Resolve the first positional argument to an absolute *file* path to open.
/// The path may already exist or be created on launch (vim's `:e newfile`
/// convention), so a missing path is a valid target — only a directory is
/// rejected, since a directory can't be opened as a document. `cwd` is injected
/// for testability. No file is created here; `lib.rs` performs that effect after
/// resolution, keeping this a pure (read-only) classification.
pub fn resolve_target(args: &[String], cwd: &Path) -> Result<PathBuf, CliError> {
    let raw = args.first().ok_or(CliError::Missing)?;
    let p = Path::new(raw);
    let abs = if p.is_absolute() { p.to_path_buf() } else { cwd.join(p) };
    if abs.is_dir() {
        Err(CliError::IsDirectory(abs))
    } else {
        Ok(abs)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    // --- resolve_target (kept: parse_args delegates path resolution here) ---

    #[test]
    fn missing_arg_errors() {
        let cwd = std::env::temp_dir();
        assert_eq!(resolve_target(&[], &cwd), Err(CliError::Missing));
    }

    #[test]
    fn relative_path_resolved_against_cwd() {
        let dir = std::env::temp_dir().join("mermark_test_rel");
        fs::create_dir_all(&dir).unwrap();
        let f = dir.join("a.md");
        fs::write(&f, "# hi").unwrap();
        let got = resolve_target(&["a.md".into()], &dir).unwrap();
        assert_eq!(got, f);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn nonexistent_file_resolves_for_creation() {
        // vim `:e newfile.md`: a path that doesn't exist yet is a valid target;
        // lib.rs creates it on launch. resolve_target must return the absolute
        // path (joined against cwd) rather than erroring.
        let cwd = std::env::temp_dir();
        let got = resolve_target(&["nope_xyz.md".into()], &cwd).unwrap();
        assert_eq!(got, cwd.join("nope_xyz.md"));
    }

    #[test]
    fn existing_file_resolves() {
        // An existing file stays a valid target (no regression): it resolves to
        // its absolute path so lib.rs's create call no-ops and opens it as-is.
        let dir = std::env::temp_dir().join("mermark_test_existing");
        fs::create_dir_all(&dir).unwrap();
        let f = dir.join("here.md");
        fs::write(&f, "# hi").unwrap();
        assert_eq!(resolve_target(&["here.md".into()], &dir).unwrap(), f);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn directory_is_rejected() {
        // A directory can't be opened as a document, so it's the one path kind
        // resolve_target refuses (the temp dir itself always exists as a dir).
        let cwd = std::env::temp_dir();
        match resolve_target(&[cwd.to_string_lossy().into_owned()], &cwd) {
            Err(CliError::IsDirectory(_)) => {}
            other => panic!("expected IsDirectory, got {other:?}"),
        }
    }

    // --- parse_args ---

    /// Each parse_args test gets an isolated dir so a real file exists to
    /// resolve, mirroring the resolve_target test hygiene (PID-keyed cleanup).
    fn fixture_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir()
            .join(format!("mermark_parse_{}_{tag}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("a.md"), "# hi").unwrap();
        dir
    }

    #[test]
    fn file_only_defaults_right_false() {
        let dir = fixture_dir("file_only");
        let got = parse_args(&["a.md".into()], &dir).unwrap();
        assert_eq!(got.target, Target::File(dir.join("a.md")));
        assert!(!got.right);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn flag_before_file_sets_right() {
        let dir = fixture_dir("flag_before");
        let got = parse_args(&["--right".into(), "a.md".into()], &dir).unwrap();
        assert_eq!(got.target, Target::File(dir.join("a.md")));
        assert!(got.right);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn flag_after_file_sets_right() {
        // Flag position is irrelevant: `mermark a.md --right`.
        let dir = fixture_dir("flag_after");
        let got = parse_args(&["a.md".into(), "--right".into()], &dir).unwrap();
        assert_eq!(got.target, Target::File(dir.join("a.md")));
        assert!(got.right);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn right_flag_without_file_is_missing() {
        let cwd = std::env::temp_dir();
        assert_eq!(parse_args(&["--right".into()], &cwd), Err(CliError::Missing));
    }

    #[test]
    fn empty_args_is_missing() {
        let cwd = std::env::temp_dir();
        assert_eq!(parse_args(&[], &cwd), Err(CliError::Missing));
    }

    #[test]
    fn nonexistent_positional_is_a_file_target() {
        // A to-be-created file flows through parse_args as a File target (lib.rs
        // creates it on launch); it is no longer a fatal error.
        let cwd = std::env::temp_dir();
        let got = parse_args(&["nope_xyz.md".into()], &cwd).unwrap();
        assert_eq!(got.target, Target::File(cwd.join("nope_xyz.md")));
        assert!(!got.right);
    }

    #[test]
    fn nonexistent_positional_with_right_flag() {
        // `mermark --right newfile.md`: window geometry is orthogonal to whether
        // the file already exists, so --right rides along with a to-be-created
        // File target.
        let cwd = std::env::temp_dir();
        let got = parse_args(&["--right".into(), "nope_xyz.md".into()], &cwd).unwrap();
        assert_eq!(got.target, Target::File(cwd.join("nope_xyz.md")));
        assert!(got.right);
    }

    #[test]
    fn directory_positional_is_rejected() {
        // parse_args delegates directory rejection to resolve_target: opening a
        // directory as a document is impossible, so it surfaces as IsDirectory.
        let cwd = std::env::temp_dir();
        match parse_args(&[cwd.to_string_lossy().into_owned()], &cwd) {
            Err(CliError::IsDirectory(_)) => {}
            other => panic!("expected IsDirectory, got {other:?}"),
        }
    }

    #[test]
    fn unknown_flag_is_ignored() {
        // `--unknown` is silently dropped; the file still resolves and
        // `--right` is absent so right stays false.
        let dir = fixture_dir("unknown_flag");
        let got = parse_args(&["--unknown".into(), "a.md".into()], &dir).unwrap();
        assert_eq!(got.target, Target::File(dir.join("a.md")));
        assert!(!got.right);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn absolute_path_with_flag_resolves() {
        let dir = fixture_dir("abs_path");
        let abs = dir.join("a.md");
        let got = parse_args(
            &[abs.to_string_lossy().into_owned(), "--right".into()],
            &std::env::temp_dir(),
        )
        .unwrap();
        assert_eq!(got.target, Target::File(abs));
        assert!(got.right);
        fs::remove_dir_all(&dir).ok();
    }

    // --- stdin token classification (`-`) ---

    #[test]
    fn stdin_token_yields_stdin_target() {
        // `mermark -` classifies as piped stdin; no filesystem access happens,
        // so a real cwd fixture isn't needed (and `-` is never a real file).
        let cwd = std::env::temp_dir();
        let got = parse_args(&["-".into()], &cwd).unwrap();
        assert_eq!(got.target, Target::Stdin);
        assert!(!got.right);
    }

    #[test]
    fn stdin_with_right_flag() {
        // `cat x | mermark - --right`: stdin target is orthogonal to --right.
        let cwd = std::env::temp_dir();
        let got = parse_args(&["-".into(), "--right".into()], &cwd).unwrap();
        assert_eq!(got.target, Target::Stdin);
        assert!(got.right);
    }

    #[test]
    fn stdin_first_positional_wins() {
        // `mermark - a.md`: first positional is `-`, so the trailing file is
        // ignored (mirrors the existing "second positional ignored" rule).
        let dir = fixture_dir("stdin_first");
        let got = parse_args(&["-".into(), "a.md".into()], &dir).unwrap();
        assert_eq!(got.target, Target::Stdin);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn file_after_dash_is_file() {
        // `mermark a.md -`: first positional is the file, so `-` is ignored and
        // this resolves to a normal File target (no stdin).
        let dir = fixture_dir("file_after_dash");
        let got = parse_args(&["a.md".into(), "-".into()], &dir).unwrap();
        assert_eq!(got.target, Target::File(dir.join("a.md")));
        fs::remove_dir_all(&dir).ok();
    }

    // --- is_version_flag ---

    #[test]
    fn version_flag_matches_long_form() {
        assert!(is_version_flag(&["--version".into()]));
    }

    #[test]
    fn version_flag_matches_short_form() {
        assert!(is_version_flag(&["-v".into()]));
    }

    #[test]
    fn version_flag_matches_at_any_position() {
        assert!(is_version_flag(&["a.md".into(), "--version".into()]));
    }

    #[test]
    fn version_flag_absent_is_false() {
        assert!(!is_version_flag(&["--right".into(), "a.md".into()]));
    }

    #[test]
    fn version_flag_empty_args_is_false() {
        assert!(!is_version_flag(&[]));
    }

    #[test]
    fn version_flag_requires_exact_match() {
        // Similar-looking tokens must not false-positive: `-vim` isn't `-v`,
        // and `--versionx` isn't `--version`.
        assert!(!is_version_flag(&["-vim".into()]));
        assert!(!is_version_flag(&["--versionx".into()]));
    }

    // --- classify_launch (single-window-opening Todo 2) ---

    #[test]
    fn classify_stdin_is_isolated() {
        let cwd = std::env::temp_dir();
        let got = classify_launch(&["-".into()], &cwd).unwrap();
        assert_eq!(got, LaunchClass::Isolated(LaunchArgs { target: Target::Stdin, right: false }));
    }

    #[test]
    fn classify_right_is_isolated_and_keeps_right() {
        // `LaunchArgs.right` must survive the reclassification into
        // `Isolated` — losing it was exactly the bug that got
        // `secondary_launch_path()` deleted (see 00_request_todo2.md).
        let dir = fixture_dir("classify_right");
        let got = classify_launch(&["--right".into(), "a.md".into()], &dir).unwrap();
        assert_eq!(
            got,
            LaunchClass::Isolated(LaunchArgs { target: Target::File(dir.join("a.md")), right: true })
        );
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn classify_stdin_right_is_isolated() {
        let cwd = std::env::temp_dir();
        let got = classify_launch(&["-".into(), "--right".into()], &cwd).unwrap();
        assert_eq!(got, LaunchClass::Isolated(LaunchArgs { target: Target::Stdin, right: true }));
    }

    #[test]
    fn classify_ordinary_file_is_singleton_routed() {
        let dir = fixture_dir("classify_ordinary");
        let got = classify_launch(&["a.md".into()], &dir).unwrap();
        assert_eq!(got, LaunchClass::SingletonRouted(Some(dir.join("a.md"))));
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn classify_missing_file_is_singleton_routed() {
        // vim `:e newfile.md` convention extends to the classifier: a
        // to-be-created path still joins the singleton with a file target.
        let cwd = std::env::temp_dir();
        let got = classify_launch(&["nope_classify_xyz.md".into()], &cwd).unwrap();
        assert_eq!(got, LaunchClass::SingletonRouted(Some(cwd.join("nope_classify_xyz.md"))));
    }

    #[test]
    fn classify_no_args_is_singleton_routed_none() {
        // A bare `mermark` launch is not an error — it's "join the
        // singleton, no document", the same intent as focusing it.
        let cwd = std::env::temp_dir();
        assert_eq!(classify_launch(&[], &cwd).unwrap(), LaunchClass::SingletonRouted(None));
    }

    #[test]
    fn classify_directory_is_rejected() {
        let cwd = std::env::temp_dir();
        match classify_launch(&[cwd.to_string_lossy().into_owned()], &cwd) {
            Err(CliError::IsDirectory(_)) => {}
            other => panic!("expected IsDirectory, got {other:?}"),
        }
    }

    #[test]
    fn classify_version_wins_over_everything() {
        // Matches run()'s pre-existing priority: version short-circuits
        // ahead of even the bundle subcommand.
        let cwd = std::env::temp_dir();
        let got = classify_launch(&["--version".into(), "bundle".into()], &cwd).unwrap();
        assert_eq!(got, LaunchClass::Headless(Headless::Version));
    }

    #[test]
    fn classify_bundle_token_is_headless() {
        let cwd = std::env::temp_dir();
        let got = classify_launch(&["bundle".into(), "f.md".into()], &cwd).unwrap();
        assert_eq!(got, LaunchClass::Headless(Headless::Bundle));
    }

    #[test]
    fn classify_bundle_lookalike_file_is_singleton_routed() {
        // A file literally named `bundle.md` opened via a path (not the bare
        // `bundle` token) is an ordinary file open, not the subcommand.
        let dir = fixture_dir("classify_bundle_lookalike");
        fs::write(dir.join("bundle.md"), "# hi").unwrap();
        let got = classify_launch(&["./bundle.md".into()], &dir).unwrap();
        assert_eq!(got, LaunchClass::SingletonRouted(Some(dir.join("./bundle.md"))));
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn joins_singleton_truth_table() {
        let cwd = std::env::temp_dir();
        assert!(!LaunchClass::Headless(Headless::Version).joins_singleton());
        assert!(!LaunchClass::Headless(Headless::Bundle).joins_singleton());
        assert!(!LaunchClass::Isolated(LaunchArgs { target: Target::Stdin, right: false })
            .joins_singleton());
        assert!(!LaunchClass::Isolated(LaunchArgs {
            target: Target::File(cwd.join("a.md")),
            right: true
        })
        .joins_singleton());
        assert!(LaunchClass::SingletonRouted(Some(cwd.join("a.md"))).joins_singleton());
        assert!(LaunchClass::SingletonRouted(None).joins_singleton());
    }

    #[test]
    fn file_target_exposes_creatable_paths() {
        let cwd = std::env::temp_dir();
        let p = cwd.join("target.md");
        assert_eq!(
            LaunchClass::Isolated(LaunchArgs { target: Target::File(p.clone()), right: true })
                .file_target(),
            Some(p.as_path())
        );
        assert_eq!(LaunchClass::SingletonRouted(Some(p.clone())).file_target(), Some(p.as_path()));
        assert_eq!(
            LaunchClass::Isolated(LaunchArgs { target: Target::Stdin, right: false }).file_target(),
            None
        );
        assert_eq!(LaunchClass::SingletonRouted(None).file_target(), None);
        assert_eq!(LaunchClass::Headless(Headless::Version).file_target(), None);
    }
}
