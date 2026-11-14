use miniz_oxide::deflate::compress_to_vec;
use thanh_am_studio::docx::{docx_text, MAX_DOCUMENT_XML};

const NS: &str = r#"xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main""#;

fn body(inner: &str) -> Vec<u8> {
    format!(r#"<?xml version="1.0" encoding="UTF-8"?><w:document {NS}><w:body>{inner}</w:body></w:document>"#).into_bytes()
}

/// Builds a zip with `[Content_Types].xml` (stored) first and `word/document.xml` (stored or deflated) second.
fn zip(xml: &[u8], deflate: bool) -> Vec<u8> {
    let entries: [(&str, &[u8], bool); 2] = [("[Content_Types].xml", b"<Types/>", false), ("word/document.xml", xml, deflate)];
    let (mut out, mut central) = (Vec::new(), Vec::new());
    for (name, data, packed) in entries {
        let body = if packed { compress_to_vec(data, 6) } else { data.to_vec() };
        let method: u16 = if packed { 8 } else { 0 };
        let offset = out.len() as u32;
        out.extend([b"PK\x03\x04".as_slice(), &20u16.to_le_bytes(), &0u16.to_le_bytes(), &method.to_le_bytes(), &[0; 8]].concat());
        out.extend([&(body.len() as u32).to_le_bytes()[..], &(data.len() as u32).to_le_bytes(), &(name.len() as u16).to_le_bytes(), &0u16.to_le_bytes()].concat());
        out.extend(name.as_bytes());
        out.extend(&body);
        central.extend([b"PK\x01\x02".as_slice(), &20u16.to_le_bytes(), &20u16.to_le_bytes(), &0u16.to_le_bytes(), &method.to_le_bytes(), &[0; 8]].concat());
        central.extend([&(body.len() as u32).to_le_bytes()[..], &(data.len() as u32).to_le_bytes(), &(name.len() as u16).to_le_bytes(), &[0; 12], &offset.to_le_bytes()].concat());
        central.extend(name.as_bytes());
    }
    let cd_offset = out.len() as u32;
    out.extend(&central);
    out.extend([b"PK\x05\x06".as_slice(), &[0; 4], &2u16.to_le_bytes(), &2u16.to_le_bytes(), &(central.len() as u32).to_le_bytes(), &cd_offset.to_le_bytes(), &0u16.to_le_bytes()].concat());
    out
}

fn text(inner: &str, deflate: bool) -> String {
    docx_text(&zip(&body(inner), deflate)).unwrap()
}

#[test]
fn reads_paragraphs_stored_and_deflated() {
    let inner = r#"<w:p><w:r><w:t>Xin chào</w:t></w:r><w:r><w:tab/><w:t xml:space="preserve">các bạn</w:t></w:r></w:p><w:p/><w:p><w:r><w:t>Một</w:t><w:br/><w:t>hai</w:t></w:r></w:p>"#;
    for deflate in [false, true] {
        assert_eq!(text(inner, deflate), "Xin chào các bạn\n\nMột\nhai");
    }
}

#[test]
fn table_row_is_one_line_with_cells_joined() {
    let cell = |t: &str| format!("<w:tc><w:p><w:r><w:t>{t}</w:t></w:r></w:p></w:tc>");
    let two = "<w:tc><w:p><w:r><w:t>a</w:t></w:r></w:p><w:p><w:r><w:t>b</w:t></w:r></w:p></w:tc>";
    let inner = format!("<w:p><w:r><w:t>trước</w:t></w:r></w:p><w:tbl><w:tr>{}{}</w:tr><w:tr>{}{two}</w:tr></w:tbl><w:p><w:r><w:t>sau</w:t></w:r></w:p>", cell("An"), cell("Xin chào"), cell("Bình"));
    assert_eq!(text(&inner, true), "trước\nAn, Xin chào\nBình, a b\nsau");
}

#[test]
fn keeps_inserted_skips_deleted_fields_and_text_boxes() {
    let inner = r#"<w:p><w:r><w:t>Giữ </w:t></w:r><w:ins w:id="1"><w:r><w:t>mới</w:t></w:r></w:ins><w:del w:id="2"><w:r><w:delText>cũ</w:delText></w:r></w:del>
        <w:r><w:fldChar w:fldCharType="begin"/><w:instrText> PAGE </w:instrText><w:fldChar w:fldCharType="end"/></w:r>
        <w:r><mc:AlternateContent xmlns:mc="m"><mc:Choice><w:drawing><w:txbxContent><w:p><w:r><w:t>hộp chữ</w:t></w:r></w:p></w:txbxContent></w:drawing></mc:Choice></mc:AlternateContent></w:r>
        <w:r><w:t>.</w:t></w:r></w:p>"#;
    assert_eq!(text(inner, false), "Giữ mới.");
}

#[test]
fn decodes_entities() {
    assert_eq!(text("<w:p><w:r><w:t>A &amp; B &lt;c&gt; &quot;d&quot; &apos;e&apos; &#7843; &#x1EA3;</w:t></w:r></w:p>", false), "A & B <c> \"d\" 'e' ả ả");
}

#[test]
fn rejects_malformed_zips() {
    let good = zip(&body("<w:p/>"), true);
    assert_eq!(docx_text(b"just a text file, not a zip"), Err("INVALID_DOCX".into()));
    assert_eq!(docx_text(&[]), Err("INVALID_DOCX".into()));
    assert_eq!(docx_text(&good[..good.len() - 10]), Err("INVALID_DOCX".into()));
    let eocd = good.len() - 22;
    let patch = |at: usize, bytes: &[u8]| {
        let mut z = good.clone();
        z[at..at + bytes.len()].copy_from_slice(bytes);
        z
    };
    // central directory offset and size beyond the file
    assert_eq!(docx_text(&patch(eocd + 16, &u32::MAX.to_le_bytes())), Err("INVALID_DOCX".into()));
    assert_eq!(docx_text(&patch(eocd + 16, &(good.len() as u32).to_le_bytes())), Err("INVALID_DOCX".into()));
    // the entry's local header offset and packed size beyond the file
    let cd = u32::from_le_bytes(good[eocd + 16..eocd + 20].try_into().unwrap()) as usize;
    let second = cd + 46 + "[Content_Types].xml".len();
    assert_eq!(docx_text(&patch(second + 42, &(good.len() as u32 - 1).to_le_bytes())), Err("INVALID_DOCX".into()));
    assert_eq!(docx_text(&patch(second + 20, &(good.len() as u32 - 1).to_le_bytes())), Err("INVALID_DOCX".into()));
    // encrypted, unsupported method, declared size that does not match
    assert_eq!(docx_text(&patch(second + 8, &1u16.to_le_bytes())), Err("INVALID_DOCX".into()));
    assert_eq!(docx_text(&patch(second + 10, &9u16.to_le_bytes())), Err("INVALID_DOCX".into()));
    assert_eq!(docx_text(&patch(second + 24, &7u32.to_le_bytes())), Err("INVALID_DOCX".into()));
    // zip64: sentinel sizes in the end record, and a zip64 locator before it
    assert_eq!(docx_text(&patch(eocd + 10, &0xFFFFu16.to_le_bytes())), Err("INVALID_DOCX".into()));
    let mut z = good[..eocd].to_vec();
    z.extend([b"PK\x06\x07".as_slice(), &[0; 16]].concat());
    z.extend(&good[eocd..]);
    assert_eq!(docx_text(&z), Err("INVALID_DOCX".into()));
}

#[test]
fn rejects_missing_document_and_bad_xml() {
    let mut z = zip(&body("<w:p/>"), false);
    // rename the part in both the local and the central header
    for i in 0..z.len() - 17 {
        if &z[i..i + 17] == b"word/document.xml" {
            z[i + 5] = b'x';
        }
    }
    assert_eq!(docx_text(&z), Err("INVALID_DOCX".into()));
    assert_eq!(docx_text(&zip(b"<w:document><w:p></w:document>", false)), Err("INVALID_DOCX".into()));
    assert_eq!(docx_text(&zip(&[0xFF, 0xFE, 0x00], false)), Err("INVALID_DOCX".into()));
}

#[test]
fn stops_inflating_past_the_cap() {
    // 64 MiB + 1 byte of spaces deflates to a few tens of KiB: the declared size is truthful but over the cap.
    let mut big = body("<w:p/>");
    big.resize(MAX_DOCUMENT_XML + 1, b' ');
    assert_eq!(docx_text(&zip(&big, true)), Err("DOCX_TOO_LARGE".into()));
    // A lying central directory (small declared size, huge stream) is stopped by the cap while inflating.
    let mut z = zip(&big, true);
    let eocd = z.len() - 22;
    let cd = u32::from_le_bytes(z[eocd + 16..eocd + 20].try_into().unwrap()) as usize;
    let second = cd + 46 + "[Content_Types].xml".len();
    z[second + 24..second + 28].copy_from_slice(&100u32.to_le_bytes());
    assert_eq!(docx_text(&z), Err("DOCX_TOO_LARGE".into()));
    assert_eq!(docx_text(&{
        let mut ok = body("<w:p><w:r><w:t>vừa</w:t></w:r></w:p>");
        ok.resize(MAX_DOCUMENT_XML, b' ');
        zip(&ok, true)
    }), Ok("vừa".into()));
}
