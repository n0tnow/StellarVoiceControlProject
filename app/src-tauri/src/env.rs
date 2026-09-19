//! Minimal `.env` loading for local development (step A1).
//!
//! The shell reads its configuration from the process environment; nothing here
//! is a source of truth. This module exists so a developer can keep secrets in a
//! **gitignored** `.env` at the repository root and still run `npm run tauri:dev`
//! (whose working directory is `app/src-tauri/`) without exporting every value by
//! hand.
//!
//! Rules that matter:
//!
//! * Values are **never logged**. The only thing ever printed is the path of the
//!   file that was read.
//! * Real environment variables win: a `.env` entry only fills a variable that is
//!   not already present, so a shell export can always override the file.
//! * A missing or malformed `.env` is not an error. The app must start anyway —
//!   step A1 treats a missing `GROQ_API_KEY` as a runtime state ("No STT key"),
//!   not a crash.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// The file name looked up while walking up the directory tree.
const ENV_FILE: &str = ".env";

/// Parses a `.env` body into key/value pairs.
///
/// Deliberately small: `KEY=value`, optional `export ` prefix, `#` comments,
/// blank lines, and single- or double-quoted values with an optional inline
/// comment after the closing quote. There is no variable interpolation — we do
/// not need it, and a half-implemented shell parser is worse than none.
pub fn parse(contents: &str) -> HashMap<String, String> {
    let mut vars = HashMap::new();
    for raw in contents.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let line = line.strip_prefix("export ").unwrap_or(line).trim_start();
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let key = key.trim();
        if key.is_empty() || key.contains(char::is_whitespace) {
            continue;
        }
        vars.insert(key.to_string(), clean_value(value.trim()));
    }
    vars
}

/// Strips matching quotes and a trailing comment from one value.
fn clean_value(value: &str) -> String {
    if let Some(rest) = value.strip_prefix('"') {
        return rest.split('"').next().unwrap_or("").to_string();
    }
    if let Some(rest) = value.strip_prefix('\'') {
        return rest.split('\'').next().unwrap_or("").to_string();
    }
    value.split('#').next().unwrap_or("").trim().to_string()
}

/// Finds the nearest `.env` at or above `start`.
///
/// Walking up is what lets the committed `app/src-tauri` working directory find
/// the repository-root `.env` without hardcoding `../..`.
pub fn find(start: &Path) -> Option<PathBuf> {
    let mut dir = Some(start);
    while let Some(current) = dir {
        let candidate = current.join(ENV_FILE);
        if candidate.is_file() {
            return Some(candidate);
        }
        dir = current.parent();
    }
    None
}

/// Applies parsed entries through injected predicates/setters, skipping any key
/// the caller reports as already present. Keeping the mutation outside makes the
/// "real environment wins" rule testable without touching the process
/// environment.
pub fn apply<F, G>(vars: HashMap<String, String>, mut is_present: F, mut set: G)
where
    F: FnMut(&str) -> bool,
    G: FnMut(&str, &str),
{
    for (key, value) in vars {
        if !is_present(&key) {
            set(&key, &value);
        }
    }
}

/// Loads the nearest `.env` (if any) into the process environment.
///
/// Call once at startup, before any key is read. Safe to call repeatedly.
pub fn load() {
    let Ok(cwd) = std::env::current_dir() else {
        return;
    };
    let Some(path) = find(&cwd) else {
        return;
    };
    let Ok(contents) = std::fs::read_to_string(&path) else {
        eprintln!("polaris: could not read {}", path.display());
        return;
    };
    // Existing environment variables are authoritative: only fill gaps.
    apply(
        parse(&contents),
        |key| std::env::var_os(key).is_some(),
        |key, value| std::env::set_var(key, value),
    );
    println!("polaris: loaded environment from {}", path.display());
}

/// Reads a non-empty environment variable, trimmed.
pub fn var(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

/// A unique scratch directory under the OS temp dir, shared by the crate's
/// tests. Tests must not depend on `tempfile` (the app does not ship it), and
/// parallel test threads make a fixed path unsafe.
#[cfg(test)]
pub(crate) fn temp_dir(label: &str) -> PathBuf {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let unique = COUNTER.fetch_add(1, Ordering::Relaxed);
    let path = std::env::temp_dir().join(format!(
        "polaris-test-{label}-{}-{unique}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&path);
    std::fs::create_dir_all(&path).unwrap();
    path
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_keys_comments_quotes_and_exports() {
        let vars = parse(
            r#"
            # a comment
            GROQ_API_KEY=sk-abc123

            export POLARIS_STT_MODEL=whisper-large-v3-turbo
            POLARIS_STT_LANGUAGE="tr"
            WITH_HASH=value#tail
            SINGLE='quoted value'
            PADDED =  spaced  
        "#,
        );
        assert_eq!(vars.get("GROQ_API_KEY").map(String::as_str), Some("sk-abc123"));
        assert_eq!(
            vars.get("POLARIS_STT_MODEL").map(String::as_str),
            Some("whisper-large-v3-turbo")
        );
        assert_eq!(vars.get("POLARIS_STT_LANGUAGE").map(String::as_str), Some("tr"));
        assert_eq!(vars.get("WITH_HASH").map(String::as_str), Some("value"));
        assert_eq!(vars.get("SINGLE").map(String::as_str), Some("quoted value"));
        assert_eq!(vars.get("PADDED").map(String::as_str), Some("spaced"));
    }

    #[test]
    fn ignores_malformed_lines_instead_of_panicking() {
        let vars = parse("NOT A KEY\n=missing-key\n\n# only a comment\nOK=1\n");
        assert_eq!(vars.len(), 1);
        assert_eq!(vars.get("OK").map(String::as_str), Some("1"));
    }

    #[test]
    fn empty_value_is_preserved_so_the_caller_can_treat_it_as_unset() {
        let vars = parse("GROQ_API_KEY=\n");
        assert_eq!(vars.get("GROQ_API_KEY").map(String::as_str), Some(""));
    }

    #[test]
    fn existing_environment_variables_are_not_overwritten() {
        // The predicates are injected, so the test never mutates the real
        // process environment (which would race with other tests).
        let mut written = Vec::new();
        apply(parse("K=new\n"), |_| true, |key, value| {
            written.push((key.to_string(), value.to_string()))
        });
        assert!(written.is_empty(), "a present variable must be left alone");

        let mut written = Vec::new();
        apply(parse("K=new\n"), |_| false, |key, value| {
            written.push((key.to_string(), value.to_string()))
        });
        assert_eq!(written, vec![("K".to_string(), "new".to_string())]);
    }

    #[test]
    fn finds_the_nearest_env_file_walking_upwards() {
        let root = temp_dir("env-walk");
        let nested = root.join("app").join("src-tauri");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(root.join(ENV_FILE), "A=1\n").unwrap();

        assert_eq!(find(&nested), Some(root.join(ENV_FILE)));

        std::fs::remove_dir_all(&root).unwrap();
    }
}
