use std::path::{Path, PathBuf};

#[derive(Debug, PartialEq)]
pub enum CliError {
    Missing,
    NotFound(PathBuf),
}

/// The launch intent parsed from the process argv: which file to open and
/// whether the window should claim the right half of the screen (`--right`).
/// Geometry decisions live in `lib.rs`; this struct only carries the facts.
#[derive(Debug, PartialEq)]
pub struct LaunchArgs {
    pub target: PathBuf,
    pub right: bool,
}

/// True when an argv token is a flag rather than a positional file argument.
/// Anything starting with `--` is a flag; only `--right` carries meaning, the
/// rest are silently ignored (see `parse_args`). Keeping this a named predicate
/// keeps the flag-vs-file rule out of inline conditions.
fn is_flag(arg: &str) -> bool {
    arg.starts_with("--")
}

/// Split argv into the recognized `--right` flag plus positional file
/// arguments, then resolve the first positional via `resolve_target`. The flag
/// may appear anywhere (`mermark --right f.md` and `mermark f.md --right` are
/// equivalent); unknown `--xxx` flags are dropped silently so the scope stays
/// limited to `--right`. `cwd` is injected for testability.
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
    let target = resolve_target(&positionals, cwd)?;
    Ok(LaunchArgs { target, right })
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
        assert_eq!(got.target, dir.join("a.md"));
        assert!(!got.right);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn flag_before_file_sets_right() {
        let dir = fixture_dir("flag_before");
        let got = parse_args(&["--right".into(), "a.md".into()], &dir).unwrap();
        assert_eq!(got.target, dir.join("a.md"));
        assert!(got.right);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn flag_after_file_sets_right() {
        // Flag position is irrelevant: `mermark a.md --right`.
        let dir = fixture_dir("flag_after");
        let got = parse_args(&["a.md".into(), "--right".into()], &dir).unwrap();
        assert_eq!(got.target, dir.join("a.md"));
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
        assert_eq!(got.target, dir.join("a.md"));
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
        assert_eq!(got.target, abs);
        assert!(got.right);
        fs::remove_dir_all(&dir).ok();
    }
}
