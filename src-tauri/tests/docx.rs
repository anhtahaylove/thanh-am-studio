use miniz_oxide::deflate::compress_to_vec;
use thanh_am_studio::docx::{docx_text, MAX_DOCUMENT_XML, MAX_TEXT};

const NS: &str = r#"xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main""#;

fn body(inner: &str) -> Vec<u8> {
    format!(r#"<?xml version="1.0" encoding="UTF-8"?><w:document {NS}><w:body>{inner}</w:body></w:document>"#).into_bytes()
}

/// Builds a zip with `[Content_Types].xml` (stored) first and `word/document.xml` (stored or deflated) second.
fn zip(xml: &[u8], deflate: bool) -> Vec<u8> {
    zip_parts(&[("[Content_Types].xml", b"<Types/>", false), ("word/document.xml", xml, deflate)])
}

/// Builds a zip of `(name, data, deflate)` entries in that order.
fn zip_parts(entries: &[(&str, &[u8], bool)]) -> Vec<u8> {
    let (mut out, mut central) = (Vec::new(), Vec::new());
    for &(name, data, packed) in entries {
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
    out.extend([b"PK\x05\x06".as_slice(), &[0; 4], &(entries.len() as u16).to_le_bytes(), &(entries.len() as u16).to_le_bytes(), &(central.len() as u32).to_le_bytes(), &cd_offset.to_le_bytes(), &0u16.to_le_bytes()].concat());
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

#[test]
fn text_over_the_txt_limit_stops_early() {
    // more than 10 M empty paragraphs would be 10 MB of newlines; a single huge w:t is the other amplification.
    let paras = "<w:p/>".repeat(MAX_TEXT + 2);
    assert_eq!(docx_text(&zip(&body(&paras), true)), Err("TEXT_FILE_TOO_LARGE".into()));
    let run = format!("<w:p><w:r><w:t>{}</w:t></w:r></w:p>", "a".repeat(MAX_TEXT + 1));
    assert_eq!(docx_text(&zip(&body(&run), true)), Err("TEXT_FILE_TOO_LARGE".into()));
    let ok = format!("<w:p><w:r><w:t>{}</w:t></w:r></w:p>", "a".repeat(MAX_TEXT - 1));
    assert_eq!(docx_text(&zip(&body(&ok), true)).unwrap().len(), MAX_TEXT - 1);
}

#[test]
fn empty_and_merged_cells_leave_no_separators() {
    let cell = |t: &str| format!("<w:tc><w:p><w:r><w:t>{t}</w:t></w:r></w:p></w:tc>");
    let merged = "<w:tc><w:tcPr><w:vMerge/></w:tcPr><w:p/></w:tc>";
    let inner = format!("<w:tbl><w:tr>{}{}{merged}</w:tr><w:tr>{merged}{}</w:tr><w:tr>{merged}{merged}</w:tr></w:tbl><w:p><w:r><w:t>sau</w:t></w:r></w:p>", cell("An"), cell("Xin chào"), cell(" "));
    assert_eq!(text(&inner, false), "An, Xin chào\nsau");
}

#[test]
fn breaks_and_tabs_only_count_inside_live_runs() {
    let inner = r#"<w:p><w:pPr><w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs></w:pPr><w:r><w:t>a</w:t></w:r><w:del w:id="1"><w:r><w:br/><w:tab/><w:delText>x</w:delText></w:r></w:del><w:r><w:t>b</w:t></w:r></w:p>"#;
    assert_eq!(text(inner, false), "ab");
}

#[test]
fn hyphens_and_position_tabs_are_kept() {
    assert_eq!(text("<w:p><w:r><w:t>e</w:t><w:noBreakHyphen/><w:t>mail</w:t><w:ptab/><w:t>x</w:t></w:r></w:p>", false), "e-mail x");
}

#[test]
fn a_break_inside_a_cell_keeps_the_row_on_one_line() {
    let inner = "<w:tbl><w:tr><w:tc><w:p><w:r><w:t>a</w:t><w:br/><w:t>b</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>c</w:t></w:r></w:p></w:tc></w:tr></w:tbl>";
    assert_eq!(text(inner, false), "a b, c");
}

#[test]
fn alternate_content_fallback_is_skipped() {
    let inner = r#"<w:p><mc:AlternateContent xmlns:mc="m"><mc:Choice><w:r><w:t>Một</w:t></w:r></mc:Choice><mc:Fallback><w:r><w:t>Một</w:t></w:r></mc:Fallback></mc:AlternateContent><w:r><w:t>.</w:t></w:r></w:p>"#;
    assert_eq!(text(inner, false), "Một.");
}

#[test]
fn hidden_runs_are_skipped_but_a_hidden_paragraph_mark_keeps_its_text() {
    let inner = r#"<w:p><w:r><w:t xml:space="preserve">Hiện </w:t></w:r><w:r><w:rPr><w:vanish/></w:rPr><w:t xml:space="preserve">ẩn &amp; </w:t><w:tab/><w:br/><w:noBreakHyphen/></w:r><w:r><w:rPr><w:vanish w:val="false"/></w:rPr><w:t>vẫn hiện</w:t></w:r></w:p><w:p><w:pPr><w:rPr><w:vanish/></w:rPr></w:pPr><w:r><w:t>Dòng hai</w:t></w:r></w:p>"#;
    assert_eq!(text(inner, false), "Hiện vẫn hiện\nDòng hai");
}

#[test]
fn a_tracked_change_that_unhid_a_run_keeps_it() {
    let inner = r#"<w:p><w:r><w:rPr><w:b/><w:rPrChange w:id="3" w:author="a"><w:rPr><w:vanish/></w:rPr></w:rPrChange></w:rPr><w:t>Hiện lại</w:t></w:r></w:p>"#;
    assert_eq!(text(inner, false), "Hiện lại");
}

#[test]
fn val_zero_shows_a_run_and_a_wholly_hidden_paragraph_is_not_read() {
    // `w:val="0"` is what Word writes when direct formatting shows a run whose style hides it
    let inner = r#"<w:p><w:r><w:rPr><w:vanish w:val="0"/></w:rPr><w:t>A</w:t></w:r></w:p><w:p><w:pPr><w:rPr><w:vanish/></w:rPr></w:pPr><w:r><w:rPr><w:vanish/></w:rPr><w:t>bí mật</w:t></w:r></w:p><w:p><w:r><w:t>B</w:t></w:r></w:p>"#;
    // the empty line left by the hidden paragraph is harmless: script lines split on runs of newlines
    assert_eq!(text(inner, false).lines().filter(|l| !l.is_empty()).collect::<Vec<_>>(), ["A", "B"]);
}

/// docx_text of a body with `word/styles.xml` holding `styles` (whole `w:style` elements) and the document defaults.
fn styled(styles: &str, hidden_defaults: bool, inner: &str) -> String {
    let defaults = if hidden_defaults { "<w:vanish/>" } else { "" };
    let xml = format!(r#"<w:styles {NS}><w:docDefaults><w:rPrDefault><w:rPr>{defaults}</w:rPr></w:rPrDefault></w:docDefaults>{styles}</w:styles>"#);
    docx_text(&zip_parts(&[("word/document.xml", &body(inner), true), ("word/styles.xml", xml.as_bytes(), true)])).unwrap()
}

/// `<w:style>` of `kind` with id `id`; `inner` follows its name (`w:basedOn`, `w:rPr`).
fn style(kind: &str, id: &str, inner: &str) -> String {
    format!(r#"<w:style w:type="{kind}" w:styleId="{id}"><w:name w:val="{id}"/>{inner}</w:style>"#)
}

/// A one-run paragraph with text `label`, paragraph properties `ppr` and run properties `rpr`.
fn p(label: &str, ppr: &str, rpr: &str) -> String {
    format!("<w:p><w:pPr>{ppr}</w:pPr><w:r><w:rPr>{rpr}</w:rPr><w:t>{label}</w:t></w:r></w:p>")
}

fn table(tblpr: &str, cells: &[String]) -> String {
    format!("<w:tbl><w:tblPr>{tblpr}</w:tblPr>{}</w:tbl>", cells.iter().map(|c| format!("<w:tr><w:tc>{c}</w:tc></w:tr>")).collect::<String>())
}

fn ps(id: &str) -> String {
    format!(r#"<w:pStyle w:val="{id}"/>"#)
}

fn rs(id: &str) -> String {
    format!(r#"<w:rStyle w:val="{id}"/>"#)
}

/// Asserts which labels docx_text keeps. The expected values are what Word 16 showed for the same markup (checked in Word itself).
fn shows(out: &str, cases: &[(&str, bool)]) {
    for &(label, shown) in cases {
        assert_eq!(out.contains(label), shown, "{label} in {out:?}");
    }
}

const HIDE: &str = "<w:rPr><w:vanish/></w:rPr>";
const SHOW: &str = r#"<w:rPr><w:vanish w:val="0"/></w:rPr>"#;

fn word_styles() -> String {
    [
        style("paragraph", "PH", HIDE),
        style("paragraph", "PH2", r#"<w:basedOn w:val="PH"/>"#),
        style("paragraph", "PH0", &format!(r#"<w:basedOn w:val="PH"/>{SHOW}"#)),
        style("paragraph", "PH1", &format!(r#"<w:basedOn w:val="PH"/>{HIDE}"#)),
        style("paragraph", "PV", ""),
        style("character", "CH", HIDE),
        style("character", "CH2", &format!(r#"<w:basedOn w:val="CH"/>{HIDE}"#)),
        style("character", "CHF", SHOW),
        style("table", "TH", HIDE),
    ]
    .concat()
}

#[test]
fn styles_hide_text_like_word_shows_it() {
    let (d0, d1) = (r#"<w:vanish w:val="0"/>"#, "<w:vanish/>");
    let inner = [
        p("a01", "", ""),
        p("a02", &ps("PH"), ""),
        p("a03", &ps("PH2"), ""),
        p("a04", &ps("PH0"), ""),
        p("a05", &ps("PH1"), ""),
        p("a06", "", &rs("CH")),
        p("a07", &ps("PH"), &rs("CH")),
        p("a08", &ps("PH"), d0),
        p("a09", &ps("PH"), d1),
        p("a10", "", &(rs("CH") + d0)),
        p("a11", "", &rs("CH2")),
        p("a12", &ps("PH"), &rs("CHF")),
        table(r#"<w:tblStyle w:val="TH"/>"#, &[p("a13", "", ""), p("a14", &ps("PH"), ""), p("a15", "", &rs("CH")), p("a16", &ps("PH"), &rs("CH"))]),
        p("a17", "", &rs("CHF")),
    ]
    .concat();
    let shown = ["a01", "a04", "a07", "a08", "a10", "a14", "a15", "a17"];
    let labels = (1..=17).map(|i| format!("a{i:02}")).collect::<Vec<_>>();
    shows(&styled(&word_styles(), false, &inner), &labels.iter().map(|l| (l.as_str(), shown.contains(&l.as_str()))).collect::<Vec<_>>());
}

#[test]
fn hidden_document_defaults_hide_every_run_but_a_shown_one() {
    let inner = [
        p("b01", "", ""),
        p("b02", &ps("PH"), ""),
        p("b03", "", &rs("CH")),
        p("b04", "", r#"<w:vanish w:val="0"/>"#),
        p("b05", &ps("PV"), ""),
        p("b06", &ps("PH"), &rs("CH")),
        table(r#"<w:tblStyle w:val="TH"/>"#, &[p("b07", "", "")]),
    ]
    .concat();
    shows(&styled(&word_styles(), true, &inner), &[("b01", false), ("b02", false), ("b03", false), ("b04", true), ("b05", false), ("b06", false), ("b07", false)]);
}

#[test]
fn default_and_unknown_styles_fall_back_like_word() {
    let styles = [
        format!(r#"<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/>{HIDE}</w:style>"#),
        format!(r#"<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/>{HIDE}</w:style>"#),
        style("paragraph", "PV", ""),
        style("paragraph", "PB", r#"<w:basedOn w:val="Normal"/>"#),
        style("paragraph", "PH", HIDE),
        style("character", "CH", HIDE),
    ]
    .concat();
    let inner = [
        p("c01", "", ""),
        p("c02", &ps("PV"), ""),
        p("c03", &ps("PB"), ""),
        p("c04", "", &rs("CH")),
        p("c05", &ps("PH"), ""),
        table("", &[p("c06", &ps("PV"), "")]),
        p("c07", &ps("Missing"), ""),
        p("c08", &ps("PV"), &rs("Missing")),
        table(r#"<w:tblStyle w:val="Missing"/>"#, &[p("c09", &ps("PV"), "")]),
    ]
    .concat();
    let out = styled(&styles, false, &inner);
    shows(&out, &[("c01", false), ("c02", true), ("c03", false), ("c04", true), ("c05", false), ("c06", false), ("c07", false), ("c08", true), ("c09", false)]);
}

#[test]
fn styles_before_a_tracked_change_and_conditional_table_formatting_are_not_current() {
    let styles = [
        style("paragraph", "PH", HIDE),
        style("paragraph", "PV", ""),
        style("table", "TH", HIDE),
        // a character style that was hidden before a tracked change, and a table style that hides only its first row
        style("character", "CV", r#"<w:rPr><w:rPrChange w:id="1"><w:rPr><w:vanish/></w:rPr></w:rPrChange></w:rPr>"#),
        style("table", "TF", r#"<w:tblStylePr w:type="firstRow"><w:rPr><w:vanish/></w:rPr></w:tblStylePr>"#),
    ]
    .concat();
    let inner = [
        p("d01", &format!(r#"{}<w:pPrChange w:id="2"><w:pPr>{}</w:pPr></w:pPrChange>"#, ps("PV"), ps("PH")), ""),
        p("d02", "", &rs("CV")),
        table(r#"<w:tblStyle w:val="TF"/><w:tblPrChange w:id="3"><w:tblPr><w:tblStyle w:val="TH"/></w:tblPr></w:tblPrChange>"#, &[p("d03", "", "")]),
    ]
    .concat();
    shows(&styled(&styles, false, &inner), &[("d01", true), ("d02", true), ("d03", true)]);
}

#[test]
fn a_based_on_loop_ends_and_broken_styles_are_rejected() {
    let styles = [style("paragraph", "A", r#"<w:basedOn w:val="B"/>"#), style("paragraph", "B", r#"<w:basedOn w:val="A"/>"#)].concat();
    assert_eq!(styled(&styles, false, &p("e01", &ps("A"), "")), "e01");
    let broken = zip_parts(&[("word/document.xml", &body(&p("e02", "", "")), false), ("word/styles.xml", b"<w:styles><w:style></w:styles>", false)]);
    assert_eq!(docx_text(&broken), Err("INVALID_DOCX".to_string()));
}
