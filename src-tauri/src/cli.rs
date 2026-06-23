use std::path::{Path, PathBuf};

#[derive(Debug, PartialEq)]
pub enum CliError {
    Missing,
    NotFound(PathBuf),
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

/// Split argv into the recognized `--right` flag plus positional file
/// arguments, then classify the first positional. If it is the stdin token
/// (`-`) the target is `Target::Stdin` and `resolve_target` is *not* called (no
/// filesystem access for a token that isn't a real path); otherwise the first
/// positional is resolved to an existing file. The flag may appear anywhere
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

/// Resolve the first file argument to an absolute, existing file path.
/// `cwd` is injected for testability.
pub fn resolve_target(args: &[String], cwd: &Path) -> Result<PathBuf, CliError> {
    let raw = args.first().ok_or(CliError::Missing)?;
    let p = Path::new(raw);
    let abs = if p.is_absolute() { p.to_path_buf() } else { cwd.join(p) };
    if abs.is_file() {
        Ok(abs)
    } else {
        Err(CliError::NotFound(abs))
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
    fn nonexistent_file_errors() {
        let cwd = std::env::temp_dir();
        match resolve_target(&["nope_xyz.md".into()], &cwd) {
            Err(CliError::NotFound(_)) => {}
            other => panic!("expected NotFound, got {other:?}"),
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
    fn nonexistent_positional_is_not_found() {
        let cwd = std::env::temp_dir();
        match parse_args(&["nope_xyz.md".into()], &cwd) {
            Err(CliError::NotFound(_)) => {}
            other => panic!("expected NotFound, got {other:?}"),
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
}
