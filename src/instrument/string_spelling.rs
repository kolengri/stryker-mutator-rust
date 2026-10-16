//! Preserve parser-owned raw literals when printing cloned replacement ASTs.
//!
//! Oxc 0.154 prints decoded strings, whereas Babel retains each clone's raw
//! spelling. Give every literal occurrence a distinct AST marker, then parse
//! the generated expression to obtain its exact output byte range. This never
//! searches output text or identifies literals by their decoded value/source
//! span (replacement subtrees can have overlapping, reparsed source spans).
//! An immutable visit first compares parser-owned raw tokens with this pinned
//! generator's literal spelling. If none differ, print the original AST directly.
//! Concise arrows reuse that visit and the conditional output parse for their
//! parameter ranges. Await operands use Babel's extra grouping at generated AST
//! ranges. Existing synchronous paths gain no cloning or parsing.

use oxc_allocator::{Allocator, CloneIn};
use oxc_ast::ast::{
    ArrowFunctionExpression, AssignmentTarget, AwaitExpression, Expression, StringLiteral,
};
use oxc_ast_visit::{Visit, VisitMut, walk};
use oxc_codegen::{Codegen, Gen};
use oxc_parser::Parser;
use oxc_span::{SourceType, Span};

use super::printed_arrows;

const PREFIX: &str = "__stryker_raw_string_";
const UNPROVEN: &str = "String literal spelling requires upstream replacement formatting: unproven generated literal ranges";

fn literal_spelling(node: &StringLiteral<'_>) -> String {
    let mut generator = Codegen::new();
    // Gen preserves Oxc's lone-surrogate encoding; print_string(value) does not.
    node.print(&mut generator, oxc_codegen::Context::empty());
    generator.into_source_text()
}

#[derive(Default)]
struct NeedsProtection {
    strings: bool,
    awaits: usize,
    arrows: printed_arrows::Proof,
}

impl<'a> Visit<'a> for NeedsProtection {
    fn visit_await_expression(&mut self, node: &AwaitExpression<'a>) {
        self.awaits += 1;
        walk::walk_await_expression(self, node);
    }

    fn visit_arrow_function_expression(&mut self, node: &ArrowFunctionExpression<'a>) {
        self.arrows.record(node);
        walk::walk_arrow_function_expression(self, node);
    }

    fn visit_string_literal(&mut self, node: &StringLiteral<'a>) {
        if !self.strings
            && let Some(raw) = &node.raw
        {
            self.strings = literal_spelling(node) != raw.as_str();
        }
    }
}

struct Protect<'a> {
    allocator: &'a Allocator,
    spellings: Vec<String>,
}

impl<'a> VisitMut<'a> for Protect<'a> {
    fn visit_string_literal(&mut self, node: &mut StringLiteral<'a>) {
        let spelling = node
            .raw
            .as_ref()
            .map_or_else(|| literal_spelling(node), ToString::to_string);
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

#[derive(Default)]
struct AwaitGroups {
    visited: usize,
    edits: Vec<(Span, String)>,
}

impl AwaitGroups {
    fn group(&mut self, node: &Expression<'_>) {
        if let Expression::AwaitExpression(node) = node {
            self.edits.push((Span::empty(node.span.start), "(".into()));
            self.edits.push((Span::empty(node.span.end), ")".into()));
        }
    }
}

impl<'a> Visit<'a> for AwaitGroups {
    fn visit_await_expression(&mut self, node: &AwaitExpression<'a>) {
        self.visited += 1;
        walk::walk_await_expression(self, node);
    }

    fn visit_expression(&mut self, node: &Expression<'a>) {
        // Pinned Babel 8's YieldExpression rule also groups await in binary/
        // logical operands, unary arguments and conditional tests. Preserved
        // generated parentheses are distinct AST nodes, avoiding double wraps.
        match node {
            Expression::BinaryExpression(node) => {
                self.group(&node.left);
                self.group(&node.right);
            }
            Expression::LogicalExpression(node) => {
                self.group(&node.left);
                self.group(&node.right);
            }
            Expression::UnaryExpression(node) => self.group(&node.argument),
            Expression::ConditionalExpression(node) => self.group(&node.test),
            _ => {}
        }
        walk::walk_expression(self, node);
    }
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

fn restore(
    code: String,
    spellings: Vec<String>,
    arrows: printed_arrows::Proof,
    awaits: usize,
) -> Result<String, String> {
    arrows.check()?;
    if spellings.is_empty() && arrows.is_empty() && awaits == 0 {
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
    if !spellings.is_empty() {
        ranges.visit_expression(&expression);
    }
    if !ranges.proven || ranges.spans.iter().any(Option::is_none) {
        return Err(UNPROVEN.into());
    }
    let mut edits = ranges
        .spans
        .into_iter()
        .zip(spellings)
        .map(|(span, spelling)| (span.unwrap(), spelling))
        .collect::<Vec<_>>();
    if !arrows.is_empty() {
        edits.extend(arrows.edits(&expression, &code)?);
    }
    if awaits > 0 {
        let mut groups = AwaitGroups::default();
        groups.visit_expression(&expression);
        if groups.visited != awaits {
            return Err("Await grouping requires proven generated await ranges".into());
        }
        edits.extend(groups.edits);
    }
    edits.sort_unstable_by_key(|(span, _)| span.start);
    let mut result = String::new();
    let mut start = 0;
    for (span, spelling) in edits {
        let end = span.start as usize;
        if end < start {
            return Err(UNPROVEN.into());
        }
        result.push_str(code.get(start..end).ok_or(UNPROVEN)?);
        result.push_str(&spelling);
        start = span.end as usize;
    }
    result.push_str(code.get(start..).ok_or(UNPROVEN)?);
    Ok(result)
}

pub(super) fn expression(node: &Expression<'_>, source: &str) -> Result<String, String> {
    let mut needs_protection = NeedsProtection::default();
    needs_protection.visit_expression(node);
    needs_protection.arrows.check()?;
    if !needs_protection.strings {
        let mut generator = Codegen::new().with_source_text(source);
        generator.print_expression(node);
        return restore(
            generator.into_source_text(),
            vec![],
            needs_protection.arrows,
            needs_protection.awaits,
        );
    }
    let allocator = Allocator::default();
    let mut cloned = node.clone_in(&allocator);
    let mut protect = Protect {
        allocator: &allocator,
        spellings: vec![],
    };
    protect.visit_expression(&mut cloned);
    let mut generator = Codegen::new().with_source_text(source);
    generator.print_expression(&cloned);
    restore(
        generator.into_source_text(),
        protect.spellings,
        needs_protection.arrows,
        needs_protection.awaits,
    )
}

pub(super) fn assignment_target(
    node: &AssignmentTarget<'_>,
    source: &str,
) -> Result<String, String> {
    let mut needs_protection = NeedsProtection::default();
    needs_protection.visit_assignment_target(node);
    needs_protection.arrows.check()?;
    if !needs_protection.strings {
        let mut generator = Codegen::new().with_source_text(source);
        node.print(&mut generator, oxc_codegen::Context::empty());
        return restore(
            generator.into_source_text(),
            vec![],
            needs_protection.arrows,
            needs_protection.awaits,
        );
    }
    let allocator = Allocator::default();
    let mut cloned = node.clone_in(&allocator);
    let mut protect = Protect {
        allocator: &allocator,
        spellings: vec![],
    };
    protect.visit_assignment_target(&mut cloned);
    let mut generator = Codegen::new().with_source_text(source);
    cloned.print(&mut generator, oxc_codegen::Context::empty());
    restore(
        generator.into_source_text(),
        protect.spellings,
        needs_protection.arrows,
        needs_protection.awaits,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use oxc_ast::builder::AstBuilder;

    #[test]
    fn await_grouping_uses_generated_parent_ranges_without_double_parentheses() {
        for (source, expected) in [
            ("await x + await y", "(await x) + (await y)"),
            ("await x && await y", "(await x) && (await y)"),
            ("await x ?? await y", "(await x) ?? (await y)"),
            ("!(await x)", "!(await x)"),
            (
                "await x ? await y : await z",
                "(await x) ? await y : await z",
            ),
            ("await await x", "await await x"),
            ("(await x).value", "(await x).value"),
            ("(await x)?.value", "(await x)?.value"),
            ("f(async (x) => await x + 1)", "f(async x => (await x) + 1)"),
            ("f('é', await x + await y)", "f('é', (await x) + (await y))"),
        ] {
            let allocator = Allocator::default();
            let node = Parser::new(&allocator, source, SourceType::mjs())
                .parse_expression()
                .unwrap();
            assert_eq!(
                super::expression(&node, source).unwrap(),
                expected,
                "{source}"
            );
        }
        assert!(restore("await x".into(), vec![], Default::default(), 2).is_err());
        assert!(restore("x".into(), vec![], Default::default(), 1).is_err());
    }

    fn arrow_proof(source: &str) -> printed_arrows::Proof {
        let allocator = Allocator::default();
        let node = Parser::new(&allocator, source, SourceType::mjs().with_typescript(true))
            .parse_expression()
            .unwrap();
        let mut needs_protection = NeedsProtection::default();
        needs_protection.visit_expression(&node);
        needs_protection.arrows
    }

    #[test]
    fn concise_arrows_restore_only_proven_identifier_parameter_ranges() {
        for (source, expected) in [
            ("f((x) => x)", "f(x => x)"),
            ("f(() => true)", "f(() => true)"),
            ("f((x, y) => x + y)", "f((x, y) => x + y)"),
            ("f((x) => (y) => x + y)", "f(x => y => x + y)"),
            ("f((é) => é, (é) => é)", "f(é => é, é => é)"),
            ("f(async (é) => await é)", "f(async é => await é)"),
            ("f(async () => true)", "f(async () => true)"),
            ("f(async (x, y) => x + y)", "f(async (x, y) => x + y)"),
            ("f(async (x) => (y) => x + y)", "f(async x => y => x + y)"),
            ("é(`😀(x) => x`, (x) => x)", "é(`😀(x) => x`, x => x)"),
        ] {
            assert_eq!(
                restore(source.into(), vec![], arrow_proof(source), 0).unwrap(),
                expected
            );
        }
    }

    #[test]
    fn arrow_occurrence_count_names_and_punctuation_fail_closed() {
        for code in [
            "f()",
            "f((y) => y)",
            "f((x, y) => x)",
            "f((x) => x, (x) => x)",
            "f(x => x)",
            "f(( x ) => x)",
            "f(async (x) => x)",
            "f((x) => { return x; })",
            "f((x: number) => x)",
            "f(`(x) => x`)",
        ] {
            assert!(
                restore(code.into(), vec![], arrow_proof("f((x) => x)"), 0).is_err(),
                "{code}"
            );
        }
        assert!(
            restore(
                "f((x) => x)".into(),
                vec![],
                arrow_proof("f(async (x) => x)"),
                0
            )
            .is_err()
        );
    }

    #[test]
    fn unsupported_arrow_signatures_do_not_enter_the_printer() {
        for source in [
            "f((x = 1) => x)",
            "f((...x) => x)",
            "f(({x}) => x)",
            "f((x: number) => x)",
            "f(<T>(x: T) => x)",
            "f((x): number => x)",
            "f((x?) => x)",
            "f(x => { return x; })",
        ] {
            let allocator = Allocator::default();
            let node = Parser::new(&allocator, source, SourceType::mjs().with_typescript(true))
                .parse_expression()
                .unwrap();
            assert_eq!(
                super::expression(&node, source),
                Err(printed_arrows::UNSUPPORTED.into()),
                "{source}"
            );
        }
    }

    #[test]
    fn arrow_and_literal_ranges_share_the_same_generated_coordinates() {
        let source = r#"é((é) => f('__stryker_raw_string_0__', "\x61", "a"), `😀(é) => é`)"#;
        let allocator = Allocator::default();
        let node = Parser::new(&allocator, source, SourceType::mjs())
            .parse_expression()
            .unwrap();
        assert_eq!(
            super::expression(&node, source).unwrap(),
            r#"é(é => f('__stryker_raw_string_0__', "\x61", "a"), `😀(é) => é`)"#
        );
    }

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
        let mut needs_protection = NeedsProtection::default();
        needs_protection.visit_expression(&expression);
        assert!(!needs_protection.strings);
        assert_eq!(super::expression(&expression, "").unwrap(), "\"generated\"");
    }

    #[test]
    fn direct_print_requires_every_raw_literal_to_match_codegen() {
        for source in [
            "a + b * c",
            r#"a.startsWith("x") && b === "y""#,
            r#"f("a\\b", "say \"yes\"", "\ud800", "\udfff", "\\ud800", "�", "😀é")"#,
            r#"value as "type""#,
        ] {
            let allocator = Allocator::default();
            let node = Parser::new(&allocator, source, SourceType::mjs().with_typescript(true))
                .parse_expression()
                .unwrap();
            let mut needs_protection = NeedsProtection::default();
            needs_protection.visit_expression(&node);
            assert!(!needs_protection.strings, "{source}");
            let mut generator = Codegen::new().with_source_text(source);
            generator.print_expression(&node);
            assert_eq!(
                super::expression(&node, source).unwrap(),
                generator.into_source_text()
            );
        }
        for source in [
            r#"f("a", 'a')"#,
            r#"f("a", "\x61")"#,
            r#"f("a", "\u0061")"#,
            r#"f("a", "\uD800")"#,
            "value as 'type'",
        ] {
            let allocator = Allocator::default();
            let node = Parser::new(&allocator, source, SourceType::mjs().with_typescript(true))
                .parse_expression()
                .unwrap();
            let mut needs_protection = NeedsProtection::default();
            needs_protection.visit_expression(&node);
            assert!(needs_protection.strings, "{source}");
            assert_eq!(super::expression(&node, source).unwrap(), source);
        }
    }

    #[test]
    fn assignment_targets_use_the_same_raw_spelling_proof() {
        for (source, protected) in [(r#"obj["x"] = 1"#, false), ("obj['x'] = 1", true)] {
            let allocator = Allocator::default();
            let node = Parser::new(&allocator, source, SourceType::mjs())
                .parse_expression()
                .unwrap();
            let Expression::AssignmentExpression(node) = node else {
                panic!("assignment")
            };
            let mut needs_protection = NeedsProtection::default();
            needs_protection.visit_assignment_target(&node.left);
            assert_eq!(needs_protection.strings, protected);
            assert_eq!(
                assignment_target(&node.left, source).unwrap(),
                source.strip_suffix(" = 1").unwrap()
            );
        }
    }

    #[test]
    fn assignment_target_keys_share_arrow_and_raw_literal_ranges() {
        for (source, expected) in [
            (r#"obj[f((x) => "x")] = 1"#, r#"obj[f(x => "x")]"#),
            ("obj[f((x) => 'x')] = 1", "obj[f(x => 'x')]"),
        ] {
            let allocator = Allocator::default();
            let node = Parser::new(&allocator, source, SourceType::mjs())
                .parse_expression()
                .unwrap();
            let Expression::AssignmentExpression(node) = node else {
                panic!("assignment")
            };
            assert_eq!(assignment_target(&node.left, source).unwrap(), expected);
        }
    }

    #[test]
    fn one_raw_mismatch_still_protects_generated_and_canonical_marker_values() {
        let source = r#"f('__stryker_raw_string_0__', 'a', "a")"#;
        let allocator = Allocator::default();
        let mut node = Parser::new(&allocator, source, SourceType::mjs())
            .parse_expression()
            .unwrap();
        let Expression::CallExpression(call) = &mut node else {
            panic!("call")
        };
        let oxc_ast::ast::Argument::StringLiteral(generated) = &mut call.arguments[0] else {
            panic!("string")
        };
        generated.raw = None;
        assert_eq!(
            super::expression(&node, source).unwrap(),
            r#"f("__stryker_raw_string_0__", 'a', "a")"#
        );
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
                restore(
                    code.into(),
                    vec!["'original'".into()],
                    Default::default(),
                    0
                ),
                Err(UNPROVEN.into())
            );
        }
    }

    #[test]
    fn ranges_are_utf8_and_ast_typed_even_next_to_marker_text() {
        let code = "é(`😀__stryker_raw_string_0__`, '__stryker_raw_string_1__', '__stryker_raw_string_0__')";
        assert_eq!(
            restore(
                code.into(),
                vec!["'\\x61'".into(), "\"a\"".into()],
                Default::default(),
                0
            )
            .unwrap(),
            "é(`😀__stryker_raw_string_0__`, \"a\", '\\x61')"
        );
    }
}
