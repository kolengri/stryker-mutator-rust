//! Conservative weapon-regex 2.0.6 level-one port, using Oxc's parsed regex AST.
//!
//! Proven grammar: one nonempty concatenation of ^/$ assertions, ASCII letters,
//! digits, space, `_`, `-`, escaped slash/backslash, positive/negative printable
//! ASCII character classes with ranges, \d/\D/\w/\W/\s/\S, and greedy ?/+/*
//! or canonical signed-32-bit counted quantifiers on atoms. Non-Unicode flags
//! g/i/m/s/d/y preserve their original order. Other escapes, groups, alternatives,
//! Unicode flags and unproven quantifiers reject the entire batch, including
//! when Regex is ignored. Do not infer support from
//! Oxc accepting a pattern: its grammar is broader than this port's proof.
//!
//! Rules and preorder follow weapon-regex v2.0.6's BuiltinMutators,
//! RegexTreeExtension, boundaryMutator, charClassMutator, predefCharClassMutator
//! and quantifierMutator (Apache-2.0; see NOTICE). Only quantifier removal is
//! level one; reluctant addition is level three. Preserve duplicates and order.

use oxc_ast::ast::RegExpLiteral;
use oxc_regular_expression::ast::{
    BoundaryAssertionKind, CharacterClassContents, CharacterClassContentsKind, Pattern, Quantifier,
    Term,
};
use oxc_span::{GetSpan, Span};

const UNSUPPORTED: &str =
    "Regex pattern or flags outside proven weapon-regex 2.0.6 level-one grammar";

struct Proven<'a> {
    text: &'a str,
    offset: u32,
    flags: &'a str,
}

impl Proven<'_> {
    fn text(&self, span: Span) -> Result<&str, String> {
        span.start
            .checked_sub(self.offset)
            .zip(span.end.checked_sub(self.offset))
            .and_then(|(start, end)| self.text.get(start as usize..end as usize))
            .ok_or_else(|| UNSUPPORTED.into())
    }

    fn character(&self, span: Span, in_class: bool) -> Result<(), String> {
        let raw = self.text(span)?;
        if matches!(raw, r"\/" | r"\\")
            || (raw.len() == 1
                && (raw.as_bytes()[0].is_ascii_alphanumeric()
                    || matches!(raw.as_bytes()[0], b' ' | b'_' | b'-')
                    || (in_class && matches!(raw.as_bytes()[0], b' '..=b'~'))))
        {
            Ok(())
        } else {
            Err(UNSUPPORTED.into())
        }
    }

    fn predefined(&self, span: Span) -> Result<&'static str, String> {
        match self.text(span)? {
            r"\d" => Ok(r"\D"),
            r"\D" => Ok(r"\d"),
            r"\w" => Ok(r"\W"),
            r"\W" => Ok(r"\w"),
            r"\s" => Ok(r"\S"),
            r"\S" => Ok(r"\s"),
            _ => Err(UNSUPPORTED.into()),
        }
    }

    fn quantifier(&self, quantifier: &Quantifier<'_>) -> Result<(), String> {
        let raw = self.text(Span::new(quantifier.body.span().end, quantifier.span.end))?;
        if matches!(raw, "?" | "+" | "*") {
            return Ok(());
        }
        // Weapon's Parser.number uses Numbers.nonNegativeIntString.toInt:
        // leading zeroes do not parse as counts, and overflow throws (and is
        // logged by Stryker). Oxc accepts both. Compare AST-derived canonical
        // spellings instead of parsing a second regex grammar here.
        if quantifier.min > i32::MAX as u64
            || quantifier.max.is_some_and(|max| max > i32::MAX as u64)
        {
            return Err(UNSUPPORTED.into());
        }
        let canonical = match quantifier.max {
            Some(max) if max == quantifier.min && raw == format!("{{{max}}}") => {
                return Ok(());
            }
            Some(max) => format!("{{{},{max}}}", quantifier.min),
            None => format!("{{{},}}", quantifier.min),
        };
        if raw == canonical {
            Ok(())
        } else {
            Err(UNSUPPORTED.into())
        }
    }

    fn validate(&self, term: &Term<'_>) -> Result<(), String> {
        match term {
            Term::BoundaryAssertion(boundary)
                if matches!(
                    boundary.kind,
                    BoundaryAssertionKind::Start | BoundaryAssertionKind::End
                ) =>
            {
                Ok(())
            }
            Term::Character(character) => self.character(character.span, false),
            Term::CharacterClassEscape(class) => self.predefined(class.span).map(|_| ()),
            Term::CharacterClass(class)
                if class.kind == CharacterClassContentsKind::Union && !class.body.is_empty() =>
            {
                for child in &class.body {
                    match child {
                        CharacterClassContents::Character(character) => {
                            self.character(character.span, true)?;
                        }
                        CharacterClassContents::CharacterClassRange(range) => {
                            // Weapon's range production only accepts unescaped
                            // character literals as its endpoints.
                            for endpoint in [&range.min, &range.max] {
                                if self.text(endpoint.span)?.len() != 1 {
                                    return Err(UNSUPPORTED.into());
                                }
                                self.character(endpoint.span, true)?;
                            }
                        }
                        CharacterClassContents::CharacterClassEscape(class) => {
                            self.predefined(class.span)?;
                        }
                        _ => return Err(UNSUPPORTED.into()),
                    }
                }
                Ok(())
            }
            Term::Quantifier(quantifier)
                if quantifier.greedy
                    && !matches!(
                        quantifier.body,
                        Term::BoundaryAssertion(_) | Term::Quantifier(_)
                    ) =>
            {
                self.quantifier(quantifier)?;
                self.validate(&quantifier.body)
            }
            _ => Err(UNSUPPORTED.into()),
        }
    }

    fn replace(&self, span: Span, replacement: &str, output: &mut Vec<String>) {
        // validate() proves every edit range belongs to the original pattern.
        let start = (span.start - self.offset) as usize;
        let end = (span.end - self.offset) as usize;
        output.push(format!(
            "/{}{}{}/{}",
            &self.text[..start],
            replacement,
            &self.text[end..],
            self.flags,
        ));
    }

    fn mutate_term(&self, term: &Term<'_>, output: &mut Vec<String>) {
        match term {
            Term::Quantifier(quantifier) => {
                self.replace(
                    Span::new(quantifier.body.span().end, quantifier.span.end),
                    "",
                    output,
                );
                self.mutate_term(&quantifier.body, output);
            }
            Term::CharacterClass(class) => {
                if class.negative {
                    self.replace(
                        Span::new(class.span.start + 1, class.span.start + 2),
                        "",
                        output,
                    );
                } else {
                    self.replace(Span::empty(class.span.start + 1), "^", output);
                }
                for child in &class.body {
                    if let CharacterClassContents::CharacterClassEscape(class) = child {
                        self.replace(class.span, self.predefined(class.span).unwrap(), output);
                    }
                }
            }
            Term::CharacterClassEscape(class) => {
                self.replace(class.span, self.predefined(class.span).unwrap(), output);
            }
            _ => {}
        }
    }

    fn mutate(&self, pattern: &Pattern<'_>) -> Result<Vec<String>, String> {
        if self.text.is_empty() || pattern.body.body.len() != 1 {
            return Err(UNSUPPORTED.into());
        }
        let terms = &pattern.body.body[0].body;
        if terms.is_empty() {
            return Err(UNSUPPORTED.into());
        }
        for term in terms {
            self.text(term.span())?;
            self.validate(term)?;
        }
        let mut output = vec![];
        // Weapon collapses singleton concatenations. Anchor removal operates on
        // a node's direct children, so a lone ^ or $ has no mutation.
        if terms.len() > 1 {
            for kind in [BoundaryAssertionKind::Start, BoundaryAssertionKind::End] {
                for term in terms {
                    if let Term::BoundaryAssertion(boundary) = term
                        && boundary.kind == kind
                    {
                        self.replace(boundary.span, "", &mut output);
                    }
                }
            }
        }
        for term in terms {
            self.mutate_term(term, &mut output);
        }
        Ok(output)
    }
}

pub(super) fn mutate(literal: &RegExpLiteral<'_>) -> Result<Vec<String>, String> {
    // The flag bitset prints in canonical order; Babel replacements retain the
    // original spelling. Oxc's parser-owned raw literal and pattern byte length
    // locate the suffix without scanning delimiters or reparsing the pattern.
    let text = literal.regex.pattern.text.as_str();
    let flags = literal
        .raw
        .as_ref()
        .and_then(|raw| raw.strip_prefix('/'))
        .and_then(|raw| raw.strip_prefix(text))
        .and_then(|raw| raw.strip_prefix('/'))
        .ok_or(UNSUPPORTED)?;
    if !flags.bytes().all(|flag| b"gimsdy".contains(&flag)) {
        return Err(UNSUPPORTED.into());
    }
    let pattern = literal.regex.pattern.pattern.as_ref().ok_or(UNSUPPORTED)?;
    Proven {
        text,
        offset: literal.span.start + 1,
        flags,
    }
    .mutate(pattern)
}

#[cfg(test)]
mod tests {
    use oxc_allocator::Allocator;
    use oxc_regular_expression::{LiteralParser, Options};

    use super::*;

    fn mutations(text: &str) -> Result<Vec<String>, String> {
        let allocator = Allocator::default();
        // Nonzero offsets exercise the parser-owned source coordinates.
        let pattern = LiteralParser::new(
            &allocator,
            text,
            Some(""),
            Options {
                pattern_span_offset: 37,
                ..Options::default()
            },
        )
        .parse()
        .map_err(|_| UNSUPPORTED.to_string())?;
        Proven {
            text,
            offset: 37,
            flags: "",
        }
        .mutate(&pattern)
    }

    #[test]
    fn level_one_rules_follow_tree_preorder() {
        assert_eq!(
            mutations(r"^[+-]?\d+$").unwrap(),
            [
                r"/[+-]?\d+$/",
                r"/^[+-]?\d+/",
                r"/^[+-]\d+$/",
                r"/^[^+-]?\d+$/",
                r"/^[+-]?\d$/",
                r"/^[+-]?\D+$/",
            ]
        );
        assert_eq!(
            mutations(r"a+\D?[ab]").unwrap(),
            [
                r"/a\D?[ab]/",
                r"/a+\D[ab]/",
                r"/a+\d?[ab]/",
                r"/a+\D?[^ab]/",
            ]
        );
    }

    #[test]
    fn singleton_anchors_and_duplicate_mutations_follow_upstream() {
        assert!(mutations("^").unwrap().is_empty());
        assert!(mutations("$").unwrap().is_empty());
        assert_eq!(mutations("$$").unwrap(), ["/$/", "/$/"]);
        assert_eq!(mutations("^^a$").unwrap(), ["/^a$/", "/^a$/", "/^^a/"]);
    }

    #[test]
    fn literal_bytes_survive_every_edit() {
        assert_eq!(
            mutations(r"^a\/\\[+-]? $").unwrap(),
            [
                r"/a\/\\[+-]? $/",
                r"/^a\/\\[+-]? /",
                r"/^a\/\\[+-] $/",
                r"/^a\/\\[^+-]? $/",
            ]
        );
    }

    #[test]
    fn classes_and_counted_quantifiers_keep_preorder_and_original_bytes() {
        assert_eq!(
            mutations(r"^[^a-z\d\W]{2,4}\s*$").unwrap(),
            [
                r"/[^a-z\d\W]{2,4}\s*$/",
                r"/^[^a-z\d\W]{2,4}\s*/",
                r"/^[^a-z\d\W]\s*$/",
                r"/^[a-z\d\W]{2,4}\s*$/",
                r"/^[^a-z\D\W]{2,4}\s*$/",
                r"/^[^a-z\d\w]{2,4}\s*$/",
                r"/^[^a-z\d\W]{2,4}\s$/",
                r"/^[^a-z\d\W]{2,4}\S*$/",
            ]
        );
        for suffix in [
            "*",
            "{0}",
            "{2}",
            "{0,}",
            "{2,}",
            "{0,0}",
            "{2,4}",
            "{2147483647}",
        ] {
            assert_eq!(mutations(&format!("a{suffix}")).unwrap(), ["/a/"]);
        }
        assert_eq!(
            mutations(r"[\d\d]").unwrap(),
            [r"/[^\d\d]/", r"/[\D\d]/", r"/[\d\D]/"]
        );
    }

    #[test]
    fn broader_parser_grammar_does_not_imply_eligibility() {
        for text in [
            "",
            "a??",
            "a+?",
            "a*?",
            "a{2}?",
            "a{02}",
            "a{2,03}",
            "a{2147483648}",
            "a{1,2147483648}",
            "a|b",
            "(a)",
            "(?=a)",
            "[]",
            "[^]",
            ".",
            r"[\/-0]",
            r"[a\-z]",
            r"\x61",
            r"\1",
            "é",
            r"\^",
            r"a.[+-]?\d+",
        ] {
            assert!(mutations(text).is_err(), "{text}");
        }
    }
}
