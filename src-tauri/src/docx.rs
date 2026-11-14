//! Plain-text reader for Word (.docx) scripts: std zip walking plus miniz_oxide and quick-xml.
use quick_xml::{events::Event, Reader};

/// Cap on the uncompressed size of `word/document.xml`, enforced while inflating (zip bomb guard).
pub const MAX_DOCUMENT_XML: usize = 64 * 1024 * 1024;
const INVALID: &str = "INVALID_DOCX";

fn u16_at(b: &[u8], i: usize) -> Result<usize, String> {
    b.get(i..i + 2).map(|s| u16::from_le_bytes([s[0], s[1]]) as usize).ok_or(INVALID.into())
}

fn u32_at(b: &[u8], i: usize) -> Result<usize, String> {
    b.get(i..i + 4).map(|s| u32::from_le_bytes([s[0], s[1], s[2], s[3]]) as usize).ok_or(INVALID.into())
}

/// Returns the uncompressed bytes of `word/document.xml`.
fn document_xml(zip: &[u8]) -> Result<Vec<u8>, String> {
    // End-of-central-directory record: 22 bytes plus a comment of up to 65535 bytes.
    let eocd = (0..=zip.len().saturating_sub(22))
        .rev()
        .take(22 + 65535)
        .find(|&i| zip.get(i..i + 4) == Some(b"PK\x05\x06") && u16_at(zip, i + 20).is_ok_and(|n| i + 22 + n == zip.len()))
        .ok_or(INVALID)?;
    if zip[eocd.saturating_sub(20)..].starts_with(b"PK\x06\x07") && eocd >= 20 {
        return Err(INVALID.into()); // zip64 locator
    }
    let (entries, cd_size, cd_offset) = (u16_at(zip, eocd + 10)?, u32_at(zip, eocd + 12)?, u32_at(zip, eocd + 16)?);
    if u16_at(zip, eocd + 4)? != 0 || u16_at(zip, eocd + 6)? != 0 || u16_at(zip, eocd + 8)? != entries || entries == 0xFFFF || cd_size == 0xFFFF_FFFF || cd_offset == 0xFFFF_FFFF {
        return Err(INVALID.into()); // multi-disk or zip64
    }
    if cd_offset.checked_add(cd_size).is_none_or(|end| end > eocd) {
        return Err(INVALID.into());
    }
    let mut at = cd_offset;
    for _ in 0..entries {
        if zip.get(at..at + 4) != Some(b"PK\x01\x02") {
            return Err(INVALID.into());
        }
        let (flags, method, packed, size) = (u16_at(zip, at + 8)?, u16_at(zip, at + 10)?, u32_at(zip, at + 20)?, u32_at(zip, at + 24)?);
        let (name_len, extra_len, comment_len, local) = (u16_at(zip, at + 28)?, u16_at(zip, at + 30)?, u16_at(zip, at + 32)?, u32_at(zip, at + 42)?);
        let name = zip.get(at + 46..at + 46 + name_len).ok_or(INVALID)?;
        at += 46 + name_len + extra_len + comment_len;
        if name != b"word/document.xml" {
            continue;
        }
        if flags & 0x41 != 0 || packed == 0xFFFF_FFFF || size == 0xFFFF_FFFF || local == 0xFFFF_FFFF {
            return Err(INVALID.into()); // encrypted or zip64
        }
        if size > MAX_DOCUMENT_XML {
            return Err("DOCX_TOO_LARGE".into());
        }
        if zip.get(local..local + 4) != Some(b"PK\x03\x04") {
            return Err(INVALID.into());
        }
        let start = local + 30 + u16_at(zip, local + 26)? + u16_at(zip, local + 28)?;
        let data = zip.get(start..start.checked_add(packed).ok_or(INVALID)?).ok_or(INVALID)?;
        let xml = match method {
            0 => data.to_vec(),
            8 => miniz_oxide::inflate::decompress_to_vec_with_limit(data, MAX_DOCUMENT_XML).map_err(|e| {
                if e.status == miniz_oxide::inflate::TINFLStatus::HasMoreOutput { "DOCX_TOO_LARGE".to_string() } else { INVALID.to_string() }
            })?,
            _ => return Err(INVALID.into()),
        };
        return if xml.len() == size { Ok(xml) } else { Err(INVALID.into()) };
    }
    Err(INVALID.into())
}

/// Plain text of a .docx: one line per paragraph, a table row joined with ", " into one line.
pub fn docx_text(zip: &[u8]) -> Result<String, String> {
    let xml = String::from_utf8(document_xml(zip)?).map_err(|_| INVALID.to_string())?;
    let mut reader = Reader::from_str(&xml);
    reader.config_mut().expand_empty_elements = true;
    let (mut lines, mut row, mut cell, mut para) = (Vec::<String>::new(), Vec::<String>::new(), String::new(), String::new());
    let (mut in_t, mut skip, mut deleted, mut rows, mut cells) = (false, 0usize, 0usize, 0usize, 0usize);
    loop {
        match reader.read_event().map_err(|_| INVALID.to_string())? {
            Event::Eof => break,
            Event::Start(e) => match e.name().as_ref() {
                "w:txbxContent" => skip += 1,
                _ if skip > 0 => {}
                "w:del" | "w:moveFrom" => deleted += 1,
                "w:p" => para.clear(),
                "w:t" => in_t = true,
                "w:tab" => para.push(' '),
                "w:br" | "w:cr" => para.push('\n'),
                "w:tr" => {
                    rows += 1;
                    if rows == 1 {
                        row.clear();
                    }
                }
                "w:tc" => {
                    cells += 1;
                    if cells == 1 {
                        cell.clear();
                    }
                }
                _ => {}
            },
            Event::End(e) => match e.name().as_ref() {
                "w:txbxContent" => skip = skip.saturating_sub(1),
                _ if skip > 0 => {}
                "w:del" | "w:moveFrom" => deleted = deleted.saturating_sub(1),
                "w:t" => in_t = false,
                "w:p" if cells > 0 => {
                    if !para.is_empty() {
                        if !cell.is_empty() {
                            cell.push(' ');
                        }
                        cell.push_str(&para);
                    }
                }
                "w:p" => lines.push(std::mem::take(&mut para)),
                "w:tc" => {
                    cells = cells.saturating_sub(1);
                    if cells == 0 {
                        row.push(std::mem::take(&mut cell));
                    }
                }
                "w:tr" => {
                    rows = rows.saturating_sub(1);
                    if rows == 0 {
                        lines.push(row.join(", "));
                    }
                }
                _ => {}
            },
            Event::Text(t) if in_t && skip == 0 && deleted == 0 => para.push_str(&t),
            Event::GeneralRef(r) if in_t && skip == 0 && deleted == 0 => match (r.resolve_char_ref().map_err(|_| INVALID.to_string())?, &*r) {
                (Some(c), _) => para.push(c),
                (None, "lt") => para.push('<'),
                (None, "gt") => para.push('>'),
                (None, "amp") => para.push('&'),
                (None, "quot") => para.push('"'),
                (None, "apos") => para.push('\''),
                _ => {}
            },
            _ => {}
        }
    }
    Ok(lines.join("\n"))
}
