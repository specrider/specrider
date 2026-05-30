use std::path::PathBuf;

use grep_matcher::Matcher;
use grep_regex::RegexMatcherBuilder;
use grep_searcher::sinks::UTF8;
use grep_searcher::SearcherBuilder;
use serde::Serialize;
use tauri::{State, Window};
use walkdir::WalkDir;

use crate::state::WindowsState;

/// Hard cap on the user-supplied pattern length. Vastly oversized
/// regexes are almost always a paste accident or an attack; even
/// the Rust regex engine takes meaningful compile time on a 50k-
/// character input.
pub(crate) const MAX_PATTERN_LEN: usize = 1024;
/// Mirror of `commands::MAX_PLAN_TREE_DEPTH`; same rationale —
/// hard-cap recursion so a pathological tree can't wedge a worker.
pub(crate) const MAX_TREE_DEPTH: usize = 32;
/// Cap on the compiled regex's NFA size. Defends against hostile
/// patterns that compile to gigabytes of state — `regex` is RE2-based
/// and so doesn't catastrophically backtrack at *match* time, but a
/// 50MB compile is still a denial of service.
pub(crate) const REGEX_SIZE_LIMIT: usize = 1024 * 1024;
pub(crate) const REGEX_DFA_SIZE_LIMIT: usize = 1024 * 1024;

/// Front gate for `search_plans`. Rejects empty / oversized queries
/// before any walking or compilation happens. Lifted out of the
/// command body so unit tests can hit the policy directly without
/// constructing Tauri state.
pub(crate) fn validate_query(query: &str) -> Result<(), String> {
    if query.trim().is_empty() {
        return Err("empty query".into());
    }
    if query.len() > MAX_PATTERN_LEN {
        return Err(format!(
            "search pattern too long ({} > {MAX_PATTERN_LEN} bytes)",
            query.len()
        ));
    }
    Ok(())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    /// 1-based line number where the match landed.
    pub line: u32,
    /// The full text of the matched line, trimmed.
    pub line_text: String,
    /// Byte offset where the matched substring begins within `line_text`,
    /// post-trim. Used by the frontend to bold the matched span.
    pub match_start: u32,
    pub match_end: u32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    /// Forward-slash relative path under `plansRoot`.
    pub path: String,
    pub hits: Vec<SearchHit>,
}

/// Cross-plan content search. Walks `plansRoot`, runs the matcher
/// against every `.md` file, returns up to `MAX_HITS_PER_FILE` hits
/// per file and `MAX_FILES` files in total. Empty query returns an
/// empty list (no need for a "show all" mode here).
#[tauri::command]
pub fn search_plans(
    query: String,
    case_sensitive: bool,
    whole_word: bool,
    use_regex: bool,
    window: Window,
    windows: State<'_, WindowsState>,
) -> Result<Vec<SearchResult>, String> {
    const MAX_HITS_PER_FILE: usize = 100;
    const MAX_FILES: usize = 200;
    const MAX_LINE_LEN: usize = 400;

    // Empty queries quietly return nothing (the search bar fires a
    // request on every keystroke); bad queries surface a real error.
    if query.trim().is_empty() {
        return Ok(vec![]);
    }
    validate_query(&query)?;

    let ws = windows.get_or_create(window.label());
    let root: PathBuf = match ws.plans_root.lock().unwrap().clone() {
        Some(p) => p,
        None => return Ok(vec![]),
    };
    if !root.is_dir() {
        return Ok(vec![]);
    }

    // If the user isn't using regex syntax, escape the query so
    // metacharacters in plan titles (`(`, `?`, `+`, etc) don't blow up.
    let pattern = if use_regex {
        query.clone()
    } else {
        regex_escape(&query)
    };
    let pattern = if whole_word {
        format!(r"\b(?:{pattern})\b")
    } else {
        pattern
    };

    let matcher = RegexMatcherBuilder::new()
        .case_insensitive(!case_sensitive)
        .size_limit(REGEX_SIZE_LIMIT)
        .dfa_size_limit(REGEX_DFA_SIZE_LIMIT)
        .build(&pattern)
        .map_err(|e| format!("invalid pattern: {e}"))?;

    let mut searcher = SearcherBuilder::new().line_number(true).build();

    let mut out: Vec<SearchResult> = Vec::new();

    'walk: for entry in WalkDir::new(&root)
        .follow_links(false)
        .max_depth(MAX_TREE_DEPTH)
        .into_iter()
        .filter_entry(|e| {
            e.file_name()
                .to_str()
                .is_some_and(|n| !n.starts_with('.') || e.depth() == 0)
        })
        .filter_map(|e| e.ok())
    {
        let p = entry.path();
        if !p.is_file() {
            continue;
        }
        if p.extension().and_then(|s| s.to_str()) != Some("md") {
            continue;
        }

        let rel = match p.strip_prefix(&root) {
            Ok(r) => r.to_string_lossy().replace('\\', "/"),
            Err(_) => continue,
        };

        let mut hits: Vec<SearchHit> = Vec::new();
        let m_ref = &matcher;

        let _ = searcher.search_path(
            m_ref,
            p,
            UTF8(|line_no, line| {
                if hits.len() >= MAX_HITS_PER_FILE {
                    // Stop scanning this file but keep walking the tree.
                    return Ok(false);
                }
                let trimmed = line.trim_end_matches(['\n', '\r']);
                let snippet = if trimmed.len() > MAX_LINE_LEN {
                    // MAX_LINE_LEN is a byte budget; walk back to the
                    // nearest UTF-8 char boundary so we don't slice
                    // through a multi-byte char (em dash, emoji, etc.).
                    let mut end = MAX_LINE_LEN;
                    while end > 0 && !trimmed.is_char_boundary(end) {
                        end -= 1;
                    }
                    &trimmed[..end]
                } else {
                    trimmed
                };
                if let Ok(Some(m)) = m_ref.find(snippet.as_bytes()) {
                    hits.push(SearchHit {
                        line: line_no as u32,
                        line_text: snippet.to_string(),
                        match_start: m.start() as u32,
                        match_end: m.end() as u32,
                    });
                }
                Ok(true)
            }),
        );

        if !hits.is_empty() {
            out.push(SearchResult { path: rel, hits });
            if out.len() >= MAX_FILES {
                break 'walk;
            }
        }
    }

    Ok(out)
}

fn regex_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '.' | '+' | '*' | '?' | '(' | ')' | '|' | '[' | ']' | '{' | '}' | '^' | '$' | '\\' => {
                out.push('\\');
                out.push(c);
            }
            _ => out.push(c),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_query_accepts_normal_input() {
        assert!(validate_query("hello").is_ok());
        assert!(validate_query("class Foo").is_ok());
        assert!(validate_query("(a+)+b").is_ok()); // RE2 doesn't backtrack
    }

    #[test]
    fn validate_query_rejects_oversized_patterns() {
        let huge = "a".repeat(MAX_PATTERN_LEN + 1);
        let err = validate_query(&huge).unwrap_err();
        assert!(err.contains("too long"));
    }

    #[test]
    fn validate_query_rejects_blank() {
        // Empty / whitespace-only queries are caught here so the
        // command body can short-circuit without erroring.
        assert!(validate_query("").is_err());
        assert!(validate_query("   ").is_err());
    }

    #[test]
    fn regex_size_limit_rejects_pathological_compile() {
        // Build a pattern whose compiled NFA would exceed our 1 MiB
        // budget. A long bounded-repetition with a wide character
        // class blows up size_limit before it ever gets to match.
        let pattern = format!("[a-z]{{{}}}", 100_000);
        let result = RegexMatcherBuilder::new()
            .size_limit(REGEX_SIZE_LIMIT)
            .dfa_size_limit(REGEX_DFA_SIZE_LIMIT)
            .build(&pattern);
        assert!(result.is_err(), "expected size_limit to refuse {pattern}");
    }
}
