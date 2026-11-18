//! Python 3.11's character classes and the `str` helpers the TTS text rules use, from the tables `gen_pyuni.py` generates with the
//! private runtime. Rust's own `char` predicates follow a newer Unicode and other definitions (the regex crate's `\w` includes marks,
//! Python's `isspace` includes U+001C..U+001F), so the port asks these instead.

#[rustfmt::skip]
mod tables {
    include!("pyuni_tables.rs");
}

fn within(table: &[(u32, u32)], c: char) -> bool {
    let c = c as u32;
    table
        .binary_search_by(|&(a, b)| {
            if b < c {
                std::cmp::Ordering::Less
            } else if a > c {
                std::cmp::Ordering::Greater
            } else {
                std::cmp::Ordering::Equal
            }
        })
        .is_ok()
}

/// `c.isspace()` (also `re`'s `\s`).
pub fn is_space(c: char) -> bool {
    within(tables::SPACE, c)
}

/// `c.isalpha()`.
pub fn is_alpha(c: char) -> bool {
    within(tables::ALPHA, c)
}

/// `c.isdigit()`.
pub fn is_digit(c: char) -> bool {
    within(tables::DIGIT, c)
}

/// The value of a `str.isdecimal()` character (`re`'s `\d`), or `None`.
pub fn decimal(c: char) -> Option<u32> {
    let c = c as u32;
    tables::DECIMAL.iter().find(|&&(a, b, _)| a <= c && c <= b).map(|&(a, _, v)| v + c - a)
}

/// The code points `re.IGNORECASE` matches the pattern letter `letter` with (only the letters of the pause-mark patterns are known).
pub fn fold_set(letter: char) -> &'static [u32] {
    tables::FOLD.iter().find(|(l, _)| *l == letter).expect("a letter of the pause-mark patterns").1
}

/// The ranges of `\s`, for building regex classes.
pub fn space_ranges() -> impl Iterator<Item = (u32, u32)> {
    tables::SPACE.iter().copied()
}

/// The ranges of `\w`.
pub fn word_ranges() -> impl Iterator<Item = (u32, u32)> {
    tables::ALNUM.iter().copied()
}

/// The ranges of `\d`.
pub fn decimal_ranges() -> impl Iterator<Item = (u32, u32)> {
    tables::DECIMAL.iter().map(|&(a, b, _)| (a, b))
}

/// `s.strip()`.
pub fn strip(s: &str) -> &str {
    s.trim_matches(is_space)
}

/// `s.rstrip()`.
pub fn rstrip(s: &str) -> &str {
    s.trim_end_matches(is_space)
}

/// `s.split()`: runs of whitespace separate, none at the ends.
pub fn split(s: &str) -> impl Iterator<Item = &str> {
    s.split(is_space).filter(|w| !w.is_empty())
}

/// `len(s)`: code points.
pub fn len(s: &str) -> usize {
    s.chars().count()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classes_follow_python_not_rust() {
        assert!(is_space('\u{1c}') && !'\u{1c}'.is_whitespace());
        assert!(is_space('\u{3000}') && !is_space('\u{200b}'));
        assert!(!within(tables::ALNUM, '\u{301}')); // a combining mark is not \w in Python
        assert!(within(tables::ALNUM, '_') && within(tables::ALNUM, '½') && !is_alpha('½'));
        assert_eq!(
            (decimal('7'), decimal('\u{663}'), decimal('\u{ff19}'), decimal('a')),
            (Some(7), Some(3), Some(9), None)
        );
        assert!(is_digit('²') && decimal('²').is_none());
        assert_eq!(fold_set('i'), [0x49, 0x69, 0x130, 0x131]);
        assert_eq!(fold_set('s'), [0x53, 0x73, 0x17f]);
        assert_eq!(split(" a\u{3000}b  c\u{1f}").collect::<Vec<_>>(), ["a", "b", "c"]);
        assert_eq!((strip("\u{85} x \u{a0}"), len("Việt")), ("x", 4));
    }
}
