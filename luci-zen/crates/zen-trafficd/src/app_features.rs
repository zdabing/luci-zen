//! Optional OAF-style visible-payload evidence, without a kernel module.
//! No unverified PCDN/video fingerprints ship with Zen. Feature hits are
//! diagnostic candidates until separately validated on real traffic.
use serde::{Deserialize, Serialize};
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Pattern {
    pub offset: usize,
    pub hex: String,
    pub mask: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Feature {
    pub id: String,
    pub app: String,
    pub transport: String,
    pub ports: Vec<u16>,
    pub patterns: Vec<Pattern>,
    pub evidence: String,
}
pub struct Compiled {
    pub id: String,
    transport: u8,
    ports: Vec<u16>,
    patterns: Vec<(usize, Vec<u8>, Vec<u8>)>,
}
fn decode(text: &str) -> Option<Vec<u8>> {
    if text.len() % 2 != 0 || !text.bytes().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&text[i..i + 2], 16).ok())
        .collect()
}
pub fn validate(features: &[Feature]) -> Result<(), String> {
    if features.len() > 16 {
        return Err("too_many_features".into());
    }
    let mut ids = std::collections::HashSet::new();
    for f in features {
        if f.id.is_empty()
            || f.id.len() > 64
            || !f
                .id
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"_-".contains(&c))
            || !ids.insert(&f.id)
            || crate::app_catalog::by_key(&f.app).is_none()
            || !matches!(f.transport.as_str(), "tcp" | "udp")
            || f.ports.is_empty()
            || f.ports.len() > 8
            || f.ports.contains(&0)
            || !(2..=8).contains(&f.patterns.len())
            || f.evidence.len() < 8
            || f.evidence.len() > 200
            || f.evidence.chars().any(char::is_control)
        {
            return Err("invalid_feature".into());
        }
        for p in &f.patterns {
            let (Some(bytes), Some(mask)) = (decode(&p.hex), decode(&p.mask)) else {
                return Err("invalid_feature_bytes".into());
            };
            if !(2..=32).contains(&bytes.len())
                || bytes.len() != mask.len()
                || p.offset > 256
                || mask.iter().all(|b| *b == 0)
            {
                return Err("invalid_feature_pattern".into());
            }
        }
    }
    Ok(())
}
pub fn compile(features: &[Feature]) -> Result<Vec<Compiled>, String> {
    validate(features)?;
    Ok(features
        .iter()
        .map(|f| Compiled {
            id: f.id.clone(),
            transport: if f.transport == "tcp" { 6 } else { 17 },
            ports: f.ports.clone(),
            patterns: f
                .patterns
                .iter()
                .map(|p| (p.offset, decode(&p.hex).unwrap(), decode(&p.mask).unwrap()))
                .collect(),
        })
        .collect())
}
pub fn candidate<'a>(
    features: &'a [Compiled],
    packet: &[u8],
    protocol: u8,
    port: u16,
) -> Option<&'a Compiled> {
    if features.is_empty() {
        return None;
    }
    let network = match packet.first()? >> 4 {
        4 if packet.len() >= 20 && u16::from_be_bytes([packet[6], packet[7]]) & 0x3fff == 0 => {
            (packet[0] & 15) as usize * 4
        }
        6 if packet.len() >= 40 => 40,
        _ => return None,
    };
    if network < 20 {
        return None;
    }
    let payload = match protocol {
        6 => (packet.get(network + 12)? >> 4) as usize * 4,
        17 => 8,
        _ => return None,
    };
    if protocol == 6 && payload < 20 {
        return None;
    }
    let payload = packet.get(network + payload..)?;
    features.iter().find(|f| {
        f.transport == protocol
            && f.ports.contains(&port)
            && f.patterns.iter().all(|(offset, bytes, mask)| {
                payload
                    .get(*offset..*offset + bytes.len())
                    .is_some_and(|data| {
                        data.iter()
                            .zip(bytes.iter().zip(mask))
                            .all(|(value, (expected, mask))| value & mask == expected & mask)
                    })
            })
    })
}
