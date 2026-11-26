//! Validated, indexed rule packages and crash-safe local replacement.
use crate::{app_catalog, app_rules};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    io::Write,
    path::{Path, PathBuf},
};
const MAX_BYTES: u64 = 524288;
const CUSTOM_MAX_BYTES: u64 = 131072;
const CUSTOM_MAX_RULES: usize = 512;
pub const BUNDLED: &str = include_str!("../../../rules/china-apps.json");

pub fn is_forbidden_dedicated(domain: &str) -> bool {
    matches!(
        domain,
        "qq.com"
            | "gtimg.com"
            | "myqcloud.com"
            | "qcloud.com"
            | "alicdn.com"
            | "aliyuncs.com"
            | "tencent.com"
    )
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CustomRule {
    pub domain: String,
    #[serde(rename = "match")]
    pub mode: String,
    pub app: String,
    #[serde(default)]
    pub added_at: u64,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CustomPackage {
    pub schema: u8,
    pub rules: Vec<CustomRule>,
}

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
fn validate_overlaps(
    exact: &HashMap<String, DomainRule>,
    suffix: &HashMap<String, DomainRule>,
) -> Result<(), String> {
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
    Ok(())
}

const TWO_PART_PUBLIC_SUFFIXES: &[&str] = &[
    "com.cn", "net.cn", "org.cn", "gov.cn", "edu.cn", "ac.cn", "com.hk", "com.tw", "co.uk",
    "org.uk", "net.uk", "co.jp", "ne.jp", "or.jp", "com.sg", "com.au",
];

/// Extract eTLD+1 registrable domain (or preserve IPv4/IPv6/single-label hostnames).
pub fn registrable_domain(host: &str) -> String {
    let trimmed = host.trim().trim_end_matches('.').to_ascii_lowercase();
    if trimmed.is_empty() || trimmed.parse::<std::net::IpAddr>().is_ok() {
        return trimmed;
    }
    let Some(norm) = app_rules::normalize_hostname(&trimmed) else {
        return trimmed;
    };
    let labels: Vec<&str> = norm.split('.').collect();
    if labels.len() < 2 {
        return norm;
    }
    let tail2 = format!("{}.{}", labels[labels.len() - 2], labels[labels.len() - 1]);
    let base_len = if labels.len() >= 3 && TWO_PART_PUBLIC_SUFFIXES.contains(&tail2.as_str()) {
        3
    } else {
        2
    };
    labels[labels.len() - base_len..].join(".")
}

pub fn suggested_rule(host: &str, rules: &RuleSet) -> (String, &'static str) {
    let Some(host) = app_rules::normalize_hostname(host) else {
        return (String::new(), "exact");
    };
    let labels: Vec<&str> = host.split('.').collect();
    if labels.len() < 2 {
        return (host, "exact");
    }
    let multi_tenant = [
        "github.io",
        "githubusercontent.com",
        "workers.dev",
        "pages.dev",
        "duckdns.org",
        "ddns.net",
        "no-ip.com",
        "synology.me",
        "quickconnect.to",
        "quickconnect.cn",
        "myqnapcloud.com",
        "myqnapcloud.cn",
        "5ddd.com",
        "amazonaws.com",
        "cloudfront.net",
        "azurewebsites.net",
        "herokuapp.com",
        "vercel.app",
        "netlify.app",
    ];
    let parent = registrable_domain(&host);
    let parent_is_shared = is_forbidden_dedicated(&parent)
        || multi_tenant.contains(&parent.as_str())
        || rules
            .find(&parent)
            .is_some_and(|r| r.level == Level::Infrastructure);
    if parent_is_shared {
        return (host, "exact");
    }
    let has_dedicated_ancestor = rules
        .find(&parent)
        .is_some_and(|r| r.level == Level::Dedicated);
    let dot_parent = format!(".{parent}");
    let has_dedicated_child = rules
        .rules()
        .any(|r| r.level == Level::Dedicated && r.domain.ends_with(&dot_parent));
    if has_dedicated_ancestor || has_dedicated_child {
        return (host, "exact");
    }
    (parent, "suffix")
}

impl RuleSet {
    pub fn parse(data: &str) -> Result<Self, String> {
        Self::parse_with_custom(data, &[])
    }
    pub fn parse_with_custom(data: &str, custom: &[CustomRule]) -> Result<Self, String> {
        if data.len() as u64 > MAX_BYTES {
            return Err("rule_package_too_large".into());
        }
        if custom.len() > CUSTOM_MAX_RULES {
            return Err("custom_rules_limit_exceeded".into());
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
            if rule.level == Level::Dedicated && is_forbidden_dedicated(&rule.domain) {
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
        validate_overlaps(&exact, &suffix)?;
        for c in custom {
            if app_rules::normalize_hostname(&c.domain).as_deref() != Some(&c.domain)
                || !matches!(c.mode.as_str(), "exact" | "suffix")
            {
                return Err("invalid_rule_metadata".into());
            }
            let app = app_catalog::by_key(&c.app).ok_or("unknown_application_key")?;
            if app.category == "infrastructure" {
                return Err("invalid_infrastructure_rule".into());
            }
            if is_forbidden_dedicated(&c.domain) {
                return Err("shared_domain_cannot_identify_application".into());
            }
            let rule = DomainRule {
                domain: c.domain.clone(),
                mode: c.mode.clone(),
                app: c.app.clone(),
                level: Level::Dedicated,
                source: "user-custom".into(),
                revision: "custom".into(),
                license: "MIT".into(),
            };
            let index = if rule.mode == "exact" {
                &mut exact
            } else {
                &mut suffix
            };
            index.insert(rule.domain.clone(), rule);
        }
        validate_overlaps(&exact, &suffix)?;
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
            .any(|id| matches!(id, 7 | 91 | 188 | 221 | 418))
        {
            return None;
        }
        let host = app_rules::normalize_peer_hostname(&evidence.hostname)?;
        let rule = self.find(&host)?.clone();
        let app = rule.app_id();
        let generic = !identified || matches!(native, 0 | 48 | 285 | 418);
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
    custom_path: PathBuf,
    pub custom: Vec<CustomRule>,
    pub error: Option<String>,
    pub custom_error: Option<String>,
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
fn read_custom(path: &Path) -> Result<Vec<CustomRule>, String> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    if std::fs::metadata(path)
        .map_err(|_| "custom_rules_unreadable")?
        .len()
        > CUSTOM_MAX_BYTES
    {
        return Err("custom_rules_too_large".into());
    }
    let raw = std::fs::read_to_string(path).map_err(|_| "custom_rules_unreadable")?;
    let pkg: CustomPackage = serde_json::from_str(&raw).map_err(|_| "invalid_custom_rules")?;
    if pkg.schema != 1 || pkg.rules.len() > CUSTOM_MAX_RULES {
        return Err("invalid_custom_rules".into());
    }
    Ok(pkg.rules)
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
    fn merge_with_base(base_data: &str, custom: Vec<CustomRule>) -> (RuleSet, Vec<CustomRule>, Option<String>) {
        if custom.is_empty() {
            let set = RuleSet::parse(base_data).expect("validated base rules");
            return (set, Vec::new(), None);
        }
        if let Ok(set) = RuleSet::parse_with_custom(base_data, &custom) {
            return (set, custom, None);
        }
        // Keep all compatible custom rules if a base package update introduces a conflict.
        let mut kept = Vec::new();
        for rule in custom {
            let mut trial = kept.clone();
            trial.push(rule.clone());
            if RuleSet::parse_with_custom(base_data, &trial).is_ok() {
                kept = trial;
            }
        }
        let set = RuleSet::parse_with_custom(base_data, &kept).expect("validated filtered rules");
        (set, kept, Some("filtered_conflicting_custom_rules".into()))
    }

    pub fn load(path: &Path) -> Self {
        let custom_path = path.with_file_name("custom-rules.json");
        let (raw_custom, mut custom_error) = match read_custom(&custom_path) {
            Ok(rules) => (rules, None),
            Err(err) => (Vec::new(), Some(err)),
        };
        let (base_data, error) = match read(path).and_then(|data| RuleSet::parse(&data).map(|_| data)) {
            Ok(data) => (data, None),
            Err(error) => {
                let mut restored = None;
                if path.exists() {
                    if let Ok(data) = read(&path.with_extension("previous")) {
                        if RuleSet::parse(&data).is_ok() {
                            let _ = atomic(path, &data);
                            restored = Some((data, Some("restored_previous_rules".into())));
                        }
                    }
                }
                restored.unwrap_or_else(|| {
                    (
                        BUNDLED.to_owned(),
                        if path.exists() { Some(error) } else { None },
                    )
                })
            }
        };
        let (set, custom, merge_err) = Self::merge_with_base(&base_data, raw_custom);
        if custom_error.is_none() {
            custom_error = merge_err;
        }
        Self {
            set,
            path: path.into(),
            custom_path,
            custom,
            error,
            custom_error,
        }
    }
    pub fn update(&mut self, data: &str) -> Result<(), String> {
        let base_set = RuleSet::parse(data)?;
        let previous =
            serde_json::to_string(&self.set.package).map_err(|_| "rules_encoding_failed")?;
        if base_set.package.version == self.set.package.version {
            if serde_json::to_string(&base_set.package).map_err(|_| "rules_encoding_failed")?
                == previous
            {
                return Ok(());
            }
            return Err("rule_version_conflict".into());
        }
        let (set, custom, custom_error) = Self::merge_with_base(data, self.custom.clone());
        atomic(&self.path.with_extension("previous"), &previous)?;
        if let Err(error) = atomic(&self.path, data) {
            let _ = atomic(&self.path, &previous);
            return Err(error);
        }
        self.set = set;
        self.custom = custom;
        self.error = None;
        self.custom_error = custom_error;
        Ok(())
    }
    pub fn apply_custom(
        &mut self,
        add: &[CustomRule],
        remove: &[(String, String)],
        now_epoch: u64,
    ) -> Result<Vec<CustomRule>, String> {
        if add.len() > CUSTOM_MAX_RULES || remove.len() > CUSTOM_MAX_RULES {
            return Err("custom_rules_limit_exceeded".into());
        }
        let mut next = self.custom.clone();
        for (domain, mode) in remove {
            let Some(host) = app_rules::normalize_hostname(domain.trim()) else {
                return Err("invalid_rule_metadata".into());
            };
            if !matches!(mode.as_str(), "exact" | "suffix") {
                return Err("invalid_rule_metadata".into());
            }
            next.retain(|r| !(r.domain == host && r.mode == *mode));
        }
        for item in add {
            let Some(host) = app_rules::normalize_hostname(item.domain.trim()) else {
                return Err("invalid_rule_metadata".into());
            };
            if !matches!(item.mode.as_str(), "exact" | "suffix") {
                return Err("invalid_rule_metadata".into());
            }
            let entry = CustomRule {
                domain: host,
                mode: item.mode.clone(),
                app: item.app.clone(),
                added_at: if item.added_at != 0 {
                    item.added_at
                } else {
                    now_epoch
                },
            };
            if let Some(existing) = next
                .iter_mut()
                .find(|r| r.domain == entry.domain && r.mode == entry.mode)
            {
                *existing = entry;
            } else {
                next.push(entry);
            }
        }
        if next.len() > CUSTOM_MAX_RULES {
            return Err("custom_rules_limit_exceeded".into());
        }
        let base_json =
            serde_json::to_string(&self.set.package).map_err(|_| "rules_encoding_failed")?;
        let new_set = RuleSet::parse_with_custom(&base_json, &next)?;
        let encoded = serde_json::to_string_pretty(&CustomPackage {
            schema: 1,
            rules: next.clone(),
        })
        .map_err(|_| "rules_encoding_failed")?;
        atomic(&self.custom_path, &(encoded + "\n"))?;
        self.set = new_set;
        self.custom = next.clone();
        self.custom_error = None;
        Ok(next)
    }
    pub fn rollback(&mut self) -> Result<(), String> {
        let data = read(&self.path.with_extension("previous"))?;
        self.update(&data)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn custom_rules_override_candidates_and_reject_shared_domains() {
        let base = r#"{"schema":1,"version":"v1","source_revision":"0000000000000000000000000000000000000000","rules":[
            {"domain":"cand.example","match":"suffix","app":"community:baidu","level":"candidate","source":"dlc","revision":"v1","license":"MIT"}
        ]}"#;
        let custom = vec![CustomRule {
            domain: "cand.example".into(),
            mode: "suffix".into(),
            app: "community:selfhosted".into(),
            added_at: 100,
        }];
        let set = RuleSet::parse_with_custom(base, &custom).unwrap();
        let matched = set.find("nas.cand.example").unwrap();
        assert_eq!(matched.app, "community:selfhosted");
        assert!(matched.level == Level::Dedicated);
        assert_eq!(matched.source, "user-custom");

        let bad = vec![CustomRule {
            domain: "aliyuncs.com".into(),
            mode: "suffix".into(),
            app: "community:selfhosted".into(),
            added_at: 100,
        }];
        assert!(RuleSet::parse_with_custom(base, &bad).is_err());
    }

    #[test]
    fn registrable_domain_groups_standard_public_suffix_and_ip_hosts() {
        assert_eq!(registrable_domain("storage.googleapis.com"), "googleapis.com");
        assert_eq!(registrable_domain("googlevideo.com"), "googlevideo.com");
        assert_eq!(registrable_domain("cdn1.my-nas-demo.com.cn."), "my-nas-demo.com.cn");
        assert_eq!(registrable_domain("1.1.1.1"), "1.1.1.1");
        assert_eq!(registrable_domain("localhost"), "localhost");
    }

    #[test]
    fn suggested_rule_avoids_public_suffixes_and_shared_clouds() {
        let set = RuleSet::parse(BUNDLED).unwrap();
        assert_eq!(
            suggested_rule("bucket.oss-cn-hangzhou.aliyuncs.com", &set),
            ("bucket.oss-cn-hangzhou.aliyuncs.com".into(), "exact")
        );
        assert_eq!(
            suggested_rule("alice.github.io", &set),
            ("alice.github.io".into(), "exact")
        );
        assert_eq!(
            suggested_rule("cdn1.my-nas-demo.com.cn", &set),
            ("my-nas-demo.com.cn".into(), "suffix")
        );
        assert_eq!(
            suggested_rule("relay.custom-app.net", &set),
            ("custom-app.net".into(), "suffix")
        );
    }

    #[cfg(unix)]
    #[test]
    fn custom_store_persists_and_survives_reload() {
        let dir = std::env::temp_dir().join(format!(
            "zen-custom-rules-{}-{}",
            std::process::id(),
            crate::state::now_mono_ms()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let rules_path = dir.join("app-rules.json");
        let mut store = Store::load(&rules_path);
        let saved = store
            .apply_custom(
                &[CustomRule {
                    domain: "nas.example.net".into(),
                    mode: "suffix".into(),
                    app: "community:selfhosted".into(),
                    added_at: 42,
                }],
                &[],
                42,
            )
            .unwrap();
        assert_eq!(saved.len(), 1);
        assert_eq!(
            store.set.find("box.nas.example.net").unwrap().app,
            "community:selfhosted"
        );
        let reloaded = Store::load(&rules_path);
        assert_eq!(reloaded.custom.len(), 1);
        assert_eq!(
            reloaded.set.find("box.nas.example.net").unwrap().app,
            "community:selfhosted"
        );
        std::fs::remove_dir_all(dir).unwrap();
    }
}
