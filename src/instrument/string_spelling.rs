//! Preserve parser-owned raw literals when printing cloned replacement ASTs.
//!
//! Oxc 0.154 normalizes strings, numbers and regex flag order, whereas Babel
//! retains raw tokens.
//! Give every literal occurrence a distinct AST marker, then parse
//! the generated expression to obtain its exact output byte range. This never
//! searches output text or identifies literals by their decoded value/source
//! span (replacement subtrees can have overlapping, reparsed source spans).
//! An immutable visit first compares parser-owned raw tokens with this pinned
//! generator's literal spelling. If none differ, print the original AST directly.
//! Arrows reuse that visit and the conditional output parse for their
//! parameter ranges. Await operands use Babel's extra grouping at generated AST
//! ranges. Existing synchronous paths gain no cloning or parsing.

use oxc_allocator::{Allocator, CloneIn};
use oxc_ast::ast::{
    ArrowFunctionExpression, AssignmentTarget, AwaitExpression, Expression, NumericLiteral,
    RegExpFlags, RegExpLiteral, StaticMemberExpression, StringLiteral, TSSatisfiesExpression,
    TSTypeAssertion,
};
use oxc_ast_visit::{Visit, VisitMut, walk};
use oxc_codegen::{Codegen, CodegenOptions, Gen, GenExpr, IndentChar};
use oxc_parser::Parser;
use oxc_span::{GetSpan, SourceType, Span};
use oxc_syntax::{
    operator::BinaryOperator,
    precedence::{GetPrecedence, Precedence},
};

use super::printed_arrows;

const PREFIX: &str = "__stryker_raw_string_";
const NUMBER_MARKER: f64 = 8_000_000_000_000_000.0;
const UNPROVEN: &str =
    "Literal spelling requires upstream replacement formatting: unproven generated literal ranges";

fn literal_spelling(node: &StringLiteral<'_>) -> String {
    let mut generator = Codegen::new();
    // Gen preserves Oxc's lone-surrogate encoding; print_string(value) does not.
    node.print(&mut generator, oxc_codegen::Context::empty());
    generator.into_source_text()
}

fn generator<'a>() -> Codegen<'a> {
    Codegen::new().with_options(CodegenOptions {
        indent_char: IndentChar::Space,
        indent_width: 2,
        ..CodegenOptions::default()
    })
}

fn number_spelling(node: &NumericLiteral<'_>) -> String {
    let mut generator = generator();
    node.print_expr(
        &mut generator,
        oxc_syntax::precedence::Precedence::Lowest,
        oxc_codegen::Context::empty(),
    );
    generator.into_source_text()
}

fn regex_spelling(node: &RegExpLiteral<'_>) -> String {
    let mut generator = generator();
    node.print(&mut generator, oxc_codegen::Context::empty());
    generator.into_source_text()
}

fn regex_raw<'n>(node: &'n RegExpLiteral<'_>) -> Option<&'n str> {
    let raw = node.raw.as_ref()?.as_str();
    let flags = raw
        .strip_prefix('/')?
        .strip_prefix(node.regex.pattern.text.as_str())?
        .strip_prefix('/')?;
    let parsed = flags.bytes().try_fold(RegExpFlags::empty(), |seen, byte| {
        let flag = RegExpFlags::try_from(byte).ok()?;
        (!seen.intersects(flag)).then_some(seen | flag)
    })?;
    // A transformed literal can retain its old raw field. Restore raw bytes
    // only when its current pattern and flags still describe that token.
    (parsed == node.regex.flags).then_some(raw)
}

#[derive(Default)]
struct NeedsProtection {
    strings: bool,
    numbers: bool,
    regexes: bool,
    awaits: usize,
    assertions: usize,
    unproven_assertions: bool,
    arrows: printed_arrows::Proof,
}

impl<'a> Visit<'a> for NeedsProtection {
    fn visit_ts_satisfies_expression(&mut self, node: &TSSatisfiesExpression<'a>) {
        self.assertions += 1;
        self.unproven_assertions |= !super::simple_printed_type(&node.type_annotation)
            || matches!(
                node.expression,
                Expression::TSSatisfiesExpression(_) | Expression::TSAsExpression(_)
            );
        walk::walk_ts_satisfies_expression(self, node);
    }

    fn visit_ts_type_assertion(&mut self, node: &TSTypeAssertion<'a>) {
        self.assertions += 1;
        self.unproven_assertions |= !super::simple_printed_type(&node.type_annotation)
            || matches!(
                node.expression,
                Expression::TSSatisfiesExpression(_) | Expression::TSAsExpression(_)
            )
            || matches!(&node.expression, Expression::TSTypeAssertion(inner) if matches!(inner.expression, Expression::BinaryExpression(_) | Expression::LogicalExpression(_)));
        walk::walk_ts_type_assertion(self, node);
    }

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

    fn visit_numeric_literal(&mut self, node: &NumericLiteral<'a>) {
        if !self.numbers
            && let Some(raw) = &node.raw
        {
            self.numbers = number_spelling(node) != raw.as_str();
        }
    }

    fn visit_reg_exp_literal(&mut self, node: &RegExpLiteral<'a>) {
        if !self.regexes
            && let Some(raw) = regex_raw(node)
        {
            self.regexes = regex_spelling(node) != raw;
        }
    }
}

struct Protect<'a> {
    allocator: &'a Allocator,
    spellings: Vec<String>,
    numbers: Vec<String>,
}

impl<'a> VisitMut<'a> for Protect<'a> {
    fn visit_reg_exp_literal(&mut self, node: &mut RegExpLiteral<'a>) {
        let spelling = regex_raw(node).map_or_else(|| regex_spelling(node), str::to_owned);
        let marker = format!("{PREFIX}{}__", self.spellings.len());
        self.spellings.push(spelling);
        node.regex.pattern.text = self.allocator.alloc_str(&marker).into();
        node.regex.pattern.pattern = None;
        node.regex.flags = RegExpFlags::empty();
        node.raw = None;
    }

    fn visit_numeric_literal(&mut self, node: &mut NumericLiteral<'a>) {
        let spelling = node
            .raw
            .as_ref()
            .map_or_else(|| number_spelling(node), ToString::to_string);
        node.value = NUMBER_MARKER + self.numbers.len() as f64;
        node.raw = None;
        self.numbers.push(spelling);
    }

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
    numbers: Vec<Option<Span>>,
    number_members: Vec<(usize, Span, bool)>,
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
            Expression::TSSatisfiesExpression(node) => self.group(&node.expression),
            Expression::TSTypeAssertion(node) => self.group(&node.expression),
            _ => {}
        }
        walk::walk_expression(self, node);
    }
}

#[derive(Default)]
struct AssertionSpelling<'s> {
    code: &'s str,
    visited: usize,
    edits: Vec<(Span, String)>,
    unproven: bool,
    preserve_angles: Vec<Span>,
}

impl AssertionSpelling<'_> {
    fn preserve_angle(
        &mut self,
        child: &Expression<'_>,
        parent: Precedence,
        right: bool,
        coalesce: Option<bool>,
    ) {
        let Expression::TSTypeAssertion(assertion) = child else {
            return;
        };
        let Expression::ParenthesizedExpression(group) = &assertion.expression else {
            return;
        };
        let (precedence, mixed_coalesce) = match &group.expression {
            Expression::BinaryExpression(binary) => (binary.precedence(), false),
            Expression::LogicalExpression(logical) => (
                logical.precedence(),
                coalesce.is_some_and(|parent| {
                    parent != (logical.operator == oxc_syntax::operator::LogicalOperator::Coalesce)
                }),
            ),
            _ => return,
        };
        // Mixed nullish/logical clones are a separate, unqualified grammar seam.
        if mixed_coalesce {
            self.unproven = true;
            return;
        }
        // Preserve Oxc's necessary delimiters where Babel's missing assertion
        // parent rule changes the erased expression tree or coercion order.
        // Other pinned spelling stays exact.
        if precedence < parent
            || (precedence == parent
                && coalesce.is_none()
                && right != parent.is_right_associative())
        {
            self.preserve_angles.push(assertion.span);
        }
    }

    fn operand(&mut self, node: &Expression<'_>, angle: bool) {
        let Expression::ParenthesizedExpression(group) = node else {
            return;
        };
        // Babel's BinaryLike rule uses comparison precedence for satisfies,
        // but has no binary/logical operand grouping rule for TSTypeAssertion.
        // Remove only the generator-owned delimiters proved by this parsed AST.
        let remove = match &group.expression {
            Expression::BinaryExpression(binary) => {
                angle
                    || !(binary.operator.is_equality()
                        || matches!(
                            binary.operator,
                            BinaryOperator::BitwiseOR
                                | BinaryOperator::BitwiseXOR
                                | BinaryOperator::BitwiseAnd
                        ))
            }
            Expression::LogicalExpression(_) => angle,
            _ => false,
        };
        if remove {
            let span = group.span;
            self.unproven |= self.code.get(span.start as usize..span.start as usize + 1)
                != Some("(")
                || self.code.get(span.end as usize - 1..span.end as usize) != Some(")");
            self.edits
                .push((Span::new(span.start, span.start + 1), String::new()));
            self.edits
                .push((Span::new(span.end - 1, span.end), String::new()));
        }
    }
}

impl<'a> Visit<'a> for AssertionSpelling<'_> {
    fn visit_expression(&mut self, node: &Expression<'a>) {
        match node {
            Expression::BinaryExpression(binary) => {
                self.preserve_angle(&binary.left, binary.precedence(), false, None);
                self.preserve_angle(&binary.right, binary.precedence(), true, None);
            }
            Expression::LogicalExpression(logical) => {
                let coalesce =
                    Some(logical.operator == oxc_syntax::operator::LogicalOperator::Coalesce);
                self.preserve_angle(&logical.left, logical.precedence(), false, coalesce);
                self.preserve_angle(&logical.right, logical.precedence(), true, coalesce);
            }
            Expression::UnaryExpression(unary) => {
                self.preserve_angle(&unary.argument, Precedence::Prefix, true, None)
            }
            Expression::AwaitExpression(awaited) => {
                self.preserve_angle(&awaited.argument, Precedence::Prefix, true, None)
            }
            _ => {}
        }
        walk::walk_expression(self, node);
    }

    fn visit_ts_satisfies_expression(&mut self, node: &TSSatisfiesExpression<'a>) {
        self.visited += 1;
        self.operand(&node.expression, false);
        walk::walk_ts_satisfies_expression(self, node);
    }

    fn visit_ts_type_assertion(&mut self, node: &TSTypeAssertion<'a>) {
        self.visited += 1;
        let gap = Span::new(
            node.type_annotation.span().end,
            node.expression.span().start,
        );
        self.unproven |= self.code.get(gap.start as usize..gap.end as usize) != Some(">");
        self.edits.push((gap, "> ".into()));
        if !self.preserve_angles.contains(&node.span) {
            self.operand(&node.expression, true);
        }
        walk::walk_ts_type_assertion(self, node);
    }
}

impl<'a> Visit<'a> for Ranges {
    fn visit_reg_exp_literal(&mut self, node: &RegExpLiteral<'a>) {
        let text = node.regex.pattern.text.as_str();
        let index = text
            .strip_prefix(PREFIX)
            .and_then(|value| value.strip_suffix("__"))
            .and_then(|value| value.parse::<usize>().ok());
        if let Some(index) = index
            && text == format!("{PREFIX}{index}__")
            && node.regex.flags.is_empty()
            && let Some(slot @ None) = self.spans.get_mut(index)
        {
            *slot = Some(node.span);
        } else {
            self.proven = false;
        }
    }

    fn visit_static_member_expression(&mut self, node: &StaticMemberExpression<'a>) {
        if let Expression::NumericLiteral(number) = &node.object {
            let index = number.value - NUMBER_MARKER;
            if index >= 0.0 && index.fract() == 0.0 && (index as usize) < self.numbers.len() {
                self.number_members.push((
                    index as usize,
                    Span::new(number.span.end, node.property.span.start),
                    node.optional,
                ));
            } else {
                self.proven = false;
            }
        }
        walk::walk_static_member_expression(self, node);
    }

    fn visit_numeric_literal(&mut self, node: &NumericLiteral<'a>) {
        let index = node.value - NUMBER_MARKER;
        if index >= 0.0
            && index.fract() == 0.0
            && let Some(slot @ None) = self.numbers.get_mut(index as usize)
        {
            *slot = Some(node.span);
        } else {
            self.proven = false;
        }
    }

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
    numbers: Vec<String>,
    arrows: printed_arrows::Proof,
    awaits: usize,
    assertions: usize,
) -> Result<String, String> {
    arrows.check()?;
    if spellings.is_empty()
        && numbers.is_empty()
        && arrows.is_empty()
        && awaits == 0
        && assertions == 0
    {
        return Ok(code);
    }
    let allocator = Allocator::default();
    let expression = Parser::new(&allocator, &code, SourceType::mjs().with_typescript(true))
        .parse_expression()
        .map_err(|_| UNPROVEN.to_string())?;
    let mut ranges = Ranges {
        spans: vec![None; spellings.len()],
        numbers: vec![None; numbers.len()],
        number_members: vec![],
        proven: true,
    };
    if !spellings.is_empty() || !numbers.is_empty() {
        ranges.visit_expression(&expression);
    }
    if !ranges.proven
        || ranges
            .spans
            .iter()
            .chain(&ranges.numbers)
            .any(Option::is_none)
    {
        return Err(UNPROVEN.into());
    }
    let mut member_edits = vec![];
    for (index, span, optional) in ranges.number_members {
        let punctuation = code
            .get(span.start as usize..span.end as usize)
            .ok_or(UNPROVEN)?;
        if !matches!(punctuation, "." | " ." | "?.") || optional != (punctuation == "?.") {
            return Err(UNPROVEN.into());
        }
        // Babel separates decimal integer tokens from a following member dot.
        // Radix, fractional and exponent tokens already disambiguate the dot.
        let decimal_integer = numbers[index]
            .bytes()
            .all(|byte| byte.is_ascii_digit() || byte == b'_');
        member_edits.push((
            span,
            if optional {
                "?."
            } else if decimal_integer {
                " ."
            } else {
                "."
            }
            .into(),
        ));
    }
    let mut edits = ranges
        .spans
        .into_iter()
        .zip(spellings)
        .map(|(span, spelling)| (span.unwrap(), spelling))
        .collect::<Vec<_>>();
    edits.extend(
        ranges
            .numbers
            .into_iter()
            .zip(numbers)
            .map(|(span, spelling)| (span.unwrap(), spelling)),
    );
    edits.extend(member_edits);
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
    if assertions > 0 {
        let mut spelling = AssertionSpelling {
            code: &code,
            ..AssertionSpelling::default()
        };
        spelling.visit_expression(&expression);
        if spelling.visited != assertions || spelling.unproven {
            return Err("Assertion spelling requires proven generated wrapper ranges".into());
        }
        edits.extend(spelling.edits);
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
    if needs_protection.unproven_assertions {
        return Err("Complex or nested satisfies types inside cloned replacements require upstream formatting".into());
    }
    if !needs_protection.strings && !needs_protection.numbers && !needs_protection.regexes {
        let mut generator = generator().with_source_text(source);
        generator.print_expression(node);
        return restore(
            generator.into_source_text(),
            vec![],
            vec![],
            needs_protection.arrows,
            needs_protection.awaits,
            needs_protection.assertions,
        );
    }
    let allocator = Allocator::default();
    let mut cloned = node.clone_in(&allocator);
    let mut protect = Protect {
        allocator: &allocator,
        spellings: vec![],
        numbers: vec![],
    };
    protect.visit_expression(&mut cloned);
    let mut generator = generator().with_source_text(source);
    generator.print_expression(&cloned);
    restore(
        generator.into_source_text(),
        protect.spellings,
        protect.numbers,
        needs_protection.arrows,
        needs_protection.awaits,
        needs_protection.assertions,
    )
}

pub(super) fn assignment_target(
    node: &AssignmentTarget<'_>,
    source: &str,
) -> Result<String, String> {
    let mut needs_protection = NeedsProtection::default();
    needs_protection.visit_assignment_target(node);
    needs_protection.arrows.check()?;
    if needs_protection.unproven_assertions {
        return Err("Complex or nested satisfies types inside cloned replacements require upstream formatting".into());
    }
    if !needs_protection.strings && !needs_protection.numbers && !needs_protection.regexes {
        let mut generator = generator().with_source_text(source);
        node.print(&mut generator, oxc_codegen::Context::empty());
        return restore(
            generator.into_source_text(),
            vec![],
            vec![],
            needs_protection.arrows,
            needs_protection.awaits,
            needs_protection.assertions,
        );
    }
    let allocator = Allocator::default();
    let mut cloned = node.clone_in(&allocator);
    let mut protect = Protect {
        allocator: &allocator,
        spellings: vec![],
        numbers: vec![],
    };
    protect.visit_assignment_target(&mut cloned);
    let mut generator = generator().with_source_text(source);
    cloned.print(&mut generator, oxc_codegen::Context::empty());
    restore(
        generator.into_source_text(),
        protect.spellings,
        protect.numbers,
        needs_protection.arrows,
        needs_protection.awaits,
        needs_protection.assertions,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use oxc_ast::builder::AstBuilder;

    #[test]
    fn assertion_clone_spelling_uses_generated_ast_ranges_and_keeps_raw_literals() {
        for (source, expected) in [
            ("(<number>a) - b", "<number> a - b"),
            ("(<number>(a + b)) / 2", "<number> (a + b) / 2"),
            (
                "((a + b) satisfies number) - 1",
                "(a + b satisfies number) - 1",
            ),
            (
                "((a > b) satisfies boolean) || true",
                "a > b satisfies boolean || true",
            ),
            (
                "((a === b) satisfies boolean) || true",
                "(a === b) satisfies boolean || true",
            ),
            (
                "((a & b) satisfies number) - 1",
                "((a & b) satisfies number) - 1",
            ),
            ("(<number>(a && b)) - 1", "<number> (a && b) - 1"),
            ("(<number>(a & b)) - 1", "<number> (a & b) - 1"),
            ("a + (<number>(b + c))", "a + <number> (b + c)"),
            ("(<number>(a + b)) - c", "<number> a + b - c"),
            ("(<number><number>a) - b", "<number> <number> a - b"),
            ("(<number>0xff) - 1_000", "<number> 0xff - 1_000"),
            (
                "(<RegExp>/a/mi).test('raw')",
                "(<RegExp> /a/mi).test('raw')",
            ),
            (
                "((await x) satisfies number) - 1",
                "((await x) satisfies number) - 1",
            ),
            ("(<number>(await x)) - 1", "<number> (await x) - 1"),
            ("await <number>(a & b)", "await <number> (a & b)"),
            ("await <number>(a + b)", "await <number> (a + b)"),
            ("await <number>(a ** b)", "await <number> (a ** b)"),
        ] {
            let allocator = Allocator::default();
            let node = Parser::new(&allocator, source, SourceType::ts().with_module(true))
                .with_options(oxc_parser::ParseOptions {
                    preserve_parens: false,
                    ..Default::default()
                })
                .parse_expression()
                .unwrap();
            assert_eq!(expression(&node, source).unwrap(), expected, "{source}");
        }
        assert!(restore("x".into(), vec![], vec![], Default::default(), 0, 1).is_err());
        assert!(restore("<number>x".into(), vec![], vec![], Default::default(), 0, 2).is_err());
    }

    #[test]
    fn raw_regex_flags_share_occurrence_markers_with_other_literals() {
        for source in [
            r"f('raw', /[^a-z\w]{1,3}/mi, /a/ig, 1_000)",
            r"f('__stryker_raw_string_0__', /__stryker_raw_string_0__/mi, /a/g)",
        ] {
            let allocator = Allocator::default();
            let node = Parser::new(&allocator, source, SourceType::mjs())
                .parse_expression()
                .unwrap();
            assert_eq!(expression(&node, source).unwrap(), source);
        }
        let allocator = Allocator::default();
        let node = Parser::new(&allocator, "/a/g", SourceType::mjs())
            .parse_expression()
            .unwrap();
        let mut needs = NeedsProtection::default();
        needs.visit_expression(&node);
        assert!(
            !needs.regexes,
            "canonical flags retain the direct-print path"
        );
    }

    #[test]
    fn transformed_regexes_never_restore_stale_raw_patterns_or_flags() {
        let source = r"f('raw', /[a-z]+/mi)";
        let allocator = Allocator::default();
        let mut node = Parser::new(&allocator, source, SourceType::mjs())
            .parse_expression()
            .unwrap();
        let Expression::CallExpression(call) = &mut node else {
            panic!()
        };
        let oxc_ast::ast::Argument::RegExpLiteral(regex) = &mut call.arguments[1] else {
            panic!()
        };
        regex.regex.pattern.text = allocator.alloc_str("[^a-z]+").into();
        assert_eq!(expression(&node, source).unwrap(), r"f('raw', /[^a-z]+/im)");
        let Expression::CallExpression(call) = &mut node else {
            panic!()
        };
        let oxc_ast::ast::Argument::RegExpLiteral(regex) = &mut call.arguments[1] else {
            panic!()
        };
        regex.regex.flags = RegExpFlags::G;
        assert_eq!(expression(&node, source).unwrap(), r"f('raw', /[^a-z]+/g)");
    }

    #[test]
    fn raw_numbers_and_numeric_member_punctuation_survive_protected_clones() {
        for (source, expected) in [
            (
                "f(0xffffffff, 1_000, 1e2, 0x10)",
                "f(0xffffffff, 1_000, 1e2, 0x10)",
            ),
            (
                "f('raw', (1_000).toString(), (0x10).toString(), (1).x)",
                "f('raw', 1_000 .toString(), 0x10.toString(), 1 .x)",
            ),
            (
                "f(x => { const n = 1_000 + 0xff; return x + n; })",
                "f(x => {\n  const n = 1_000 + 0xff;\n  return x + n;\n})",
            ),
            ("f(x => { return x; })", "f(x => {\n  return x;\n})"),
        ] {
            let allocator = Allocator::default();
            let node = Parser::new(&allocator, source, SourceType::mjs())
                .parse_expression()
                .unwrap();
            assert_eq!(expression(&node, source).unwrap(), expected, "{source}");
        }
        for code in ["0", "8e15 + 8e15", "8e15 + 1", "8e15.x + 8e15.x"] {
            assert!(
                restore(
                    code.into(),
                    vec![],
                    vec!["0xff".into()],
                    Default::default(),
                    0,
                    0
                )
                .is_err(),
                "{code}"
            );
        }
    }

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
        assert!(restore("await x".into(), vec![], vec![], Default::default(), 2, 0).is_err());
        assert!(restore("x".into(), vec![], vec![], Default::default(), 1, 0).is_err());
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
                restore(source.into(), vec![], vec![], arrow_proof(source), 0, 0).unwrap(),
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
                restore(
                    code.into(),
                    vec![],
                    vec![],
                    arrow_proof("f((x) => x)"),
                    0,
                    0
                )
                .is_err(),
                "{code}"
            );
        }
        assert!(
            restore(
                "f((x) => x)".into(),
                vec![],
                vec![],
                arrow_proof("f(async (x) => x)"),
                0,
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
            "f(x => { if (x) return x; })",
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
                    vec![],
                    Default::default(),
                    0,
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
                vec![],
                Default::default(),
                0,
                0
            )
            .unwrap(),
            "é(`😀__stryker_raw_string_0__`, \"a\", '\\x61')"
        );
    }
}
