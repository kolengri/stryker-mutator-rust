use std::collections::HashMap;

use oxc_allocator::Allocator;
use oxc_ast::{AstKind, ast::*};
use oxc_ast_visit::{Visit, walk};
use oxc_parser::{ParseOptions, Parser};
use oxc_semantic::SemanticBuilder;
use oxc_span::{GetSpan, SourceType, Span};
use serde::Serialize;

const PREVIEW_REASON: &str = "Experimental candidate subset; not a drop-in Stryker mutation result. Regex mutations, empty-expression filtering, constructor handling, ignore directives, framework preprocessing, and instrumentation are not implemented. Type positions are excluded.";

#[derive(Debug, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Mutant {
    /// JavaScript UTF-16 code units, never UTF-8 byte offsets.
    start: u32,
    end: u32,
    replacement: String,
    mutator_name: &'static str,
}

#[derive(Debug, Serialize)]
pub(crate) struct Analysis {
    mutants: Vec<Mutant>,
    supported: bool,
    reason: String,
}

impl Analysis {
    fn unsupported(reason: impl Into<String>) -> Self {
        Self {
            mutants: vec![],
            supported: false,
            reason: reason.into(),
        }
    }
}

pub(crate) fn analyze_source(source: &str, file_name: &str) -> Analysis {
    if source.len() > u32::MAX as usize {
        return Analysis::unsupported("Source exceeds the parser's 32-bit span limit");
    }
    let source_type = match SourceType::from_path(file_name) {
        Ok(source_type) => source_type,
        Err(error) => return Analysis::unsupported(format!("Unsupported file name: {error}")),
    };
    let allocator = Allocator::default();
    let parsed = Parser::new(&allocator, source, source_type)
        .with_options(ParseOptions {
            parse_regular_expression: true,
            ..ParseOptions::default()
        })
        .parse();
    if parsed.fatal_error || !parsed.diagnostics.is_empty() {
        return Analysis::unsupported(format!("Syntax error: {:?}", parsed.diagnostics));
    }
    if parsed.is_flow_language {
        return Analysis::unsupported("Flow syntax is not supported");
    }
    // Oxc deliberately leaves some early errors to semantic analysis, including
    // duplicate lexical declarations and invalid control-flow statements.
    let semantics = SemanticBuilder::new()
        .with_check_syntax_error(true)
        .build(&parsed.program);
    if !semantics.diagnostics.is_empty() {
        return Analysis::unsupported(format!("Syntax error: {:?}", semantics.diagnostics));
    }
    let mut visitor = MutationVisitor {
        source,
        offsets: Utf16Offsets::new(source),
        ancestors: vec![],
        tests: HashMap::new(),
        mutants: vec![],
    };
    visitor.visit_program(&parsed.program);
    visitor.mutants.sort_unstable();
    visitor.mutants.dedup();
    Analysis {
        mutants: visitor.mutants,
        supported: false,
        reason: PREVIEW_REASON.into(),
    }
}

/// Only non-ASCII boundaries need storage. ASCII input has zero conversion overhead.
pub(crate) struct Utf16Offsets(Vec<(u32, u32)>);

impl Utf16Offsets {
    pub(crate) fn new(source: &str) -> Self {
        let mut extra_bytes = 0;
        Self(
            source
                .char_indices()
                .filter_map(|(index, ch)| {
                    if ch.is_ascii() {
                        return None;
                    }
                    extra_bytes += (ch.len_utf8() - ch.len_utf16()) as u32;
                    Some(((index + ch.len_utf8()) as u32, extra_bytes))
                })
                .collect(),
        )
    }

    pub(crate) fn convert(&self, byte_offset: u32) -> u32 {
        let index = self.0.partition_point(|&(end, _)| end <= byte_offset);
        byte_offset - index.checked_sub(1).map_or(0, |index| self.0[index].1)
    }
}

struct MutationVisitor<'s, 'a> {
    source: &'s str,
    offsets: Utf16Offsets,
    ancestors: Vec<AstKind<'a>>,
    // true is a loop test; false is an if condition.
    tests: HashMap<(u32, u32), bool>,
    mutants: Vec<Mutant>,
}

impl MutationVisitor<'_, '_> {
    fn text(&self, span: Span) -> &str {
        &self.source[span.start as usize..span.end as usize]
    }

    fn emit(&mut self, span: Span, replacement: impl Into<String>, name: &'static str) {
        self.mutants.push(Mutant {
            start: self.offsets.convert(span.start),
            end: self.offsets.convert(span.end),
            replacement: replacement.into(),
            mutator_name: name,
        });
    }

    fn edit(&mut self, span: Span, edit: Span, replacement: &str, name: &'static str) {
        let mut output = self.text(span).to_string();
        output.replace_range(
            (edit.start - span.start) as usize..(edit.end - span.start) as usize,
            replacement,
        );
        self.emit(span, output, name);
    }

    /// Locate an operator only within the parser-confirmed gap between operands.
    /// Comments in that gap must never be mistaken for division or other tokens.
    fn operator(&self, start: u32, end: u32, operator: &str) -> Option<Span> {
        let gap = self.source.get(start as usize..end as usize)?;
        let mut offset = 0;
        while offset < gap.len() {
            let rest = &gap[offset..];
            if let Some(comment) = rest.strip_prefix("/*") {
                offset += 2 + comment.find("*/")? + 2;
            } else if let Some(comment) = rest.strip_prefix("//") {
                offset += 2 + comment.find(['\n', '\r', '\u{2028}', '\u{2029}'])?;
            } else {
                let ch = rest.chars().next()?;
                if ch.is_whitespace() || ch == '\u{feff}' {
                    offset += ch.len_utf8();
                } else {
                    return rest.starts_with(operator).then(|| {
                        Span::new(
                            start + offset as u32,
                            start + offset as u32 + operator.len() as u32,
                        )
                    });
                }
            }
        }
        None
    }

    fn replace_operator(
        &mut self,
        span: Span,
        left_end: u32,
        right_start: u32,
        operator: &str,
        replacement: &str,
        name: &'static str,
    ) {
        if let Some(operator_span) = self.operator(left_end, right_start, operator) {
            self.edit(span, operator_span, replacement, name);
        }
    }

    fn parent(&self) -> Option<AstKind<'_>> {
        self.ancestors
            .iter()
            .rev()
            .copied()
            .find(|kind| !matches!(kind, AstKind::ParenthesizedExpression(_)))
    }

    fn mark_test(&mut self, expression: &Expression<'_>, is_loop: bool) {
        let span = expression.without_parentheses().span();
        self.tests.insert((span.start, span.end), is_loop);
    }

    fn conditional(&mut self, expression: &Expression<'_>) {
        if matches!(expression, Expression::ParenthesizedExpression(_)) {
            return;
        }
        let span = expression.span();
        let values: &[&str] = if let Some(is_loop) = self.tests.get(&(span.start, span.end)) {
            if *is_loop {
                &["false"]
            } else {
                &["true", "false"]
            }
        } else if is_boolean_expression(expression) {
            match self.parent() {
                Some(AstKind::LogicalExpression(parent)) if parent.operator.as_str() == "||" => {
                    &["false"]
                }
                Some(AstKind::LogicalExpression(parent)) if parent.operator.as_str() == "&&" => {
                    &["true"]
                }
                _ => &["true", "false"],
            }
        } else {
            &[]
        };
        for &value in values {
            self.emit(span, value, "ConditionalExpression");
        }
    }
}

fn is_string(expression: &Expression<'_>) -> bool {
    matches!(
        expression.without_parentheses(),
        Expression::StringLiteral(_) | Expression::TemplateLiteral(_)
    )
}

fn is_boolean_expression(expression: &Expression<'_>) -> bool {
    match expression {
        Expression::BinaryExpression(node) => matches!(
            node.operator.as_str(),
            "!=" | "!==" | "<" | "<=" | "==" | "===" | ">" | ">="
        ),
        Expression::LogicalExpression(node) => matches!(node.operator.as_str(), "&&" | "||"),
        _ => false,
    }
}

impl<'a> Visit<'a> for MutationVisitor<'_, 'a> {
    fn enter_node(&mut self, kind: AstKind<'a>) {
        self.ancestors.push(kind);
    }
    fn leave_node(&mut self, _kind: AstKind<'a>) {
        self.ancestors.pop();
    }

    fn visit_expression(&mut self, node: &Expression<'a>) {
        self.conditional(node);
        walk::walk_expression(self, node);
    }

    // Never traverse literals/operators inside TypeScript type syntax.
    fn visit_ts_type(&mut self, _node: &TSType<'a>) {}

    fn visit_binary_expression(&mut self, node: &BinaryExpression<'a>) {
        let operator = node.operator.as_str();
        let replacements: &[&str] = match operator {
            "+" => &["-"],
            "-" => &["+"],
            "*" => &["/"],
            "/" | "%" => &["*"],
            "<" => &["<=", ">="],
            "<=" => &["<", ">"],
            ">" => &[">=", "<="],
            ">=" => &[">", "<"],
            "==" => &["!="],
            "!=" => &["=="],
            "===" => &["!=="],
            "!==" => &["==="],
            _ => &[],
        };
        let arithmetic = matches!(operator, "+" | "-" | "*" | "/" | "%");
        let left = match node.left.without_parentheses() {
            Expression::BinaryExpression(left) => &left.right,
            _ => &node.left,
        };
        if !arithmetic || (!is_string(left) && !is_string(&node.right)) {
            for replacement in replacements {
                self.replace_operator(
                    node.span,
                    node.left.span().end,
                    node.right.span().start,
                    operator,
                    replacement,
                    if arithmetic {
                        "ArithmeticOperator"
                    } else {
                        "EqualityOperator"
                    },
                );
            }
        }
        walk::walk_binary_expression(self, node);
    }

    fn visit_logical_expression(&mut self, node: &LogicalExpression<'a>) {
        let operator = node.operator.as_str();
        let replacement = if operator == "&&" { "||" } else { "&&" };
        if let Some(operator_span) =
            self.operator(node.left.span().end, node.right.span().start, operator)
        {
            let mut output = self.text(node.span).to_string();
            output.replace_range(
                (operator_span.start - node.span.start) as usize
                    ..(operator_span.end - node.span.start) as usize,
                replacement,
            );
            // ?? cannot coexist unparenthesized with && or ||. Preserve the AST
            // when either a child or parent is another nullish/logical expression.
            let has_nullish_child = [&node.left, &node.right].iter().any(|child| matches!(child, Expression::LogicalExpression(child) if child.operator.as_str() == "??"));
            if has_nullish_child {
                output = format!(
                    "({}) {replacement} ({})",
                    self.text(node.left.span()),
                    self.text(node.right.span())
                );
            }
            self.emit(node.span, format!("({output})"), "LogicalOperator");
        }
        walk::walk_logical_expression(self, node);
    }

    fn visit_boolean_literal(&mut self, node: &BooleanLiteral) {
        self.emit(
            node.span,
            if node.value { "false" } else { "true" },
            "BooleanLiteral",
        );
        walk::walk_boolean_literal(self, node);
    }

    fn visit_unary_expression(&mut self, node: &UnaryExpression<'a>) {
        let operator = node.operator.as_str();
        match operator {
            "!" => self.emit(
                node.span,
                self.text(node.argument.span()).to_string(),
                "BooleanLiteral",
            ),
            "~" => self.emit(
                node.span,
                self.text(node.argument.span()).to_string(),
                "UnaryOperator",
            ),
            "+" | "-" => self.replace_operator(
                node.span,
                node.span.start,
                node.argument.span().start,
                operator,
                if operator == "+" { "-" } else { "+" },
                "UnaryOperator",
            ),
            _ => {}
        }
        walk::walk_unary_expression(self, node);
    }

    fn visit_update_expression(&mut self, node: &UpdateExpression<'a>) {
        let argument = node.argument.span();
        let (start, end) = if node.prefix {
            (node.span.start, argument.start)
        } else {
            (argument.end, node.span.end)
        };
        let operator = node.operator.as_str();
        self.replace_operator(
            node.span,
            start,
            end,
            operator,
            if operator == "++" { "--" } else { "++" },
            "UpdateOperator",
        );
        walk::walk_update_expression(self, node);
    }

    fn visit_assignment_expression(&mut self, node: &AssignmentExpression<'a>) {
        let operator = node.operator.as_str();
        let replacement = match operator {
            "+=" => Some("-="),
            "-=" => Some("+="),
            "*=" => Some("/="),
            "/=" | "%=" => Some("*="),
            "<<=" => Some(">>="),
            ">>=" => Some("<<="),
            "&=" => Some("|="),
            "|=" => Some("&="),
            "&&=" => Some("||="),
            "||=" | "??=" => Some("&&="),
            _ => None,
        };
        if let Some(replacement) = replacement
            && (!is_string(&node.right) || matches!(operator, "&&=" | "||=" | "??="))
        {
            self.replace_operator(
                node.span,
                node.left.span().end,
                node.right.span().start,
                operator,
                replacement,
                "AssignmentOperator",
            );
        }
        walk::walk_assignment_expression(self, node);
    }

    fn visit_string_literal(&mut self, node: &StringLiteral<'a>) {
        let excluded = match self.parent() {
            Some(
                AstKind::ImportDeclaration(_)
                | AstKind::ExportNamedDeclaration(_)
                | AstKind::ExportAllDeclaration(_)
                | AstKind::TSExternalModuleReference(_)
                | AstKind::JSXAttribute(_)
                | AstKind::ExpressionStatement(_)
                | AstKind::ImportExpression(_)
                | AstKind::Directive(_),
            ) => true,
            Some(AstKind::CallExpression(call)) => {
                matches!(&call.callee, Expression::Identifier(identifier) if matches!(identifier.name.as_str(), "require" | "Symbol"))
            }
            _ => false,
        };
        if !excluded {
            self.emit(
                node.span,
                if node.value.is_empty() {
                    "\"Stryker was here!\""
                } else {
                    "\"\""
                },
                "StringLiteral",
            );
        }
        walk::walk_string_literal(self, node);
    }

    fn visit_property_key(&mut self, node: &PropertyKey<'a>) {
        if !matches!(node, PropertyKey::StringLiteral(_)) {
            walk::walk_property_key(self, node);
        }
    }

    fn visit_template_literal(&mut self, node: &TemplateLiteral<'a>) {
        self.emit(
            node.span,
            if self.text(node.span) == "``" {
                "`Stryker was here!`"
            } else {
                "``"
            },
            "StringLiteral",
        );
        walk::walk_template_literal(self, node);
    }

    fn visit_array_expression(&mut self, node: &ArrayExpression<'a>) {
        self.emit(
            node.span,
            if node.elements.is_empty() {
                "[\"Stryker was here\"]"
            } else {
                "[]"
            },
            "ArrayDeclaration",
        );
        walk::walk_array_expression(self, node);
    }

    fn visit_object_expression(&mut self, node: &ObjectExpression<'a>) {
        if !node.properties.is_empty() {
            self.emit(node.span, "{}", "ObjectLiteral");
        }
        walk::walk_object_expression(self, node);
    }

    fn visit_arrow_function_expression(&mut self, node: &ArrowFunctionExpression<'a>) {
        if !matches!(&node.body, ArrowFunctionBody::FunctionBody(_))
            && !matches!(&node.body, ArrowFunctionBody::Identifier(identifier) if identifier.name == "undefined")
        {
            self.emit(node.span, "() => undefined", "ArrowFunction");
        }
        walk::walk_arrow_function_expression(self, node);
    }

    fn visit_block_statement(&mut self, node: &BlockStatement<'a>) {
        if !node.body.is_empty() {
            self.emit(node.span, "{}", "BlockStatement");
        }
        walk::walk_block_statement(self, node);
    }

    fn visit_function_body(&mut self, node: &FunctionBody<'a>) {
        // Conservatively omit constructor-body candidates. Correct exclusions
        // require upstream TypeScript parameter-property/class-field semantics.
        let constructor = self.ancestors.iter().any(|kind| matches!(kind, AstKind::MethodDefinition(method) if method.kind == MethodDefinitionKind::Constructor));
        if !node.statements.is_empty() && !constructor {
            self.emit(node.span, "{}", "BlockStatement");
        }
        walk::walk_function_body(self, node);
    }

    fn visit_if_statement(&mut self, node: &IfStatement<'a>) {
        self.mark_test(&node.test, false);
        walk::walk_if_statement(self, node);
    }

    fn visit_while_statement(&mut self, node: &WhileStatement<'a>) {
        self.mark_test(&node.test, true);
        walk::walk_while_statement(self, node);
    }

    fn visit_do_while_statement(&mut self, node: &DoWhileStatement<'a>) {
        self.mark_test(&node.test, true);
        walk::walk_do_while_statement(self, node);
    }

    fn visit_for_statement(&mut self, node: &ForStatement<'a>) {
        if let Some(test) = &node.test {
            self.mark_test(test, true);
        }
        walk::walk_for_statement(self, node);
    }

    fn visit_static_member_expression(&mut self, node: &StaticMemberExpression<'a>) {
        if node.optional {
            self.replace_operator(
                node.span,
                node.object.span().end,
                node.property.span.start,
                "?.",
                ".",
                "OptionalChaining",
            );
        }
        walk::walk_static_member_expression(self, node);
    }

    fn visit_computed_member_expression(&mut self, node: &ComputedMemberExpression<'a>) {
        if node.optional {
            self.replace_operator(
                node.span,
                node.object.span().end,
                node.expression.span().start,
                "?.",
                "",
                "OptionalChaining",
            );
        }
        walk::walk_computed_member_expression(self, node);
    }

    fn visit_call_expression(&mut self, node: &CallExpression<'a>) {
        if node.optional {
            self.replace_operator(
                node.span,
                node.callee.span().end,
                node.span.end,
                "?.",
                "",
                "OptionalChaining",
            );
        }
        if let Expression::Identifier(identifier) = &node.callee
            && identifier.name == "Array"
            && !node.optional
        {
            self.emit(
                node.span,
                if node.arguments.is_empty() {
                    "Array([])"
                } else {
                    "Array()"
                },
                "ArrayDeclaration",
            );
        }
        if let Expression::StaticMemberExpression(member) = &node.callee {
            match method_replacement(member.property.name.as_str()) {
                Some(Some(replacement)) => self.edit(
                    node.span,
                    member.property.span,
                    replacement,
                    "MethodExpression",
                ),
                Some(None) => self.emit(
                    node.span,
                    self.text(member.object.span()).to_string(),
                    "MethodExpression",
                ),
                None => {}
            }
        }
        walk::walk_call_expression(self, node);
    }

    fn visit_new_expression(&mut self, node: &NewExpression<'a>) {
        if let Expression::Identifier(identifier) = &node.callee
            && identifier.name == "Array"
        {
            self.emit(
                node.span,
                if node.arguments.is_empty() {
                    "new Array([])"
                } else {
                    "new Array()"
                },
                "ArrayDeclaration",
            );
        }
        walk::walk_new_expression(self, node);
    }
}

// Shared upstream mapping, including reverse entries. setUTCDate deliberately
// does not overwrite the reverse setTime -> setDate entry.
pub(crate) fn method_replacement(method: &str) -> Option<Option<&'static str>> {
    Some(match method {
        "charAt" | "filter" | "reverse" | "slice" | "sort" | "substr" | "substring" | "trim" => {
            None
        }
        "endsWith" => Some("startsWith"),
        "startsWith" => Some("endsWith"),
        "every" => Some("some"),
        "some" => Some("every"),
        "toLocaleLowerCase" => Some("toLocaleUpperCase"),
        "toLocaleUpperCase" => Some("toLocaleLowerCase"),
        "toLowerCase" => Some("toUpperCase"),
        "toUpperCase" => Some("toLowerCase"),
        "trimEnd" => Some("trimStart"),
        "trimStart" => Some("trimEnd"),
        "min" => Some("max"),
        "max" => Some("min"),
        "setDate" => Some("setTime"),
        "setTime" => Some("setDate"),
        "setFullYear" => Some("setMonth"),
        "setMonth" => Some("setFullYear"),
        "setHours" => Some("setMinutes"),
        "setMinutes" => Some("setHours"),
        "setSeconds" => Some("setMilliseconds"),
        "setMilliseconds" => Some("setSeconds"),
        "setUTCDate" => Some("setTime"),
        "setUTCFullYear" => Some("setUTCMonth"),
        "setUTCMonth" => Some("setUTCFullYear"),
        "setUTCHours" => Some("setUTCMinutes"),
        "setUTCMinutes" => Some("setUTCHours"),
        "setUTCSeconds" => Some("setUTCMilliseconds"),
        "setUTCMilliseconds" => Some("setUTCSeconds"),
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unicode_ranges_use_javascript_utf16_units() {
        let source = "const emoji = '😀é';\r\nconst n = 1 + 2;";
        let analysis = analyze_source(source, "unicode.js");
        let arithmetic = analysis
            .mutants
            .iter()
            .find(|m| m.mutator_name == "ArithmeticOperator")
            .unwrap();
        let byte_start = source.find("1 + 2").unwrap();
        assert_eq!(
            arithmetic.start as usize,
            source[..byte_start].encode_utf16().count()
        );
        assert_eq!(arithmetic.end - arithmetic.start, 5);
        assert_eq!(arithmetic.replacement, "1 - 2");
        assert!(!analysis.supported);
    }

    #[test]
    fn syntax_and_early_errors_return_no_candidates() {
        for source in [
            "const x = ;",
            "let a; let a;",
            "break;",
            "const x = 'unterminated",
            "const invalid = /(/;",
        ] {
            let analysis = analyze_source(source, "input.js");
            assert!(analysis.mutants.is_empty(), "{source}");
            assert!(
                analysis.reason.starts_with("Syntax error:"),
                "{}",
                analysis.reason
            );
            assert!(!analysis.supported);
        }
        assert!(
            analyze_source("true", "input.unknown")
                .reason
                .starts_with("Unsupported file name:")
        );
    }

    #[test]
    fn type_literals_and_module_strings_are_excluded() {
        let source = "import value from 'module'; type T = 'hello' | true | `${'type'}`; const x: 'annotation' = 'runtime'; const o = { 'key': 'value' }; require('ignored'); Symbol('ignored'); 'directive';";
        let analysis = analyze_source(source, "input.ts");
        let strings: Vec<_> = analysis
            .mutants
            .iter()
            .filter(|m| m.mutator_name == "StringLiteral")
            .map(|m| m.start)
            .collect();
        assert_eq!(
            strings,
            [
                source.find("'runtime'").unwrap() as u32,
                source.find("'value'").unwrap() as u32
            ]
        );
        assert!(
            !analysis
                .mutants
                .iter()
                .any(|m| m.mutator_name == "BooleanLiteral")
        );
    }

    #[test]
    fn meaningful_operators_and_comments_are_handled_from_ast() {
        let source =
            "let n = a /* + / */ + b; n += 2; n++; const x = a < b; const y = !ok; const z = -n;";
        let analysis = analyze_source(source, "input.js");
        for (name, replacement) in [
            ("ArithmeticOperator", "a /* + / */ - b"),
            ("AssignmentOperator", "n -= 2"),
            ("UpdateOperator", "n--"),
            ("EqualityOperator", "a >= b"),
            ("BooleanLiteral", "ok"),
            ("UnaryOperator", "+n"),
        ] {
            assert!(
                analysis
                    .mutants
                    .iter()
                    .any(|m| m.mutator_name == name && m.replacement == replacement),
                "{name}: {analysis:?}"
            );
        }
        let strings = analyze_source("const s = 'x' + y; a += 'x';", "input.js");
        assert!(
            !strings
                .mutants
                .iter()
                .any(|m| matches!(m.mutator_name, "ArithmeticOperator" | "AssignmentOperator"))
        );
    }

    #[test]
    fn nested_nullish_mutations_remain_parseable() {
        let source = "const n = a ?? b ?? c; const m = (a ?? b) || c;";
        for mutant in analyze_source(source, "input.js")
            .mutants
            .into_iter()
            .filter(|m| m.mutator_name == "LogicalOperator")
        {
            let mutated = format!(
                "{}{}{}",
                &source[..mutant.start as usize],
                mutant.replacement,
                &source[mutant.end as usize..]
            );
            let analysis = analyze_source(&mutated, "input.js");
            assert!(
                !analysis.reason.starts_with("Syntax error:"),
                "{mutated}: {}",
                analysis.reason
            );
        }
    }

    #[test]
    fn optional_calls_methods_collections_and_arrows_are_present() {
        let source = "const a = x?.y; const b = x?.[0]; x?.(); x.endsWith('x'); const c = [1]; const d = {a: true}; const f = x => x + 1;";
        let analysis = analyze_source(source, "input.js");
        for (name, replacement) in [
            ("OptionalChaining", "x.y"),
            ("OptionalChaining", "x[0]"),
            ("OptionalChaining", "x()"),
            ("MethodExpression", "x.startsWith('x')"),
            ("ArrayDeclaration", "[]"),
            ("ObjectLiteral", "{}"),
            ("ArrowFunction", "() => undefined"),
        ] {
            assert!(
                analysis
                    .mutants
                    .iter()
                    .any(|m| m.mutator_name == name && m.replacement == replacement),
                "{name} {replacement}: {analysis:?}"
            );
        }
    }

    #[test]
    fn conditionals_keep_loop_and_logical_context() {
        let source = "while (go) {} if (check) {} const x = a < b || c > d;";
        let analysis = analyze_source(source, "input.js");
        let values = |text: &str| {
            analysis
                .mutants
                .iter()
                .filter(|m| {
                    m.mutator_name == "ConditionalExpression"
                        && m.start == source.find(text).unwrap() as u32
                        && m.end == (source.find(text).unwrap() + text.len()) as u32
                })
                .map(|m| m.replacement.as_str())
                .collect::<Vec<_>>()
        };
        assert_eq!(values("go"), ["false"]);
        assert_eq!(values("check"), ["false", "true"]);
        assert_eq!(values("a < b"), ["false"]);
        assert_eq!(values("c > d"), ["false"]);
    }
}
