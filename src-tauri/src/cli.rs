use std::path::{Path, PathBuf};

#[derive(Debug, PartialEq)]
pub enum CliError {
    Missing,
    NotFound(PathBuf),
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
}
