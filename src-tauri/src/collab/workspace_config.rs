use std::collections::{BTreeMap, HashSet};
use std::fmt;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{State, Window};

use crate::state::WindowsState;

pub const WORKSPACE_CONFIG_REL: &str = ".specrider/workspace.json";
pub const WORKSPACE_CONFIG_SCHEMA_VERSION: &str = "1";
pub const WORKSPACE_CONFIG_SCHEMA_JSON: &str = include_str!("workspace_config.schema.json");

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkspaceConfig {
    pub schema_version: String,
    pub statuses: Vec<WorkspaceStatus>,
    pub review_required_signoffs: u32,
    pub default_status: String,
    /// Named linked repositories for this plans workspace. Paths are
    /// workspace-root relative; `self` is reserved for the plans repo.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub repos: BTreeMap<String, String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkspaceStatus {
    pub key: String,
    pub label: String,
    pub category: WorkspaceStatusCategory,
    #[serde(default, skip_serializing_if = "is_false")]
    pub terminal: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceStatusCategory {
    Draft,
    Active,
    Review,
    Blocked,
    Done,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum WorkspaceConfigStyle {
    Defaults,
    Lightweight,
    FullReviewFlow,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceConfigSource {
    File,
    Default,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct WorkspaceConfigSnapshot {
    pub config: WorkspaceConfig,
    pub exists: bool,
    pub path: String,
    pub source: WorkspaceConfigSource,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct WorkspaceConfigSourceSnapshot {
    pub exists: bool,
    pub path: String,
    pub source: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResolvedLinkedRepo {
    pub handle: String,
    pub path: PathBuf,
    pub configured_path: String,
}

#[derive(Debug)]
pub enum WorkspaceConfigError {
    Io { path: PathBuf, message: String },
    Json { path: PathBuf, message: String },
    Invalid { path: PathBuf, errors: Vec<String> },
    AlreadyExists(PathBuf),
    NoPlansRoot,
}

impl WorkspaceConfigError {
    fn io(path: &Path, err: std::io::Error) -> Self {
        Self::Io {
            path: path.to_path_buf(),
            message: err.to_string(),
        }
    }
}

impl fmt::Display for WorkspaceConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io { path, message } => write!(f, "{}: {message}", path.display()),
            Self::Json { path, message } => write!(f, "{}: {message}", path.display()),
            Self::Invalid { path, errors } => {
                write!(f, "{}: {}", path.display(), errors.join("; "))
            }
            Self::AlreadyExists(path) => write!(f, "{} already exists", path.display()),
            Self::NoPlansRoot => write!(f, "no documents folder configured"),
        }
    }
}

impl std::error::Error for WorkspaceConfigError {}

#[tauri::command]
pub fn get_workspace_config(
    plans_root: Option<String>,
    window: Window,
    windows: State<'_, WindowsState>,
) -> Result<WorkspaceConfigSnapshot, String> {
    let plans_root =
        plans_root_for_command(plans_root, &window, &windows).map_err(|e| e.to_string())?;
    read_workspace_config_from_root(&plans_root).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn write_workspace_config(
    style: WorkspaceConfigStyle,
    plans_root: Option<String>,
    overwrite: Option<bool>,
    window: Window,
    windows: State<'_, WindowsState>,
) -> Result<WorkspaceConfigSnapshot, String> {
    let ws = windows.get_or_create(window.label());
    let plans_root =
        plans_root_for_command(plans_root, &window, &windows).map_err(|e| e.to_string())?;
    let path = workspace_config_path(&plans_root);
    ws.watcher.tombstone(path);
    write_starter_config_to_root(&plans_root, style, overwrite.unwrap_or(false))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn read_workspace_config_source(
    plans_root: Option<String>,
    window: Window,
    windows: State<'_, WindowsState>,
) -> Result<WorkspaceConfigSourceSnapshot, String> {
    let plans_root =
        plans_root_for_command(plans_root, &window, &windows).map_err(|e| e.to_string())?;
    read_workspace_config_source_from_root(&plans_root).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn write_workspace_config_source(
    source: String,
    plans_root: Option<String>,
    window: Window,
    windows: State<'_, WindowsState>,
) -> Result<WorkspaceConfigSnapshot, String> {
    let ws = windows.get_or_create(window.label());
    let plans_root =
        plans_root_for_command(plans_root, &window, &windows).map_err(|e| e.to_string())?;
    let path = workspace_config_path(&plans_root);
    ws.watcher.tombstone(path);
    write_workspace_config_source_to_root(&plans_root, &source).map_err(|e| e.to_string())
}

pub fn read_workspace_config_from_root(
    plans_root: &Path,
) -> Result<WorkspaceConfigSnapshot, WorkspaceConfigError> {
    let path = workspace_config_path(plans_root);
    if !path.exists() {
        return Ok(snapshot(
            default_workspace_config(),
            false,
            &path,
            WorkspaceConfigSource::Default,
        ));
    }

    let raw = fs::read_to_string(&path).map_err(|e| WorkspaceConfigError::io(&path, e))?;
    let value: Value = serde_json::from_str(&raw).map_err(|e| WorkspaceConfigError::Json {
        path: path.clone(),
        message: e.to_string(),
    })?;
    validate_workspace_config_value(&value, &path)?;
    let config: WorkspaceConfig =
        serde_json::from_value(value).map_err(|e| WorkspaceConfigError::Json {
            path: path.clone(),
            message: e.to_string(),
        })?;
    validate_workspace_config(&config, &path)?;
    Ok(snapshot(config, true, &path, WorkspaceConfigSource::File))
}

pub fn read_workspace_config_source_from_root(
    plans_root: &Path,
) -> Result<WorkspaceConfigSourceSnapshot, WorkspaceConfigError> {
    let path = workspace_config_path(plans_root);
    if path.exists() {
        let source = fs::read_to_string(&path).map_err(|e| WorkspaceConfigError::io(&path, e))?;
        return Ok(source_snapshot(true, &path, source));
    }

    let source =
        serde_json::to_string_pretty(&starter_workspace_config(WorkspaceConfigStyle::Lightweight))
            .map_err(|e| WorkspaceConfigError::Json {
                path: path.clone(),
                message: e.to_string(),
            })?
            + "\n";
    Ok(source_snapshot(false, &path, source))
}

pub fn write_starter_config_to_root(
    plans_root: &Path,
    style: WorkspaceConfigStyle,
    overwrite: bool,
) -> Result<WorkspaceConfigSnapshot, WorkspaceConfigError> {
    let path = workspace_config_path(plans_root);
    if path.exists() && !overwrite {
        return Err(WorkspaceConfigError::AlreadyExists(path));
    }

    let config = starter_workspace_config(style);
    validate_workspace_config(&config, &path)?;
    let bytes = serde_json::to_string_pretty(&config).map_err(|e| WorkspaceConfigError::Json {
        path: path.clone(),
        message: e.to_string(),
    })? + "\n";

    write_workspace_config_bytes(&path, bytes.as_bytes())?;

    Ok(snapshot(config, true, &path, WorkspaceConfigSource::File))
}

pub fn write_workspace_config_source_to_root(
    plans_root: &Path,
    source: &str,
) -> Result<WorkspaceConfigSnapshot, WorkspaceConfigError> {
    let path = workspace_config_path(plans_root);
    let value: Value = serde_json::from_str(source).map_err(|e| WorkspaceConfigError::Json {
        path: path.clone(),
        message: e.to_string(),
    })?;
    validate_workspace_config_value(&value, &path)?;
    let config: WorkspaceConfig =
        serde_json::from_value(value).map_err(|e| WorkspaceConfigError::Json {
            path: path.clone(),
            message: e.to_string(),
        })?;
    validate_workspace_config(&config, &path)?;
    let bytes = ensure_trailing_newline(source);
    write_workspace_config_bytes(&path, bytes.as_bytes())?;
    Ok(snapshot(config, true, &path, WorkspaceConfigSource::File))
}

pub fn linked_repos_from_root(
    plans_root: &Path,
) -> Result<Vec<ResolvedLinkedRepo>, WorkspaceConfigError> {
    let snap = read_workspace_config_from_root(plans_root)?;
    Ok(snap
        .config
        .repos
        .into_iter()
        .map(|(handle, configured_path)| {
            let joined = plans_root.join(&configured_path);
            let path = joined.canonicalize().unwrap_or(joined);
            ResolvedLinkedRepo {
                handle,
                path,
                configured_path,
            }
        })
        .collect())
}

pub fn workspace_config_path(plans_root: &Path) -> PathBuf {
    plans_root.join(WORKSPACE_CONFIG_REL)
}

pub fn default_workspace_config() -> WorkspaceConfig {
    WorkspaceConfig {
        schema_version: WORKSPACE_CONFIG_SCHEMA_VERSION.to_string(),
        statuses: vec![
            status("draft", "Draft", WorkspaceStatusCategory::Draft, false),
            status("active", "Active", WorkspaceStatusCategory::Active, false),
            status(
                "upcoming",
                "Upcoming",
                WorkspaceStatusCategory::Active,
                false,
            ),
            status("backlog", "Backlog", WorkspaceStatusCategory::Draft, false),
            status("archive", "Archive", WorkspaceStatusCategory::Done, true),
        ],
        review_required_signoffs: 0,
        default_status: "draft".to_string(),
        repos: BTreeMap::new(),
    }
}

pub fn starter_workspace_config(style: WorkspaceConfigStyle) -> WorkspaceConfig {
    let mut config = match style {
        WorkspaceConfigStyle::Defaults => WorkspaceConfig {
            schema_version: WORKSPACE_CONFIG_SCHEMA_VERSION.to_string(),
            statuses: vec![
                status("draft", "Draft", WorkspaceStatusCategory::Draft, false),
                status(
                    "in_review",
                    "In Review",
                    WorkspaceStatusCategory::Review,
                    false,
                ),
                status(
                    "blocked",
                    "Blocked",
                    WorkspaceStatusCategory::Blocked,
                    false,
                ),
                status(
                    "approved",
                    "Approved",
                    WorkspaceStatusCategory::Active,
                    false,
                ),
                status(
                    "shipping",
                    "Shipping",
                    WorkspaceStatusCategory::Active,
                    false,
                ),
                status("done", "Done", WorkspaceStatusCategory::Done, true),
            ],
            review_required_signoffs: 1,
            default_status: "draft".to_string(),
            repos: BTreeMap::new(),
        },
        WorkspaceConfigStyle::Lightweight => default_workspace_config(),
        WorkspaceConfigStyle::FullReviewFlow => WorkspaceConfig {
            schema_version: WORKSPACE_CONFIG_SCHEMA_VERSION.to_string(),
            statuses: vec![
                status("draft", "Draft", WorkspaceStatusCategory::Draft, false),
                status("ready", "Ready", WorkspaceStatusCategory::Active, false),
                status(
                    "in_review",
                    "In Review",
                    WorkspaceStatusCategory::Review,
                    false,
                ),
                status(
                    "changes_requested",
                    "Changes Requested",
                    WorkspaceStatusCategory::Review,
                    false,
                ),
                status(
                    "blocked",
                    "Blocked",
                    WorkspaceStatusCategory::Blocked,
                    false,
                ),
                status(
                    "approved",
                    "Approved",
                    WorkspaceStatusCategory::Active,
                    false,
                ),
                status(
                    "shipping",
                    "Shipping",
                    WorkspaceStatusCategory::Active,
                    false,
                ),
                status("done", "Done", WorkspaceStatusCategory::Done, true),
            ],
            review_required_signoffs: 2,
            default_status: "draft".to_string(),
            repos: BTreeMap::new(),
        },
    };
    config.repos = BTreeMap::new();
    config
}

fn snapshot(
    config: WorkspaceConfig,
    exists: bool,
    path: &Path,
    source: WorkspaceConfigSource,
) -> WorkspaceConfigSnapshot {
    WorkspaceConfigSnapshot {
        config,
        exists,
        path: path.to_string_lossy().into_owned(),
        source,
    }
}

fn source_snapshot(exists: bool, path: &Path, source: String) -> WorkspaceConfigSourceSnapshot {
    WorkspaceConfigSourceSnapshot {
        exists,
        path: path.to_string_lossy().into_owned(),
        source,
    }
}

fn status(
    key: &str,
    label: &str,
    category: WorkspaceStatusCategory,
    terminal: bool,
) -> WorkspaceStatus {
    WorkspaceStatus {
        key: key.to_string(),
        label: label.to_string(),
        category,
        terminal,
    }
}

fn plans_root_for_command(
    plans_root: Option<String>,
    window: &Window,
    windows: &State<'_, WindowsState>,
) -> Result<PathBuf, WorkspaceConfigError> {
    plans_root
        .filter(|root| !root.trim().is_empty())
        .map(PathBuf::from)
        .map(Ok)
        .unwrap_or_else(|| {
            windows
                .get_or_create(window.label())
                .plans_root
                .lock()
                .unwrap()
                .clone()
                .ok_or(WorkspaceConfigError::NoPlansRoot)
        })
}

fn validate_workspace_config_value(value: &Value, path: &Path) -> Result<(), WorkspaceConfigError> {
    let schema: Value = serde_json::from_str(WORKSPACE_CONFIG_SCHEMA_JSON).map_err(|e| {
        WorkspaceConfigError::Json {
            path: PathBuf::from("embedded workspace_config.schema.json"),
            message: e.to_string(),
        }
    })?;
    let mut errors = Vec::new();
    validate_schema_node(&schema, value, "$", &mut errors);
    if errors.is_empty() {
        Ok(())
    } else {
        Err(WorkspaceConfigError::Invalid {
            path: path.to_path_buf(),
            errors,
        })
    }
}

fn validate_schema_node(schema: &Value, value: &Value, path: &str, errors: &mut Vec<String>) {
    if let Some(expected) = schema.get("const") {
        if value != expected {
            errors.push(format!("{path}: expected constant {expected}"));
            return;
        }
    }

    if let Some(allowed) = schema.get("enum").and_then(Value::as_array) {
        if !allowed.iter().any(|item| item == value) {
            errors.push(format!("{path}: value is not in enum"));
            return;
        }
    }

    if let Some(kind) = schema.get("type").and_then(Value::as_str) {
        let valid = match kind {
            "object" => value.is_object(),
            "array" => value.is_array(),
            "string" => value.is_string(),
            "integer" => value.as_i64().is_some() || value.as_u64().is_some(),
            "boolean" => value.is_boolean(),
            _ => true,
        };
        if !valid {
            errors.push(format!("{path}: expected {kind}"));
            return;
        }
    }

    if let (Some(min), Some(s)) = (
        schema.get("minLength").and_then(Value::as_u64),
        value.as_str(),
    ) {
        if s.chars().count() < min as usize {
            errors.push(format!("{path}: expected at least {min} character(s)"));
        }
    }

    if let (Some(min), Some(n)) = (
        schema.get("minimum").and_then(Value::as_i64),
        value.as_i64().or_else(|| value.as_u64().map(|n| n as i64)),
    ) {
        if n < min {
            errors.push(format!("{path}: expected >= {min}"));
        }
    }

    if let Some(array) = value.as_array() {
        if let Some(min) = schema.get("minItems").and_then(Value::as_u64) {
            if array.len() < min as usize {
                errors.push(format!("{path}: expected at least {min} item(s)"));
            }
        }
        if let Some(item_schema) = schema.get("items") {
            for (idx, item) in array.iter().enumerate() {
                validate_schema_node(item_schema, item, &format!("{path}[{idx}]"), errors);
            }
        }
    }

    if let Some(object) = value.as_object() {
        if let Some(required) = schema.get("required").and_then(Value::as_array) {
            for key in required.iter().filter_map(Value::as_str) {
                if !object.contains_key(key) {
                    errors.push(format!("{path}: missing required property `{key}`"));
                }
            }
        }

        let properties = schema.get("properties").and_then(Value::as_object);
        let additional = schema.get("additionalProperties");
        if additional
            .and_then(Value::as_bool)
            .is_some_and(|allowed| !allowed)
        {
            for key in object.keys() {
                if !properties.is_some_and(|props| props.contains_key(key)) {
                    errors.push(format!("{path}: unknown property `{key}`"));
                }
            }
        }

        if let Some(properties) = properties {
            for (key, prop_schema) in properties {
                if let Some(child) = object.get(key) {
                    validate_schema_node(prop_schema, child, &format!("{path}.{key}"), errors);
                }
            }
        }

        if let Some(additional_schema) = additional.and_then(Value::as_object) {
            for (key, child) in object {
                if properties.is_some_and(|props| props.contains_key(key)) {
                    continue;
                }
                validate_schema_node(
                    &Value::Object(additional_schema.clone()),
                    child,
                    &format!("{path}.{key}"),
                    errors,
                );
            }
        }
    }
}

fn validate_workspace_config(
    config: &WorkspaceConfig,
    path: &Path,
) -> Result<(), WorkspaceConfigError> {
    let mut errors = Vec::new();
    if config.schema_version != WORKSPACE_CONFIG_SCHEMA_VERSION {
        errors.push(format!(
            "schema_version must be {WORKSPACE_CONFIG_SCHEMA_VERSION}"
        ));
    }
    if config.statuses.is_empty() {
        errors.push("statuses must contain at least one status".to_string());
    }

    let mut keys = HashSet::new();
    for status in &config.statuses {
        if status.key.trim().is_empty() {
            errors.push("status key cannot be empty".to_string());
        }
        if status.key.trim() != status.key {
            errors.push(format!(
                "status key `{}` has leading/trailing space",
                status.key
            ));
        }
        if status.key.chars().any(char::is_whitespace) {
            errors.push(format!(
                "status key `{}` cannot contain whitespace",
                status.key
            ));
        }
        if !keys.insert(status.key.as_str()) {
            errors.push(format!("duplicate status key `{}`", status.key));
        }
        if status.label.trim().is_empty() {
            errors.push(format!("status `{}` label cannot be empty", status.key));
        }
    }

    if !keys.contains(config.default_status.as_str()) {
        errors.push(format!(
            "default_status `{}` does not match any status key",
            config.default_status
        ));
    }

    for (handle, rel_path) in &config.repos {
        if let Err(message) = validate_repo_handle(handle) {
            errors.push(format!("repo handle `{handle}` {message}"));
        }
        if rel_path.trim().is_empty() {
            errors.push(format!("repo `{handle}` path cannot be empty"));
        }
        if rel_path.contains('\0') {
            errors.push(format!("repo `{handle}` path cannot contain NUL"));
        }
        if Path::new(rel_path).is_absolute() {
            errors.push(format!("repo `{handle}` path must be relative"));
        }
    }

    if errors.is_empty() {
        Ok(())
    } else {
        Err(WorkspaceConfigError::Invalid {
            path: path.to_path_buf(),
            errors,
        })
    }
}

fn validate_repo_handle(handle: &str) -> Result<(), &'static str> {
    if handle.trim().is_empty() {
        return Err("cannot be empty");
    }
    if handle.trim() != handle {
        return Err("has leading/trailing space");
    }
    if handle == "self" {
        return Err("is reserved");
    }
    if handle
        .chars()
        .any(|c| !(c.is_ascii_alphanumeric() || c == '-' || c == '_'))
    {
        return Err("may only contain letters, numbers, '-' and '_'");
    }
    Ok(())
}

fn ensure_trailing_newline(source: &str) -> String {
    if source.ends_with('\n') {
        source.to_string()
    } else {
        format!("{source}\n")
    }
}

fn write_workspace_config_bytes(path: &Path, bytes: &[u8]) -> Result<(), WorkspaceConfigError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| WorkspaceConfigError::io(parent, e))?;
    }
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, bytes).map_err(|e| WorkspaceConfigError::io(&tmp, e))?;
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        WorkspaceConfigError::io(path, e)
    })
}

fn is_false(value: &bool) -> bool {
    !*value
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn write_config(dir: &Path, body: &str) {
        let path = dir.join(WORKSPACE_CONFIG_REL);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, body).unwrap();
    }

    #[test]
    fn missing_config_returns_default_snapshot() {
        let dir = tempdir().unwrap();
        let snap = read_workspace_config_from_root(dir.path()).unwrap();
        assert!(!snap.exists);
        assert_eq!(snap.source, WorkspaceConfigSource::Default);
        assert_eq!(snap.config.default_status, "draft");
        assert!(snap.config.repos.is_empty());
    }

    #[test]
    fn write_starter_creates_valid_workspace_json() {
        let dir = tempdir().unwrap();
        let snap = write_starter_config_to_root(dir.path(), WorkspaceConfigStyle::Defaults, false)
            .unwrap();

        assert!(snap.exists);
        assert_eq!(snap.config.review_required_signoffs, 1);

        let read = read_workspace_config_from_root(dir.path()).unwrap();
        assert_eq!(read.config, snap.config);
    }

    #[test]
    fn missing_source_returns_editable_lightweight_template() {
        let dir = tempdir().unwrap();
        let source = read_workspace_config_source_from_root(dir.path()).unwrap();

        assert!(!source.exists);
        assert!(source.source.contains("\"review_required_signoffs\": 0"));
        assert!(source.source.ends_with('\n'));
    }

    #[test]
    fn write_source_preserves_valid_json_text() {
        let dir = tempdir().unwrap();
        let source = r#"{"schema_version":"1","statuses":[{"key":"draft","label":"Draft","category":"draft"}],"review_required_signoffs":0,"default_status":"draft","repos":{"code":"../app"}}"#;

        let snap = write_workspace_config_source_to_root(dir.path(), source).unwrap();
        let path = dir.path().join(WORKSPACE_CONFIG_REL);
        let written = fs::read_to_string(path).unwrap();

        assert!(snap.exists);
        assert_eq!(snap.config.default_status, "draft");
        assert_eq!(snap.config.repos["code"], "../app");
        assert_eq!(written, format!("{source}\n"));
    }

    #[test]
    fn write_source_rejects_semantic_errors() {
        let dir = tempdir().unwrap();
        let source = r#"{
  "schema_version": "1",
  "statuses": [{"key":"draft","label":"Draft","category":"draft"}],
  "review_required_signoffs": 0,
  "default_status": "active"
}"#;

        let err = write_workspace_config_source_to_root(dir.path(), source).unwrap_err();
        assert!(err.to_string().contains("does not match any status key"));
        assert!(!dir.path().join(WORKSPACE_CONFIG_REL).exists());
    }

    #[test]
    fn reads_linked_repos_map() {
        let dir = tempdir().unwrap();
        let linked = dir.path().join("app");
        fs::create_dir(&linked).unwrap();
        write_config(
            dir.path(),
            r#"{
  "schema_version": "1",
  "statuses": [{"key":"draft","label":"Draft","category":"draft"}],
  "review_required_signoffs": 0,
  "default_status": "draft",
  "repos": {"code": "app", "landing": "../landing"}
}"#,
        );

        let snap = read_workspace_config_from_root(dir.path()).unwrap();
        assert_eq!(snap.config.repos["code"], "app");

        let repos = linked_repos_from_root(dir.path()).unwrap();
        let linked = linked.canonicalize().unwrap();
        assert_eq!(repos.len(), 2);
        assert!(repos.iter().any(|r| r.handle == "code" && r.path == linked));
    }

    #[test]
    fn rejects_reserved_self_repo_handle() {
        let dir = tempdir().unwrap();
        write_config(
            dir.path(),
            r#"{
  "schema_version": "1",
  "statuses": [{"key":"draft","label":"Draft","category":"draft"}],
  "review_required_signoffs": 0,
  "default_status": "draft",
  "repos": {"self": "../app"}
}"#,
        );

        let err = read_workspace_config_from_root(dir.path()).unwrap_err();
        assert!(err.to_string().contains("repo handle `self` is reserved"));
    }

    #[test]
    fn rejects_absolute_linked_repo_path() {
        let dir = tempdir().unwrap();
        write_config(
            dir.path(),
            &format!(
                r#"{{
  "schema_version": "1",
  "statuses": [{{"key":"draft","label":"Draft","category":"draft"}}],
  "review_required_signoffs": 0,
  "default_status": "draft",
  "repos": {{"code": "{}"}}
}}"#,
                dir.path().display()
            ),
        );

        let err = read_workspace_config_from_root(dir.path()).unwrap_err();
        assert!(err.to_string().contains("path must be relative"));
    }

    #[test]
    fn schema_rejects_unknown_properties() {
        let dir = tempdir().unwrap();
        write_config(
            dir.path(),
            r#"{
  "schema_version": "1",
  "statuses": [{"key":"draft","label":"Draft","category":"draft","color":"blue"}],
  "review_required_signoffs": 0,
  "default_status": "draft"
}"#,
        );

        let err = read_workspace_config_from_root(dir.path()).unwrap_err();
        assert!(err.to_string().contains("unknown property `color`"));
    }

    #[test]
    fn semantic_validation_rejects_default_status_without_status() {
        let dir = tempdir().unwrap();
        write_config(
            dir.path(),
            r#"{
  "schema_version": "1",
  "statuses": [{"key":"draft","label":"Draft","category":"draft"}],
  "review_required_signoffs": 0,
  "default_status": "active"
}"#,
        );

        let err = read_workspace_config_from_root(dir.path()).unwrap_err();
        assert!(err.to_string().contains("does not match any status key"));
    }

    #[test]
    fn embedded_schema_is_valid_json() {
        let schema: Value = serde_json::from_str(WORKSPACE_CONFIG_SCHEMA_JSON).unwrap();
        assert_eq!(schema["title"], "SpecRider workspace config");
    }
}
