//! Python-compatible text and number helpers, so the FFmpeg command lines and messages match `worker/main.py`.

use serde_json::Value;

/// Python's `repr(float)`: shortest round-trip digits, exponent form below 1e-4 and from 1e16.
pub fn float_repr(x: f64) -> String {
    if x == 0.0 {
        return if x.is_sign_negative() { "-0.0".into() } else { "0.0".into() };
    }
    if !x.is_finite() {
        return if x.is_nan() {
            "nan".into()
        } else if x < 0.0 {
            "-inf".into()
        } else {
            "inf".into()
        };
    }
    // `{:e}` yields the shortest digits that round-trip: "-1.2345e-5".
    let sci = format!("{x:e}");
    let (mantissa, exp) = sci.split_once('e').expect("scientific format");
    let exp: i32 = exp.parse().expect("exponent");
    let (sign, mantissa) = mantissa.strip_prefix('-').map_or(("", mantissa), |m| ("-", m));
    let digits: String = mantissa.chars().filter(|c| *c != '.').collect();
    if (-4..16).contains(&exp) {
        let point = exp + 1; // digits before the decimal point
        let body = if point <= 0 {
            format!("0.{}{}", "0".repeat((-point) as usize), digits)
        } else if point as usize >= digits.len() {
            format!("{}{}.0", digits, "0".repeat(point as usize - digits.len()))
        } else {
            format!("{}.{}", &digits[..point as usize], &digits[point as usize..])
        };
        format!("{sign}{body}")
    } else {
        let frac = if digits.len() > 1 { format!(".{}", &digits[1..]) } else { String::new() };
        let frac = frac.trim_end_matches('0').trim_end_matches('.').to_string();
        format!("{sign}{}{frac}e{}{:02}", &digits[..1], if exp < 0 { '-' } else { '+' }, exp.abs())
    }
}

/// The last `n` characters (Python's `text[-n:]`).
pub fn tail_chars(text: &str, n: usize) -> &str {
    let count = text.chars().count();
    if count <= n {
        return text;
    }
    let skip = count - n;
    let at = text.char_indices().nth(skip).map_or(text.len(), |(i, _)| i);
    &text[at..]
}

/// Universal newlines as `subprocess.run(text=True)` reads them: `\r\n` and lone `\r` become `\n`.
pub fn universal_newlines(text: &str) -> String {
    text.replace("\r\n", "\n").replace('\r', "\n")
}

/// Python truthiness of a JSON value (`if payload.get('normalize', False):`).
pub fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|x| x != 0.0),
        Value::String(s) => !s.is_empty(),
        Value::Array(a) => !a.is_empty(),
        Value::Object(o) => !o.is_empty(),
    }
}

/// Python's `round(x)` for a float: halves go to the even neighbour.
pub fn round_half_even(x: f64) -> i64 {
    x.round_ties_even() as i64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn float_repr_matches_python() {
        let cases: &[(f64, &str)] = &[
            (0.0, "0.0"),
            (1.0, "1.0"),
            (-1.5, "-1.5"),
            (0.1, "0.1"),
            (0.001, "0.001"),
            (0.0001, "0.0001"),
            (0.00001, "1e-05"),
            (1.5e-7, "1.5e-07"),
            (123456789.0, "123456789.0"),
            (1e15, "1000000000000000.0"),
            (1e16, "1e+16"),
            (1.2345678901234568e22, "1.2345678901234568e+22"),
            (86400.0, "86400.0"),
            (0.3333333333333333, "0.3333333333333333"),
            (2.5, "2.5"),
            (-0.0, "-0.0"),
            (100.0 / 3.0, "33.333333333333336"),
        ];
        for (x, want) in cases {
            assert_eq!(float_repr(*x), *want, "{x:e}");
        }
    }

    #[test]
    fn tail_counts_characters_not_bytes() {
        assert_eq!(tail_chars("abcdef", 3), "def");
        assert_eq!(tail_chars("ab", 3), "ab");
        assert_eq!(tail_chars("Việt Nam", 3), "Nam");
        assert_eq!(tail_chars("Việt Nam", 7), "iệt Nam");
    }

    #[test]
    fn newlines_and_truthiness() {
        assert_eq!(universal_newlines("a\r\nb\rc\n"), "a\nb\nc\n");
        assert!(!truthy(&Value::Null) && !truthy(&serde_json::json!(0)) && !truthy(&serde_json::json!("")));
        assert!(truthy(&serde_json::json!(1)) && truthy(&serde_json::json!("x")) && truthy(&serde_json::json!([0])));
    }

    #[test]
    fn rounding_goes_to_even() {
        assert_eq!([0.5, 1.5, 2.5, -0.5, 2.4, 2.6].map(round_half_even), [0, 2, 2, 0, 2, 3]);
    }
}
