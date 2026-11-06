//! Stable Zen IDs occupy a different numeric namespace from nDPI's u16 IDs.
//! Public keys, not display labels or source-list order, define identity.
pub struct App {
    pub id: u32,
    pub key: &'static str,
    pub slug: &'static str,
    pub name: &'static str,
    pub category: &'static str,
}
pub static APPS: &[App] = &[
    App {
        id: 324,
        key: "ndpi:324",
        slug: "tencent-video",
        name: "Tencentvideo",
        category: "video",
    },
    App {
        id: 54,
        key: "ndpi:54",
        slug: "iqiyi",
        name: "iQIYI",
        category: "video",
    },
    App {
        id: 65537,
        key: "community:youku",
        slug: "youku",
        name: "Youku",
        category: "video",
    },
    App {
        id: 65538,
        key: "community:bilibili",
        slug: "bilibili",
        name: "Bilibili",
        category: "video",
    },
    App {
        id: 65539,
        key: "community:mgtv",
        slug: "hunantv",
        name: "MangoTV",
        category: "video",
    },
    App {
        id: 65540,
        key: "community:douyin",
        slug: "douyin",
        name: "Douyin",
        category: "short_video",
    },
    App {
        id: 65541,
        key: "community:kuaishou",
        slug: "kuaishou",
        name: "Kuaishou",
        category: "short_video",
    },
    App {
        id: 65542,
        key: "community:douyu",
        slug: "douyu",
        name: "Douyu",
        category: "live",
    },
    App {
        id: 65543,
        key: "community:huya",
        slug: "huya",
        name: "Huya",
        category: "live",
    },
    App {
        id: 197,
        key: "ndpi:197",
        slug: "wechat",
        name: "WeChat",
        category: "chat",
    },
    App {
        id: 48,
        key: "ndpi:48",
        slug: "qq",
        name: "QQ",
        category: "chat",
    },
    App {
        id: 49,
        key: "ndpi:49",
        slug: "tiktok",
        name: "TikTok",
        category: "short_video",
    },
    App {
        id: 285,
        key: "ndpi:285",
        slug: "tencent",
        name: "Tencent",
        category: "infrastructure",
    },
    App {
        id: 395,
        key: "ndpi:395",
        slug: "tencent-games",
        name: "TencentGames",
        category: "game",
    },
    App {
        id: 1048577,
        key: "infra:tencent-cloud",
        slug: "tencent-cloud",
        name: "TencentCloud",
        category: "infrastructure",
    },
    App {
        id: 1048578,
        key: "infra:alibaba-cloud",
        slug: "alibaba-cloud",
        name: "AlibabaCloud",
        category: "infrastructure",
    },
];
pub fn by_id(id: u32) -> Option<&'static App> {
    APPS.iter().find(|a| a.id == id)
}
pub fn by_key(key: &str) -> Option<&'static App> {
    APPS.iter().find(|a| a.key == key)
}
pub fn key(id: u32) -> String {
    by_id(id)
        .map(|a| a.key.to_owned())
        .unwrap_or_else(|| format!("ndpi:{id}"))
}
pub fn category(id: u32) -> &'static str {
    by_id(id).map(|a| a.category).unwrap_or("other")
}
pub fn is_infrastructure(id: u32, name: &str) -> bool {
    category(id) == "infrastructure"
        || [
            "TencentCloud",
            "AlibabaCloud",
            "Alibaba",
            "AmazonAWS",
            "Cloudflare",
            "Akamai",
            "MicrosoftAzure",
            "Tencent",
        ]
        .iter()
        .any(|value| name.eq_ignore_ascii_case(value))
}
