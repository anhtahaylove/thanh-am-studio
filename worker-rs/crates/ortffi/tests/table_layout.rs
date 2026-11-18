//! The hand-listed table slots must match the member order of `struct OrtApi` in the vendored
//! header. This re-parses the header independently of `tools/gen_api_table.py`.

use ortffi::raw::table::{SLOT_COUNT, USED_SLOTS};
use std::path::Path;

fn strip_comments(src: &str) -> String {
    let mut out = String::new();
    let mut rest = src;
    while !rest.is_empty() {
        if let Some(after) = rest.strip_prefix("/*") {
            rest = after.split_once("*/").expect("unterminated comment").1;
        } else if let Some(after) = rest.strip_prefix("//") {
            rest = after.split_once('\n').map_or("", |x| x.1);
            out.push('\n');
        } else {
            let c = rest.chars().next().unwrap();
            out.push(c);
            rest = &rest[c.len_utf8()..];
        }
    }
    out
}

fn member_name(stmt: &str) -> String {
    let args = |s: &str| s[s.find('(').unwrap() + 1..].split(',').map(|a| a.trim().to_owned()).collect::<Vec<_>>();
    if stmt.starts_with("ORT_API2_STATUS(") {
        args(stmt)[0].clone()
    } else if stmt.starts_with("ORT_CLASS_RELEASE(") {
        format!("Release{}", args(stmt)[0].trim_end_matches(')'))
    } else if stmt.starts_with("ORT_API_T(") {
        args(stmt)[1].clone()
    } else {
        let tail = stmt.split("ORT_API_CALL").nth(1).unwrap_or_else(|| panic!("unparsed member: {stmt}"));
        tail.trim_start().trim_start_matches('*').trim_start().split(')').next().unwrap().trim().to_owned()
    }
}

fn header_members() -> Vec<String> {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("third_party/onnxruntime_c_api.h");
    let src = strip_comments(&std::fs::read_to_string(path).unwrap());
    let start = src.find("\nstruct OrtApi {").unwrap();
    let body_start = start + src[start..].find('{').unwrap() + 1;
    let mut depth = 1;
    let mut end = body_start;
    for (i, c) in src[body_start..].char_indices() {
        depth += i32::from(c == '{') - i32::from(c == '}');
        if depth == 0 {
            end = body_start + i;
            break;
        }
    }
    src[body_start..end]
        .split(';')
        .map(|s| s.split_whitespace().collect::<Vec<_>>().join(" "))
        .filter(|s| !s.is_empty())
        .map(|s| member_name(&s))
        .collect()
}

#[test]
fn used_slots_match_the_header_member_order() {
    let members = header_members();
    assert_eq!(members.len(), 428, "OrtApi member count in the v1.31.1 header");
    for (name, index) in USED_SLOTS {
        assert_eq!(members[*index], *name, "slot {index}");
    }
    assert_eq!(SLOT_COUNT, USED_SLOTS.last().unwrap().1 + 1);
    // Anchors every ORT release has had since 1.0: a wrong parse would shift these.
    assert_eq!(members[0], "CreateStatus");
    assert_eq!(members[3], "CreateEnv");
    assert_eq!(members[9], "Run");
}
