//! Validated, indexed rule packages and crash-safe local replacement.
use crate::{app_catalog, app_rules};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    io::Write,
    path::{Path, PathBuf},
};
const MAX_BYTES: u64 = 524288;
pub const BUNDLED: &str = include_str!("../../../rules/china-apps.json");

#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Level {
    Dedicated,
    Candidate,
    Infrastructure,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct DomainRule {
    pub domain: String,
    #[serde(rename = "match")]
    pub mode: String,
    pub app: String,
    pub level: Level,
    pub source: String,
    pub revision: String,
    pub license: String,
}
impl DomainRule {
    pub fn id(&self) -> String {
        format!("{}:{}:{}", self.mode, self.domain, self.app)
    }
    pub fn app_id(&self) -> u32 {
        app_catalog::by_key(&self.app).unwrap().id
    }
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Package {
    pub schema: u8,
    pub version: String,
    pub source_revision: String,
    pub rules: Vec<DomainRule>,
    #[serde(default)]
    pub features: Vec<crate::app_features::Feature>,
}

pub struct RuleSet {
    pub package: Package,
    exact: HashMap<String, DomainRule>,
    suffix: HashMap<String, DomainRule>,
    pub features: Vec<crate::app_features::Compiled>,
}
pub struct Attribution {
    pub rule: DomainRule,
    pub refine: bool,
    pub conflict: bool,
    pub candidate: bool,
}
fn token(value: &str, max: usize) -> bool {
    !value.is_empty()
        && value.len() <= max
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"-_.:/".contains(&c))
}
impl RuleSet {
    pub fn parse(data: &str) -> Result<Self, String> {
        if data.len() as u64 > MAX_BYTES {
            return Err("rule_package_too_large".into());
        }
        let package: Package = serde_json::from_str(data).map_err(|_| "invalid_rule_json")?;
        if package.schema != 1
            || !token(&package.version, 64)
            || !token(&package.source_revision, 64)
            || package.rules.len() > 2048
        {
            return Err("invalid_rule_header".into());
        }
        let mut all: Vec<DomainRule> = app_rules::RULES
            .iter()
            .map(|r| DomainRule {
                domain: r.domain.to_owned(),
                mode: if r.suffix { "suffix" } else { "exact" }.into(),
                app: app_catalog::key(r.app as u32),
                level: Level::Dedicated,
                source: r.provenance.into(),
                revision: app_rules::VERSION.into(),
                license: "GPL-2.0".into(),
            })
            .collect();
        all.extend(package.rules.iter().cloned());
        let mut exact = HashMap::new();
        let mut suffix = HashMap::new();
        for rule in all {
            if app_rules::normalize_hostname(&rule.domain).as_deref() != Some(&rule.domain)
                || !matches!(rule.mode.as_str(), "exact" | "suffix")
                || !token(&rule.source, 96)
                || !token(&rule.revision, 64)
                || !matches!(rule.license.as_str(), "MIT" | "CC0-1.0" | "GPL-2.0")
            {
                return Err("invalid_rule_metadata".into());
            }
            let app = app_catalog::by_key(&rule.app).ok_or("unknown_application_key")?;
            if (rule.level == Level::Infrastructure) != (app.category == "infrastructure") {
                return Err("invalid_infrastructure_rule".into());
            }
            if rule.level == Level::Dedicated
                && [
                    "qq.com",
                    "gtimg.com",
                    "myqcloud.com",
                    "qcloud.com",
                    "alicdn.com",
                    "aliyuncs.com",
                    "tencent.com",
                ]
                .contains(&rule.domain.as_str())
            {
                return Err("shared_domain_cannot_identify_application".into());
            }
            let index = if rule.mode == "exact" {
                &mut exact
            } else {
                &mut suffix
            };
            if let Some(old) = index.get(&rule.domain) {
                let old: &DomainRule = old;
                if old.app != rule.app || old.level != rule.level {
                    return Err("conflicting_domain_rules".into());
                }
            }
            index.insert(rule.domain.clone(), rule);
        }
        for child in exact.values().chain(suffix.values()) {
            let mut host = child.domain.as_str();
            while let Some((_, parent)) = host.split_once('.') {
                if let Some(rule) = suffix.get(parent) {
                    if rule.app != child.app
                        && rule.level == Level::Dedicated
                        && child.level == Level::Dedicated
                    {
                        return Err("overlapping_application_rules".into());
                    }
                }
                host = parent;
            }
        }
        let features = crate::app_features::compile(&package.features)?;
        Ok(Self {
            package,
            exact,
            suffix,
            features,
        })
    }
    pub fn find(&self, host: &str) -> Option<&DomainRule> {
        let mut part = host;
        if let Some(rule) = self.exact.get(part) {
            return Some(rule);
        }
        loop {
            if let Some(rule) = self.suffix.get(part) {
                return Some(rule);
            }
            match part.split_once('.') {
                Some((_, rest)) => part = rest,
                None => return None,
            }
        }
    }
    pub fn rules(&self) -> impl Iterator<Item = &DomainRule> {
        self.exact.values().chain(self.suffix.values())
    }
    pub fn classify(
        &self,
        native: u16,
        identified: bool,
        evidence: &app_rules::Evidence,
    ) -> Option<Attribution> {
        if ![evidence.master_protocol, evidence.app_protocol]
            .iter()
            .any(|id| matches!(id, 7 | 91 | 188))
        {
            return None;
        }
        let host = app_rules::normalize_hostname(&evidence.hostname)?;
        let rule = self.find(&host)?.clone();
        let app = rule.app_id();
        let generic = !identified || matches!(native, 0 | 48 | 285);
        let candidate = rule.level == Level::Candidate;
        Some(Attribution {
            refine: !candidate && u32::from(native) != app && generic,
            conflict: !candidate && u32::from(native) != app && !generic,
            rule,
            candidate,
        })
    }
}

pub struct Store {
    pub set: RuleSet,
    path: PathBuf,
    pub error: Option<String>,
}
fn read(path: &Path) -> Result<String, String> {
    if std::fs::metadata(path)
        .map_err(|_| "rules_not_found")?
        .len()
        > MAX_BYTES
    {
        return Err("rule_package_too_large".into());
    }
    std::fs::read_to_string(path).map_err(|_| "rules_unreadable".into())
}
fn atomic(path: &Path, data: &str) -> Result<(), String> {
    use std::os::unix::fs::OpenOptionsExt;
    let parent = path.parent().ok_or("invalid_rules_path")?;
    std::fs::create_dir_all(parent).map_err(|_| "rules_directory_unavailable")?;
    let temp = path.with_file_name(format!(
        "{}.{}.{}.new",
        path.file_name()
            .ok_or("invalid_rules_path")?
            .to_string_lossy(),
        std::process::id(),
        crate::state::now_mono_ms()
    ));
    let mut created = false;
    let result = (|| {
        let mut file = std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .mode(0o600)
            .open(&temp)
            .map_err(|_| "rules_stage_unavailable")?;
        created = true;
        file.write_all(data.as_bytes())
            .and_then(|_| file.sync_all())
            .map_err(|_| "rules_write_failed")?;
        std::fs::rename(&temp, path).map_err(|_| "rules_replace_failed")?;
        std::fs::File::open(parent)
            .and_then(|file| file.sync_all())
            .map_err(|_| "rules_sync_failed")?;
        Ok(())
    })();
    // Only our exclusively-created staging path is disposable.
    if created && result.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    result
}
impl Store {
    pub fn load(path: &Path) -> Self {
        let bundled = RuleSet::parse(BUNDLED).expect("bundled rules must pass source validation");
        match read(path).and_then(|data| RuleSet::parse(&data)) {
            Ok(set) => Self {
                set,
                path: path.into(),
                error: None,
            },
            Err(error) => {
                if path.exists() {
                    if let Ok(data) = read(&path.with_extension("previous")) {
                        if let Ok(set) = RuleSet::parse(&data) {
                            let _ = atomic(path, &data);
                            return Self {
                                set,
                                path: path.into(),
                                error: Some("restored_previous_rules".into()),
                            };
                        }
                    }
                }
                Self {
                    set: bundled,
                    path: path.into(),
                    error: if path.exists() { Some(error) } else { None },
                }
            }
        }
    }
    pub fn update(&mut self, data: &str) -> Result<(), String> {
        let set = RuleSet::parse(data)?;
        let previous =
            serde_json::to_string(&self.set.package).map_err(|_| "rules_encoding_failed")?;
        if set.package.version == self.set.package.version {
            if serde_json::to_string(&set.package).map_err(|_| "rules_encoding_failed")? == previous
            {
                return Ok(());
            }
            return Err("rule_version_conflict".into());
        }
        atomic(&self.path.with_extension("previous"), &previous)?;
        if let Err(error) = atomic(&self.path, data) {
            let _ = atomic(&self.path, &previous);
            return Err(error);
        }
        self.set = set;
        self.error = None;
        Ok(())
    }
    pub fn rollback(&mut self) -> Result<(), String> {
        let data = read(&self.path.with_extension("previous"))?;
        self.update(&data)
    }
}
