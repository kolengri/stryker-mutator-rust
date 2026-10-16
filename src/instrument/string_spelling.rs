//! Preserve parser-owned raw literals when printing cloned replacement ASTs.
//!
//! Oxc 0.154 prints decoded strings, whereas Babel retains each clone's raw
//! spelling. Give every literal occurrence a distinct AST marker, then parse
//! the generated expression to obtain its exact output byte range. This never
//! searches output text or identifies literals by their decoded value/source
//! span (replacement subtrees can have overlapping, reparsed source spans).

use oxc_allocator::{Allocator, CloneIn};
use oxc_ast::ast::{AssignmentTarget, Expression, StringLiteral};
use oxc_ast_visit::{Visit, VisitMut};
use oxc_codegen::{Codegen, Gen};
use oxc_parser::Parser;
use oxc_span::{SourceType, Span};

const PREFIX: &str = "__stryker_raw_string_";
const UNPROVEN: &str = "String literal spelling requires upstream replacement formatting: unproven generated literal ranges";

struct Protect<'a> {
    allocator: &'a Allocator,
    spellings: Vec<String>,
}

impl<'a> VisitMut<'a> for Protect<'a> {
    fn visit_string_literal(&mut self, node: &mut StringLiteral<'a>) {
        let spelling = node.raw.as_ref().map_or_else(
            || {
                let mut generator = Codegen::new();
                node.print(&mut generator, oxc_codegen::Context::empty());
                generator.into_source_text()
            },
            ToString::to_string,
        );
        let marker = format!("{PREFIX}{}__", self.spellings.len());
        self.spellings.push(spelling);
        node.value = self.allocator.alloc_str(&marker).into();
        node.raw = None;
        node.lone_surrogates = false;
    }
}

struct Ranges {
    spans: Vec<Option<Span>>,
    proven: bool,
}

impl<'a> Visit<'a> for Ranges {
    fn visit_string_literal(&mut self, node: &StringLiteral<'a>) {
        let index = node
            .value
            .as_str()
            .strip_prefix(PREFIX)
            .and_then(|value| value.strip_suffix("__"))
            .and_then(|value| value.parse::<usize>().ok());
        if let Some(index) = index
            && node.value == format!("{PREFIX}{index}__").as_str()
            && let Some(slot @ None) = self.spans.get_mut(index)
        {
            *slot = Some(node.span);
        } else {
            self.proven = false;
        }
    }
}

fn restore(code: String, spellings: Vec<String>) -> Result<String, String> {
    if spellings.is_empty() {
        return Ok(code);
    }
    let allocator = Allocator::default();
    let expression = Parser::new(&allocator, &code, SourceType::mjs().with_typescript(true))
        .parse_expression()
        .map_err(|_| UNPROVEN.to_string())?;
    let mut ranges = Ranges {
        spans: vec![None; spellings.len()],
        proven: true,
    };
    ranges.visit_expression(&expression);
    if !ranges.proven || ranges.spans.iter().any(Option::is_none) {
        return Err(UNPROVEN.into());
    }
    let mut edits = ranges
        .spans
        .into_iter()
        .zip(spellings)
        .map(|(span, spelling)| (span.unwrap(), spelling))
        .collect::<Vec<_>>();
    edits.sort_unstable_by_key(|(span, _)| span.start);
    let mut result = String::new();
    let mut start = 0;
    for (span, spelling) in edits {
        let end = span.start as usize;
        result.push_str(code.get(start..end).ok_or(UNPROVEN)?);
        result.push_str(&spelling);
        start = span.end as usize;
    }
    result.push_str(code.get(start..).ok_or(UNPROVEN)?);
    Ok(result)
}

pub(super) fn expression(node: &Expression<'_>, source: &str) -> Result<String, String> {
    let allocator = Allocator::default();
    let mut cloned = node.clone_in(&allocator);
    let mut protect = Protect {
        allocator: &allocator,
        spellings: vec![],
    };
    protect.visit_expression(&mut cloned);
    let mut generator = Codegen::new().with_source_text(source);
    generator.print_expression(&cloned);
    restore(generator.into_source_text(), protect.spellings)
}

pub(super) fn assignment_target(
    node: &AssignmentTarget<'_>,
    source: &str,
) -> Result<String, String> {
    let allocator = Allocator::default();
    let mut cloned = node.clone_in(&allocator);
    let mut protect = Protect {
        allocator: &allocator,
        spellings: vec![],
    };
    protect.visit_assignment_target(&mut cloned);
    let mut generator = Codegen::new().with_source_text(source);
    cloned.print(&mut generator, oxc_codegen::Context::empty());
    restore(generator.into_source_text(), protect.spellings)
}

#[cfg(test)]
mod tests {
    use super::*;
    use oxc_ast::builder::AstBuilder;

    #[test]
    fn generated_literals_without_raw_use_codegen_spelling() {
        let allocator = Allocator::default();
        let builder = AstBuilder::new(&allocator);
        let expression = Expression::StringLiteral(StringLiteral::boxed(
            Span::default(),
            "generated",
            None,
            &builder,
        ));
        assert_eq!(super::expression(&expression, "").unwrap(), "\"generated\"");
    }

    #[test]
    fn unproven_occurrences_fail_closed() {
        for code in [
            "broken(",
            "\"unmarked\"",
            "`__stryker_raw_string_0__`",
            "'__stryker_raw_string_00__'",
            "'__stryker_raw_string_1__'",
            "['__stryker_raw_string_0__', '__stryker_raw_string_0__']",
        ] {
            assert_eq!(
                restore(code.into(), vec!["'original'".into()]),
                Err(UNPROVEN.into())
            );
        }
    }

    #[test]
    fn ranges_are_utf8_and_ast_typed_even_next_to_marker_text() {
        let code = "é(`😀__stryker_raw_string_0__`, '__stryker_raw_string_1__', '__stryker_raw_string_0__')";
        assert_eq!(
            restore(code.into(), vec!["'\\x61'".into(), "\"a\"".into()]).unwrap(),
            "é(`😀__stryker_raw_string_0__`, \"a\", '\\x61')"
        );
    }
}
