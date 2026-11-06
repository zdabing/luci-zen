//! Connection attribution only. Rules never own counters, persist hostnames,
//! infer an application from a shared IP, or scan individual packets.

pub const VERSION: &str = "zen-cn-20261106.1";

#[derive(Clone, Debug, Default)]
pub struct Evidence {
    pub master_protocol: u16,
    pub app_protocol: u16,
    pub master_name: String,
    pub confidence: u8,
    pub confidence_source: String,
    pub hostname: String,
    pub has_hostname: bool,
    pub budget_exhausted: bool,
    pub hostname_truncated: bool,
}

pub struct Rule {
    pub domain: &'static str,
    pub suffix: bool,
    pub app: u16,
    pub name: &'static str,
    pub provenance: &'static str,
}

// Native IDs are pinned to the nDPI 6.0 build. New community applications must
// use a separate identifier namespace instead of inventing nDPI numbers.
pub static RULES: &[Rule] = &[
    Rule {
        domain: "weixin.qq.com",
        suffix: true,
        app: 197,
        name: "WeChat",
        provenance: "zen-wechat",
    },
    Rule {
        domain: "wx.qq.com",
        suffix: true,
        app: 197,
        name: "WeChat",
        provenance: "zen-wechat",
    },
    Rule {
        domain: "wechat.com",
        suffix: true,
        app: 197,
        name: "WeChat",
        provenance: "zen-wechat",
    },
    Rule {
        domain: "v.qq.com",
        suffix: true,
        app: 324,
        name: "Tencentvideo",
        provenance: "zen-video",
    },
    Rule {
        domain: "video.qq.com",
        suffix: true,
        app: 324,
        name: "Tencentvideo",
        provenance: "zen-video",
    },
    // Dedicated HLS names documented in CN112203136B; ltscsy.qq.com was also
    // observed carrying actual browser video on the validation router.
    Rule {
        domain: "ltsbsy.qq.com",
        suffix: false,
        app: 324,
        name: "Tencentvideo",
        provenance: "CN112203136B",
    },
    Rule {
        domain: "ltscsy.qq.com",
        suffix: false,
        app: 324,
        name: "Tencentvideo",
        provenance: "router-20261101",
    },
    Rule {
        domain: "ltssjy.qq.com",
        suffix: false,
        app: 324,
        name: "Tencentvideo",
        provenance: "CN112203136B",
    },
    Rule {
        domain: "ltsws.qq.com",
        suffix: false,
        app: 324,
        name: "Tencentvideo",
        provenance: "CN112203136B",
    },
    Rule {
        domain: "stsbsy.qq.com",
        suffix: false,
        app: 324,
        name: "Tencentvideo",
        provenance: "CN112203136B",
    },
    // Service-owned domains already listed by nDPI 6.0's content-match rules:
    // https://github.com/ntop/nDPI/blob/6.0/src/lib/ndpi_content_match.c.inc
    Rule {
        domain: "iqiyi.com",
        suffix: true,
        app: 54,
        name: "iQIYI",
        provenance: "ndpi-6.0/content-match",
    },
    Rule {
        domain: "iqiyipic.com",
        suffix: true,
        app: 54,
        name: "iQIYI",
        provenance: "ndpi-6.0/content-match",
    },
    Rule {
        domain: "qy.net",
        suffix: true,
        app: 54,
        name: "iQIYI",
        provenance: "ndpi-6.0/content-match",
    },
    Rule {
        domain: "iq.com",
        suffix: true,
        app: 54,
        name: "iQIYI",
        provenance: "ndpi-6.0/content-match",
    },
];

/// Only complete DNS names can be domain evidence. In particular, never turn
/// a URL, IP literal, truncated label or suffix lookalike into an application.
pub fn normalize_hostname(input: &str) -> Option<String> {
    let name = input.strip_suffix('.').unwrap_or(input);
    if name.is_empty() || name.len() > 253 || name.parse::<std::net::IpAddr>().is_ok() {
        return None;
    }
    if !name.split('.').all(|label| {
        !label.is_empty()
            && label.len() <= 63
            && label.as_bytes()[0].is_ascii_alphanumeric()
            && label.as_bytes()[label.len() - 1].is_ascii_alphanumeric()
            && label
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'-')
    }) {
        return None;
    }
    Some(name.to_ascii_lowercase())
}

#[cfg(test)]
fn matches(host: &str, rule: &Rule) -> bool {
    host == rule.domain
        || (rule.suffix
            && host
                .strip_suffix(rule.domain)
                .is_some_and(|prefix| prefix.ends_with('.')))
}

#[cfg(test)]
pub struct Attribution {
    pub rule: &'static Rule,
    pub refine: bool,
    pub conflict: bool,
}

#[cfg(test)]
pub fn classify(native_app: u16, identified: bool, evidence: &Evidence) -> Option<Attribution> {
    // A hostname seen in DNS or another dissector is not a TLS/HTTP peer host.
    // No DNS-to-flow association is enabled in this first rule package.
    if ![evidence.master_protocol, evidence.app_protocol]
        .iter()
        .any(|id| matches!(id, 7 | 91 | 188))
    {
        return None;
    }
    let host = normalize_hostname(&evidence.hostname)?;
    let rule = RULES
        .iter()
        .filter(|rule| matches(&host, rule))
        .max_by_key(|rule| rule.domain.len())?;
    // QQ/Tencent may be the native qq.com/vendor catch-all. This exception is
    // limited to dedicated domains; WeChat/Games/other concrete apps win.
    let generic = matches!(native_app, 0 | 48 | 285) || !identified;
    Some(Attribution {
        rule,
        refine: native_app != rule.app && generic,
        conflict: native_app != rule.app && !generic,
    })
}
