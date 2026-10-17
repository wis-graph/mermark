//! Opens a local file in an external app: the OS default, macOS Preview.app,
//! or the system default browser.
//!
//! All decisions are made on the canonical path (symlinks resolved), and the
//! canonical path is what gets launched.
//!
//! Security posture: the webview chooses only a path and one of three closed
//! enum values ([`ExternalApp`]); the program to launch is always resolved
//! here, in Rust (`com.apple.Preview` bundle id, or the https default
//! handler). Paths must be absolute regular files, so `.app` bundles (which
//! are directories) and `-flag`-looking relative args are rejected. For the
//! `Default` target, launcher extensions (`.command`, `.exe`, ...) are
//! refused to break the `write_file` -> open execution chain. Remaining risk
//! (documented, not handled): an extensionless +x file opens in Terminal on
//! macOS; an exec-bit check is rejected because exFAT/SMB/NTFS mounts report
//! 0777 for everything.

use std::path::{Path, PathBuf};

/// Which program opens the file. Wire values: "default" | "preview" | "browser".
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ExternalApp {
    Default,
    Preview,
    Browser,
}

/// SSOT: extensions whose "open" means "execute" or "navigate somewhere".
/// Compared lowercase, last extension only, after [`strip_trailing_dots_and_spaces`].
/// A denylist cannot be exhaustive; it is defense in depth for the
/// `write_file` -> open chain.
const LAUNCHER_EXTENSIONS: &[&str] = &[
    // macOS: executables, scripts, installers
    "command", "tool", "terminal", "app", "workflow", "scpt", "scptd", "applescript", "pkg", "mpkg",
    "jar", "py", "pyw",
    // macOS: link files (open = navigate to an arbitrary URL/file, bypassing the URL allowlist)
    "webloc", "inetloc", "fileloc",
    // Windows: executables, scripts, installers
    "exe", "bat", "cmd", "com", "msi", "msp", "ps1", "psm1", "vbs", "vbe", "js", "jse", "wsf", "wsh",
    "ws", "wsc", "sct", "scr", "pif", "hta", "inf", "reg", "application", "appx", "msix",
    // Windows: shortcuts, control panel / MMC / shell objects
    "lnk", "url", "website", "scf", "cpl", "msc", "chm", "appref-ms", "settingcontent-ms",
    "library-ms", "search-ms",
    // Linux
    "desktop",
];

/// Win32 path normalization drops trailing dots/spaces (`a.bat.` opens `a.bat`).
fn strip_trailing_dots_and_spaces(name: &str) -> &str {
    name.trim_end_matches(['.', ' '])
}

/// Absolute path to an existing regular file; directories (incl. `.app`) are rejected.
pub fn ensure_openable_file(path: &str) -> Result<PathBuf, String> {
    let p = PathBuf::from(path);
    if p.is_absolute() && p.is_file() {
        Ok(p)
    } else {
        Err(format!("열 수 있는 파일이 아닙니다: {path}"))
    }
}

/// The file that will really be opened: [`ensure_openable_file`] followed by
/// `canonicalize`, so symlinks and `..` are resolved. Every safety decision
/// and the launch itself must use this path, never the requested one.
pub fn resolve_openable_file(path: &str) -> Result<PathBuf, String> {
    let requested = ensure_openable_file(path)?;
    std::fs::canonicalize(&requested).map_err(|e| format!("열 수 있는 파일이 아닙니다: {path} ({e})"))
}

/// True when the last extension (case-insensitive, ignoring trailing dots/spaces)
/// is in the launcher list.
pub fn is_launcher_file(path: &Path) -> bool {
    path.file_name()
        .and_then(|n| n.to_str())
        .map(strip_trailing_dots_and_spaces)
        .and_then(|n| Path::new(n).extension())
        .and_then(|e| e.to_str())
        .map(|e| LAUNCHER_EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

/// True when any ancestor directory is an `.app` bundle (case-insensitive).
pub fn is_inside_app_bundle(path: &Path) -> bool {
    path.ancestors().skip(1).any(|a| {
        a.extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case("app"))
    })
}

/// Domain rule: the `Default` target must not open launchers or bundle
/// interiors. Expects the canonical path from [`resolve_openable_file`].
pub fn refuses_default_open(canonical: &Path) -> bool {
    is_launcher_file(canonical) || is_inside_app_bundle(canonical)
}

/// Resolves the program for `target`; `Ok(None)` means "OS default".
pub fn resolve_app_for(target: ExternalApp) -> Result<Option<PathBuf>, String> {
    match target {
        ExternalApp::Default => Ok(None),
        ExternalApp::Preview => platform::preview_app().map(Some),
        ExternalApp::Browser => platform::default_browser_app().map(Some),
    }
}

/// Validates, resolves the program, and launches it.
pub fn open_in_external_app(path: &str, target: ExternalApp) -> Result<(), String> {
    let file = resolve_openable_file(path)?;
    if target == ExternalApp::Default && refuses_default_open(&file) {
        return Err("실행 파일은 기본 앱으로 열 수 없습니다".to_string());
    }
    let app = resolve_app_for(target)?;
    tauri_plugin_opener::open_path(&file, app.map(|p| p.to_string_lossy().into_owned()))
        .map_err(|e| e.to_string())
}

#[cfg(target_os = "macos")]
mod platform {
    use objc2_app_kit::NSWorkspace;
    use objc2_foundation::{NSString, NSURL};
    use std::path::PathBuf;

    fn nsurl_path(u: &NSURL) -> Option<PathBuf> {
        u.path().map(|p| PathBuf::from(p.to_string()))
    }

    pub fn preview_app() -> Result<PathBuf, String> {
        let ws = NSWorkspace::sharedWorkspace();
        let url = ws.URLForApplicationWithBundleIdentifier(&NSString::from_str("com.apple.Preview"));
        url.and_then(|u| nsurl_path(&u)).ok_or_else(|| "미리보기 앱을 찾을 수 없습니다".to_string())
    }

    pub fn default_browser_app() -> Result<PathBuf, String> {
        let ws = NSWorkspace::sharedWorkspace();
        let probe = NSURL::URLWithString(&NSString::from_str("https://example.com"));
        let url = probe.and_then(|u| ws.URLForApplicationToOpenURL(&u));
        url.and_then(|u| nsurl_path(&u)).ok_or_else(|| "기본 브라우저를 찾을 수 없습니다".to_string())
    }
}

#[cfg(not(target_os = "macos"))]
mod platform {
    use std::path::PathBuf;

    pub fn preview_app() -> Result<PathBuf, String> {
        Err("macOS에서만 지원합니다".to_string())
    }

    pub fn default_browser_app() -> Result<PathBuf, String> {
        Err("macOS에서만 지원합니다".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn scratch(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("mermark-extopen-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn external_app_deserializes_only_closed_lowercase_set() {
        for (s, v) in [("default", ExternalApp::Default), ("preview", ExternalApp::Preview), ("browser", ExternalApp::Browser)] {
            assert_eq!(serde_json::from_str::<ExternalApp>(&format!("\"{s}\"")).unwrap(), v);
        }
        for bad in ["\"Preview\"", "\"calc\"", "\"\"", "\"/Applications/Calculator.app\""] {
            assert!(serde_json::from_str::<ExternalApp>(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn ensure_openable_file_rules() {
        assert!(ensure_openable_file("a.png").is_err());
        assert!(ensure_openable_file("-a").is_err());
        let d = scratch("ensure");
        assert!(ensure_openable_file(d.join("nope.png").to_str().unwrap()).is_err());
        assert!(ensure_openable_file(d.to_str().unwrap()).is_err());
        let f = d.join("a.png");
        fs::write(&f, b"x").unwrap();
        assert_eq!(ensure_openable_file(f.to_str().unwrap()).unwrap(), f);
        let bundle = d.join("Foo.app");
        fs::create_dir(&bundle).unwrap();
        assert!(ensure_openable_file(bundle.to_str().unwrap()).is_err());
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn launcher_detection_uses_last_extension_case_insensitively() {
        for y in ["x.command", "X.COMMAND", "a.scpt", "b.exe", "c.ps1", "a.txt.command"] {
            assert!(is_launcher_file(Path::new(y)), "{y}");
        }
        for n in ["a.png", "a.pdf", "a.md", "noext", "a.command.txt"] {
            assert!(!is_launcher_file(Path::new(n)), "{n}");
        }
    }

    #[test]
    fn resolve_default_is_none() {
        assert_eq!(resolve_app_for(ExternalApp::Default), Ok(None));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn resolve_preview_points_at_preview_app() {
        let p = resolve_app_for(ExternalApp::Preview).unwrap().unwrap();
        assert!(p.to_string_lossy().ends_with("Preview.app"), "{p:?}");
    }

    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "depends on the machine's default browser"]
    fn resolve_browser_points_at_an_app_bundle() {
        let p = resolve_app_for(ExternalApp::Browser).unwrap().unwrap();
        assert_eq!(p.extension().and_then(|e| e.to_str()), Some("app"));
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn resolve_preview_browser_unsupported_off_macos() {
        for t in [ExternalApp::Preview, ExternalApp::Browser] {
            assert_eq!(resolve_app_for(t), Err("macOS에서만 지원합니다".to_string()));
        }
    }

    #[test]
    fn open_rejects_launchers_and_directories_without_launching() {
        let d = scratch("open");
        let l = d.join("x.command");
        fs::write(&l, b"#!/bin/sh").unwrap();
        let e = open_in_external_app(l.to_str().unwrap(), ExternalApp::Default).unwrap_err();
        assert!(e.starts_with("실행 파일은"), "{e}");
        assert!(open_in_external_app(d.to_str().unwrap(), ExternalApp::Default).is_err());
        assert!(open_in_external_app("rel.png", ExternalApp::Preview).is_err());
        let _ = fs::remove_dir_all(&d);
    }

    #[cfg(unix)]
    mod symlink_and_list {
        use super::*;
        use std::os::unix::fs::symlink;

        fn refused(requested: &Path) -> bool {
            let c = resolve_openable_file(requested.to_str().unwrap()).unwrap();
            refuses_default_open(&c)
        }

        #[test]
        fn symlink_to_launcher_is_refused() {
            let d = scratch("sym-launcher");
            fs::write(d.join("evil.command"), b"#!/bin/sh").unwrap();
            symlink(d.join("evil.command"), d.join("pic.png")).unwrap();
            assert!(refused(&d.join("pic.png")));
            let _ = fs::remove_dir_all(&d);
        }

        #[test]
        fn symlink_to_executable_inside_app_bundle_is_refused() {
            let d = scratch("sym-bundle");
            let macos = d.join("Foo.app/Contents/MacOS");
            fs::create_dir_all(&macos).unwrap();
            fs::write(macos.join("Foo"), b"\x7fELF").unwrap();
            symlink(macos.join("Foo"), d.join("a.png")).unwrap();
            assert!(refused(&d.join("a.png")));
            assert!(refused(&macos.join("Foo")));
            let _ = fs::remove_dir_all(&d);
        }

        #[test]
        fn symlink_to_plain_file_is_allowed_and_resolves_to_real_path() {
            let d = scratch("sym-ok");
            fs::write(d.join("real.png"), b"x").unwrap();
            symlink(d.join("real.png"), d.join("a.png")).unwrap();
            let c = resolve_openable_file(d.join("a.png").to_str().unwrap()).unwrap();
            assert_eq!(c, fs::canonicalize(d.join("real.png")).unwrap());
            assert!(!refuses_default_open(&c));
            let _ = fs::remove_dir_all(&d);
        }

        #[test]
        fn uppercase_launcher_extension_is_refused_via_symlink() {
            let d = scratch("sym-upper");
            fs::write(d.join("E.COMMAND"), b"#!/bin/sh").unwrap();
            symlink(d.join("E.COMMAND"), d.join("b.txt")).unwrap();
            assert!(refused(&d.join("b.txt")));
            let _ = fs::remove_dir_all(&d);
        }
    }

    #[test]
    fn launcher_list_covers_audit_additions() {
        for y in [
            "a.webloc", "a.inetloc", "a.fileloc", "a.jar", "a.py", "a.pyw",
            "a.url", "a.cpl", "a.msc", "a.scf", "a.chm", "a.reg", "a.appref-ms",
            "a.website", "a.msp", "a.pif", "a.inf", "a.application", "a.settingcontent-ms",
            "a.library-ms", "a.search-ms", "a.wsc", "a.sct", "a.ws", "a.psm1", "a.appx", "a.msix",
            "a.desktop",
        ] {
            assert!(is_launcher_file(Path::new(y)), "{y}");
        }
    }

    #[test]
    fn launcher_detection_ignores_trailing_dots_and_spaces() {
        for y in ["a.bat.", "a.bat ", "a.bat. .", "A.BAT  "] {
            assert!(is_launcher_file(Path::new(y)), "{y:?}");
        }
        assert!(!is_launcher_file(Path::new("a.png.")));
    }

    #[test]
    fn bundle_interior_detection_uses_ancestor_app_dirs() {
        assert!(is_inside_app_bundle(Path::new("/x/Foo.APP/Contents/MacOS/Foo")));
        assert!(!is_inside_app_bundle(Path::new("/x/Foo.apple/a.png")));
        assert!(!is_inside_app_bundle(Path::new("/x/y/a.png")));
    }
}
