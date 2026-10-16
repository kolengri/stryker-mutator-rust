//! Conservative native instrumentation, distinct from the broader candidate preview.
//!
//! Every accepted node has complete mutation/placement semantics for the supported
//! grammar. An unsupported node/options value rejects the entire batch. This is
//! essential: silently omitting one mutant would change mutation scores.

use std::collections::HashSet;

use oxc_allocator::{Allocator, CloneIn};
use oxc_ast::ast::*;
use oxc_ast_visit::{Visit, walk};
use oxc_codegen::Codegen;
use oxc_parser::{ParseOptions, Parser};
use oxc_semantic::SemanticBuilder;
use oxc_span::{GetSpan, SourceType, Span};
use oxc_syntax::operator::{BinaryOperator as B, LogicalOperator as L, UnaryOperator as U};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::mutations::Utf16Offsets;

// Keep the protocol and caching behavior in sync with Stryker 10 syntax-helpers.
// This includes truthy currentTestId selection, dynamic activeMutant checks, and
// incrementing hitCount only after a matching activation check.
const HEADER: &str = r#"function stryNS_9fa48() {
  var g = typeof globalThis === 'object' && globalThis && globalThis.Math === Math && globalThis || new Function("return this")();
  var ns = g.__stryker__ || (g.__stryker__ = {});
  if (ns.activeMutant === undefined && g.process && g.process.env && g.process.env.__STRYKER_ACTIVE_MUTANT__) {
    ns.activeMutant = g.process.env.__STRYKER_ACTIVE_MUTANT__;
  }
  function retrieveNS() { return ns; }
  stryNS_9fa48 = retrieveNS;
  return retrieveNS();
}
stryNS_9fa48();
function stryCov_9fa48() {
  var ns = stryNS_9fa48();
  var cov = ns.mutantCoverage || (ns.mutantCoverage = { static: {}, perTest: {} });
  function cover() {
    var c = cov.static;
    if (ns.currentTestId) {
      c = cov.perTest[ns.currentTestId] = cov.perTest[ns.currentTestId] || {};
    }
    var a = arguments;
    for (var i = 0; i < a.length; i++) { c[a[i]] = (c[a[i]] || 0) + 1; }
  }
  stryCov_9fa48 = cover;
  cover.apply(null, arguments);
}
function stryMutAct_9fa48(id) {
  var ns = stryNS_9fa48();
  function isActive(id) {
    if (ns.activeMutant === id) {
      if (ns.hitCount !== void 0 && ++ns.hitCount > ns.hitLimit) {
        throw new Error('Stryker: Hit count limit reached (' + ns.hitCount + ')');
      }
      return true;
    }
    return false;
  }
  stryMutAct_9fa48 = isActive;
  return isActive(id);
}
"#;

#[derive(Deserialize)]
struct Input {
    files: Vec<File>,
    #[serde(default)]
    options: Value,
}

#[derive(Deserialize, Serialize)]
struct File {
    name: String,
    mutate: bool,
    content: String,
}

#[derive(Serialize)]
pub(crate) struct Response {
    supported: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<InstrumentResult>,
}

#[derive(Serialize)]
struct InstrumentResult {
    files: Vec<File>,
    mutants: Vec<ApiMutant>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ApiMutant {
    file_name: String,
    id: String,
    location: Location,
    mutator_name: &'static str,
    replacement: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    status_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    status: Option<&'static str>,
}

#[derive(Serialize)]
struct Location {
    start: Position,
    end: Position,
}

#[derive(Serialize)]
struct Position {
    line: usize,
    column: u32,
}

#[derive(Default)]
struct Options {
    excluded: HashSet<String>,
    no_header: bool,
}

impl Options {
    fn parse(value: Value) -> Result<Self, String> {
        let mut options = Self::default();
        if value.is_null() {
            return Ok(options);
        }
        let values = value.as_object().ok_or("Options must be an object")?;
        for (name, value) in values {
            match name.as_str() {
                "excludedMutations" => {
                    for name in value
                        .as_array()
                        .ok_or("excludedMutations must be a string array")?
                    {
                        options.excluded.insert(
                            name.as_str()
                                .ok_or("excludedMutations must be a string array")?
                                .to_string(),
                        );
                    }
                }
                "noHeader" => {
                    options.no_header = value.as_bool().ok_or("noHeader must be boolean")?
                }
                "plugins" if value.is_null() || value.as_array().is_some_and(Vec::is_empty) => {}
                "ignorers" if value.as_array().is_some_and(Vec::is_empty) => {}
                _ => return Err(format!("Unsupported native instrumentation option: {name}")),
            }
        }
        Ok(options)
    }
}

pub(crate) fn instrument_batch(input: &str) -> Response {
    let result = serde_json::from_str::<Input>(input)
        .map_err(|error| format!("Invalid instrumentation input: {error}"))
        .and_then(|input| {
            let options = Options::parse(input.options)?;
            let mut records = vec![];
            let mut files = Vec::with_capacity(input.files.len());
            for file in input.files {
                let content = instrument_file(&file, &options, &mut records)
                    .map_err(|reason| format!("{}: {reason}", file.name))?;
                files.push(File { content, ..file });
            }
            Ok(InstrumentResult {
                files,
                mutants: records,
            })
        });
    match result {
        Ok(result) => Response {
            supported: true,
            reason: None,
            result: Some(result),
        },
        Err(reason) => Response {
            supported: false,
            reason: Some(reason),
            result: None,
        },
    }
}

fn instrument_file(
    file: &File,
    options: &Options,
    records: &mut Vec<ApiMutant>,
) -> Result<String, String> {
    if file.content.len() > u32::MAX as usize {
        return Err("Source exceeds 32-bit span limits".into());
    }
    let source_type = SourceType::from_path(&file.name).map_err(|error| error.to_string())?;
    if source_type.is_typescript() || source_type.is_jsx() {
        return Err(
            "Native instrumentation supports .js/.mjs/.cjs without TypeScript or JSX".into(),
        );
    }
    let allocator = Allocator::default();
    let parsed = Parser::new(&allocator, &file.content, source_type.with_module(true))
        .with_options(ParseOptions {
            preserve_parens: false,
            parse_regular_expression: true,
            ..ParseOptions::default()
        })
        .parse();
    if parsed.fatal_error || !parsed.diagnostics.is_empty() {
        return Err(format!("Syntax error: {:?}", parsed.diagnostics));
    }
    if parsed.is_flow_language
        || !parsed.program.comments.is_empty()
        || parsed.program.hashbang.is_some()
        || !parsed.program.directives.is_empty()
    {
        return Err("Comments, directives, hashbangs, and Flow preprocessing require upstream instrumentation".into());
    }
    let semantics = SemanticBuilder::new()
        .with_check_syntax_error(true)
        .build(&parsed.program);
    if !semantics.diagnostics.is_empty() {
        return Err(format!("Syntax error: {:?}", semantics.diagnostics));
    }
    let mut bindings = ReservedBindings::default();
    bindings.visit_program(&parsed.program);
    if bindings.found {
        return Err("Source shadows an instrumentation helper or runtime global".into());
    }
    let mut emitter = Emitter {
        source: &file.content,
        file_name: &file.name,
        positions: Positions::new(&file.content),
        options,
        enabled: file.mutate,
        records,
        placed: 0,
    };
    let edits = parsed
        .program
        .body
        .iter()
        .map(|statement| {
            emitter
                .statement(statement, true)
                .map(|output| (statement.span(), output))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let mut output = emitter.apply(Span::new(0, file.content.len() as u32), edits);
    if emitter.placed != 0 && !options.no_header {
        output.insert_str(0, HEADER);
    }
    Ok(output)
}

#[derive(Default)]
struct ReservedBindings {
    found: bool,
}

impl<'a> Visit<'a> for ReservedBindings {
    fn visit_binding_identifier(&mut self, node: &BindingIdentifier<'a>) {
        self.found |= matches!(
            node.name.as_str(),
            "stryNS_9fa48"
                | "stryCov_9fa48"
                | "stryMutAct_9fa48"
                | "globalThis"
                | "Math"
                | "Function"
                | "Error"
                | "undefined"
        );
        walk::walk_binding_identifier(self, node);
    }

    fn visit_identifier_reference(&mut self, node: &IdentifierReference<'a>) {
        self.found |= matches!(
            node.name.as_str(),
            "stryNS_9fa48" | "stryCov_9fa48" | "stryMutAct_9fa48"
        );
        walk::walk_identifier_reference(self, node);
    }
}

struct Positions {
    lines: Vec<u32>,
    utf16: Utf16Offsets,
}

impl Positions {
    fn new(source: &str) -> Self {
        let mut lines = vec![0];
        let mut chars = source.char_indices().peekable();
        while let Some((index, ch)) = chars.next() {
            if ch == '\r' {
                if chars.peek().is_some_and(|&(_, ch)| ch == '\n') {
                    chars.next();
                    lines.push(index as u32 + 2);
                } else {
                    lines.push(index as u32 + 1);
                }
            } else if matches!(ch, '\n' | '\u{2028}' | '\u{2029}') {
                lines.push((index + ch.len_utf8()) as u32);
            }
        }
        Self {
            lines,
            utf16: Utf16Offsets::new(source),
        }
    }

    fn at(&self, byte: u32) -> Position {
        let line = self.lines.partition_point(|&start| start <= byte) - 1;
        Position {
            line,
            column: self.utf16.convert(byte) - self.utf16.convert(self.lines[line]),
        }
    }
}

#[derive(Default, Clone, Copy)]
struct Context<'a> {
    if_test: bool,
    logical_parent: Option<L>,
    binding_name: Option<&'a str>,
    printed_ancestor: bool,
}

struct Switch {
    id: String,
    replacement: String,
}

struct Emitter<'s, 'r> {
    source: &'s str,
    file_name: &'s str,
    positions: Positions,
    options: &'s Options,
    enabled: bool,
    records: &'r mut Vec<ApiMutant>,
    placed: usize,
}

impl Emitter<'_, '_> {
    fn text(&self, span: Span) -> &str {
        &self.source[span.start as usize..span.end as usize]
    }

    fn apply(&self, span: Span, mut edits: Vec<(Span, String)>) -> String {
        edits.sort_unstable_by_key(|(span, _)| span.start);
        let mut output = String::new();
        let mut start = span.start;
        for (edit, replacement) in edits {
            debug_assert!(start <= edit.start && edit.end <= span.end);
            output.push_str(self.text(Span::new(start, edit.start)));
            output.push_str(&replacement);
            start = edit.end;
        }
        output.push_str(self.text(Span::new(start, span.end)));
        output
    }

    fn print(&self, node: &Expression<'_>) -> String {
        let mut generator = Codegen::new().with_source_text(self.source);
        generator.print_expression(node);
        generator.into_source_text()
    }

    fn changed(
        &self,
        expression: &Expression<'_>,
        change: impl FnOnce(&mut Expression<'_>),
    ) -> String {
        let allocator = Allocator::default();
        let mut cloned = expression.clone_in(&allocator);
        change(&mut cloned);
        self.print(&cloned)
    }

    fn collect(
        &mut self,
        span: Span,
        replacement: String,
        name: &'static str,
        switches: &mut Vec<Switch>,
    ) {
        if !self.enabled {
            return;
        }
        let id = self.records.len().to_string();
        let ignored = self.options.excluded.contains(name);
        self.records.push(ApiMutant {
            file_name: self.file_name.into(),
            id: id.clone(),
            location: Location {
                start: self.positions.at(span.start),
                end: self.positions.at(span.end),
            },
            mutator_name: name,
            replacement: replacement.clone(),
            status_reason: ignored
                .then(|| format!("Ignored because of excluded mutation \"{name}\"")),
            status: ignored.then_some("Ignored"),
        });
        if !ignored {
            switches.push(Switch { id, replacement });
            self.placed += 1;
        }
    }

    fn expression(
        &mut self,
        node: &Expression<'_>,
        context: Context<'_>,
    ) -> Result<String, String> {
        if context.printed_ancestor && matches!(node, Expression::ArrowFunctionExpression(_)) {
            return Err(
                "Arrows nested inside printed mutation replacements require upstream formatting"
                    .into(),
            );
        }
        // Collect before descending: Stryker IDs follow Babel pre-order and the
        // allMutators ordering. Mutation branches use the uninstrumented snapshot.
        let mut switches = vec![];
        if let Expression::BinaryExpression(binary) = node {
            let replacement = match binary.operator {
                B::Addition => Some(B::Subtraction),
                B::Subtraction => Some(B::Addition),
                B::Multiplication => Some(B::Division),
                B::Division | B::Remainder => Some(B::Multiplication),
                _ => None,
            };
            if let Some(replacement) = replacement {
                let text = self.changed(node, |node| {
                    if let Expression::BinaryExpression(binary) = node {
                        binary.operator = replacement;
                    }
                });
                self.collect(node.span(), text, "ArithmeticOperator", &mut switches);
            }
        }
        if let Expression::ArrowFunctionExpression(arrow) = node
            && !matches!(&arrow.body, ArrowFunctionBody::FunctionBody(_))
            && !matches!(&arrow.body, ArrowFunctionBody::Identifier(identifier) if identifier.name == "undefined")
        {
            self.collect(
                node.span(),
                "() => undefined".into(),
                "ArrowFunction",
                &mut switches,
            );
        }
        match node {
            Expression::BooleanLiteral(boolean) => self.collect(
                node.span(),
                (!boolean.value).to_string(),
                "BooleanLiteral",
                &mut switches,
            ),
            Expression::UnaryExpression(unary) if unary.operator == U::LogicalNot => self.collect(
                node.span(),
                self.print(&unary.argument),
                "BooleanLiteral",
                &mut switches,
            ),
            _ => {}
        }
        let boolean_expression = match node {
            Expression::BinaryExpression(binary) => {
                binary.operator.is_equality() || binary.operator.is_compare()
            }
            Expression::LogicalExpression(logical) => logical.operator != L::Coalesce,
            _ => false,
        };
        let conditionals: &[&str] = if context.if_test {
            &["true", "false"]
        } else if boolean_expression {
            match context.logical_parent {
                Some(L::Or) => &["false"],
                Some(L::And) => &["true"],
                _ => &["true", "false"],
            }
        } else {
            &[]
        };
        for &replacement in conditionals {
            self.collect(
                node.span(),
                replacement.into(),
                "ConditionalExpression",
                &mut switches,
            );
        }
        if let Expression::BinaryExpression(binary) = node {
            let replacements: &[B] = match binary.operator {
                B::LessThan => &[B::LessEqualThan, B::GreaterEqualThan],
                B::LessEqualThan => &[B::LessThan, B::GreaterThan],
                B::GreaterThan => &[B::GreaterEqualThan, B::LessEqualThan],
                B::GreaterEqualThan => &[B::GreaterThan, B::LessThan],
                B::Equality => &[B::Inequality],
                B::Inequality => &[B::Equality],
                B::StrictEquality => &[B::StrictInequality],
                B::StrictInequality => &[B::StrictEquality],
                _ => &[],
            };
            for &replacement in replacements {
                let text = self.changed(node, |node| {
                    if let Expression::BinaryExpression(binary) = node {
                        binary.operator = replacement;
                    }
                });
                self.collect(node.span(), text, "EqualityOperator", &mut switches);
            }
        }
        if let Expression::LogicalExpression(logical) = node {
            let replacement = if logical.operator == L::And {
                L::Or
            } else {
                L::And
            };
            let text = self.changed(node, |node| {
                if let Expression::LogicalExpression(logical) = node {
                    logical.operator = replacement;
                }
            });
            self.collect(node.span(), text, "LogicalOperator", &mut switches);
        }
        if let Expression::UnaryExpression(unary) = node {
            let replacement = match unary.operator {
                U::UnaryPlus | U::UnaryNegation => Some(self.changed(node, |node| {
                    if let Expression::UnaryExpression(unary) = node {
                        unary.operator = if unary.operator == U::UnaryPlus {
                            U::UnaryNegation
                        } else {
                            U::UnaryPlus
                        };
                    }
                })),
                U::BitwiseNot => Some(self.print(&unary.argument)),
                _ => None,
            };
            if let Some(text) = replacement {
                self.collect(node.span(), text, "UnaryOperator", &mut switches);
            }
        }

        let mut edits = vec![];
        match node {
            Expression::Identifier(_) | Expression::BooleanLiteral(_) | Expression::NullLiteral(_) => {},
            Expression::NumericLiteral(_) => {
                // Oxc normalizes some number spellings while Babel preserves raw
                // literals in cloned mutations. Reject incompatible record text.
                if self.print(node) != self.text(node.span()) { return Err("Numeric literal spelling requires upstream replacement formatting".into()); }
            }
            Expression::BinaryExpression(binary) => {
                if !matches!(binary.operator, B::Addition | B::Subtraction | B::Multiplication | B::Division | B::Remainder | B::Equality | B::Inequality | B::StrictEquality | B::StrictInequality | B::LessThan | B::LessEqualThan | B::GreaterThan | B::GreaterEqualThan) { return Err("Unsupported binary operator in native grammar".into()); }
                let child_context = Context { printed_ancestor: true, ..Context::default() };
                edits.push((binary.left.span(), self.expression(&binary.left, child_context)?));
                edits.push((binary.right.span(), self.expression(&binary.right, child_context)?));
            }
            Expression::LogicalExpression(logical) => {
                let child_context = Context { logical_parent: Some(logical.operator), printed_ancestor: true, ..Context::default() };
                edits.push((logical.left.span(), self.expression(&logical.left, child_context)?));
                edits.push((logical.right.span(), self.expression(&logical.right, child_context)?));
            }
            Expression::UnaryExpression(unary) => {
                if unary.operator == U::Delete { return Err("delete requires upstream placement semantics".into()); }
                let printed = context.printed_ancestor || matches!(unary.operator, U::UnaryPlus | U::UnaryNegation | U::LogicalNot | U::BitwiseNot);
                edits.push((unary.argument.span(), self.expression(&unary.argument, Context { printed_ancestor: printed, ..Context::default() })?));
            }
            Expression::ConditionalExpression(conditional) => {
                for child in [&conditional.test, &conditional.consequent, &conditional.alternate] {
                    edits.push((child.span(), self.expression(child, Context { printed_ancestor: context.printed_ancestor, ..Context::default() })?));
                }
            }
            Expression::ArrowFunctionExpression(arrow) => {
                if arrow.r#async || arrow.type_parameters.is_some() || arrow.return_type.is_some() { return Err("Async or typed arrows require upstream instrumentation".into()); }
                self.parameters(&arrow.params)?;
                match &arrow.body {
                    ArrowFunctionBody::FunctionBody(body) => edits.push((body.span, self.body(body)?)),
                    _ => {
                        let body = arrow.body.as_expression().ok_or("Unsupported arrow body")?;
                        edits.push((body.span(), self.expression(body, Context::default())?));
                    }
                }
            }
            _ => return Err("Unsupported expression in native grammar (calls, members, strings, templates, regex, collections, classes, assignments, updates, and type syntax require upstream)".into()),
        }
        let mut original = self.apply(node.span(), edits);
        if switches.is_empty() {
            return Ok(original);
        }
        if matches!(node, Expression::ArrowFunctionExpression(_))
            && let Some(name) = context.binding_name
        {
            original = format!("(() => {{ const {name} = {original}; return {name}; }})()");
        }
        let ids = switches
            .iter()
            .map(|switch| format!("\"{}\"", switch.id))
            .collect::<Vec<_>>()
            .join(", ");
        let mut output = format!("(stryCov_9fa48({ids}), ({original}))");
        for switch in switches {
            output = format!(
                "(stryMutAct_9fa48(\"{}\") ? ({}) : {output})",
                switch.id, switch.replacement
            );
        }
        Ok(output)
    }

    fn parameters(&self, params: &FormalParameters<'_>) -> Result<(), String> {
        if params.rest.is_some()
            || params.items.iter().any(|parameter| {
                !matches!(parameter.pattern, BindingPattern::BindingIdentifier(_))
                    || parameter.initializer.is_some()
                    || parameter.type_annotation.is_some()
                    || !parameter.decorators.is_empty()
            })
        {
            return Err("Only simple identifier function parameters are supported natively".into());
        }
        Ok(())
    }

    fn function(&mut self, function: &Function<'_>) -> Result<String, String> {
        if function.r#async
            || function.generator
            || function.declare
            || function.type_parameters.is_some()
            || function.return_type.is_some()
            || function.this_param.is_some()
        {
            return Err(
                "Async, generator, declared, or typed functions require upstream instrumentation"
                    .into(),
            );
        }
        self.parameters(&function.params)?;
        let body = function.body.as_ref().ok_or("Function without body")?;
        let rendered = self.body(body)?;
        Ok(self.apply(function.span, vec![(body.span, rendered)]))
    }

    fn variables(&mut self, variables: &VariableDeclaration<'_>) -> Result<String, String> {
        if !matches!(
            variables.kind,
            VariableDeclarationKind::Var
                | VariableDeclarationKind::Let
                | VariableDeclarationKind::Const
        ) {
            return Err("using declarations require upstream instrumentation".into());
        }
        let mut edits = vec![];
        for variable in &variables.declarations {
            let BindingPattern::BindingIdentifier(binding) = &variable.id else {
                return Err("Destructuring bindings require upstream instrumentation".into());
            };
            if variable.type_annotation.is_some() || variable.definite {
                return Err("Typed bindings require upstream instrumentation".into());
            }
            if let Some(initializer) = &variable.init {
                edits.push((
                    initializer.span(),
                    self.expression(
                        initializer,
                        Context {
                            binding_name: Some(binding.name.as_str()),
                            ..Context::default()
                        },
                    )?,
                ));
            }
        }
        Ok(Self::terminate(self.apply(variables.span, edits)))
    }

    // Replacements can start with `(`. Preserve ASI boundaries so that an
    // adjacent statement cannot turn an initializer/return value into a call.
    fn terminate(mut statement: String) -> String {
        if !statement.trim_end().ends_with(';') {
            statement.push(';');
        }
        statement
    }

    fn body(&mut self, body: &FunctionBody<'_>) -> Result<String, String> {
        if !body.directives.is_empty() {
            return Err("Function directives require upstream instrumentation".into());
        }
        self.block(body.span, &body.statements)
    }

    fn block(&mut self, span: Span, statements: &[Statement<'_>]) -> Result<String, String> {
        let mut switches = vec![];
        if !statements.is_empty() {
            self.collect(span, "{}".into(), "BlockStatement", &mut switches);
        }
        let edits = statements
            .iter()
            .map(|statement| {
                self.statement(statement, false)
                    .map(|output| (statement.span(), output))
            })
            .collect::<Result<Vec<_>, _>>()?;
        let original = self.apply(span, edits);
        if switches.is_empty() {
            return Ok(original);
        }
        // A block mutation's placement is its own block. Upstream flattens the
        // original statements into the coverage branch and retains an outer block.
        let inner = &original[1..original.len() - 1];
        let switch = &switches[0];
        Ok(format!(
            "{{ if (stryMutAct_9fa48(\"{}\")) {{ {{}} }} else {{ stryCov_9fa48(\"{}\"); {inner} }} }}",
            switch.id, switch.id
        ))
    }

    fn declaration(&mut self, node: &Declaration<'_>) -> Result<String, String> {
        match node {
            Declaration::FunctionDeclaration(function) => self.function(function),
            Declaration::VariableDeclaration(variables) => self.variables(variables),
            _ => Err("Unsupported exported declaration in native grammar".into()),
        }
    }

    fn statement(&mut self, node: &Statement<'_>, top_level: bool) -> Result<String, String> {
        let mut edits = vec![];
        match node {
            Statement::FunctionDeclaration(function) => {
                if !top_level { return Err("Nested function declarations require upstream hoisting semantics".into()); }
                return self.function(function);
            }
            Statement::VariableDeclaration(variables) => return self.variables(variables),
            Statement::BlockStatement(block) => return self.block(block.span, &block.body),
            Statement::ReturnStatement(statement) => if let Some(expression) = &statement.argument { edits.push((expression.span(), self.expression(expression, Context::default())?)); },
            Statement::ExpressionStatement(statement) => edits.push((statement.expression.span(), self.expression(&statement.expression, Context::default())?)),
            Statement::IfStatement(statement) => {
                edits.push((statement.test.span(), self.expression(&statement.test, Context { if_test: true, ..Context::default() })?));
                edits.push((statement.consequent.span(), self.statement(&statement.consequent, false)?));
                if let Some(alternate) = &statement.alternate { edits.push((alternate.span(), self.statement(alternate, false)?)); }
            }
            Statement::ExportDeclaration(export) => edits.push((export.declaration.span(), self.declaration(&export.declaration)?)),
            Statement::ExportNamedDeclaration(export) => {
                if export.specifiers.iter().any(|specifier| matches!(specifier.local, ModuleExportName::StringLiteral(_)) || matches!(specifier.exported, ModuleExportName::StringLiteral(_))) {
                    return Err("String-named export specifiers require upstream instrumentation".into());
                }
            }
            Statement::ExportFromDeclaration(export) => {
                if export.with_clause.is_some() || export.specifiers.iter().any(|specifier| matches!(specifier.local, ModuleExportName::StringLiteral(_)) || matches!(specifier.exported, ModuleExportName::StringLiteral(_))) {
                    return Err("Export attributes or string-named specifiers require upstream instrumentation".into());
                }
            }
            Statement::ExportAllDeclaration(export) => {
                if export.with_clause.is_some() || export.exported.as_ref().is_some_and(|name| matches!(name, ModuleExportName::StringLiteral(_))) { return Err("Export attributes or string-named namespace aliases require upstream instrumentation".into()); }
            }
            Statement::ImportDeclaration(import) => {
                if import.phase.is_some() || import.with_clause.is_some() { return Err("Import phases and attributes require upstream instrumentation".into()); }
            }
            Statement::EmptyStatement(_) => {},
            _ => return Err("Unsupported statement in native grammar (loops, switch, try, classes, default exports, and control-flow extensions require upstream)".into()),
        }
        let output = self.apply(node.span(), edits);
        Ok(
            if matches!(
                node,
                Statement::ReturnStatement(_) | Statement::ExpressionStatement(_)
            ) {
                Self::terminate(output)
            } else {
                output
            },
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(source: &str, options: Value) -> Response {
        instrument_batch(&serde_json::json!({"files": [{"name": "input.js", "mutate": true, "content": source}], "options": options}).to_string())
    }

    #[test]
    fn instruments_function_and_arrow_in_preorder() {
        let response = run(
            "export function add(a,b) { return a+b; } export const positive = n => n > 0;",
            Value::Null,
        );
        assert!(response.supported, "{:?}", response.reason);
        let result = response.result.unwrap();
        let records: Vec<_> = result
            .mutants
            .iter()
            .map(|mutant| {
                (
                    mutant.id.as_str(),
                    mutant.mutator_name,
                    mutant.replacement.as_str(),
                )
            })
            .collect();
        assert_eq!(
            records,
            [
                ("0", "BlockStatement", "{}"),
                ("1", "ArithmeticOperator", "a - b"),
                ("2", "ArrowFunction", "() => undefined"),
                ("3", "ConditionalExpression", "true"),
                ("4", "ConditionalExpression", "false"),
                ("5", "EqualityOperator", "n >= 0"),
                ("6", "EqualityOperator", "n <= 0")
            ]
        );
        assert!(
            result.files[0]
                .content
                .contains("(() => { const positive = n =>")
        );
        assert!(result.files[0].content.starts_with(HEADER));
    }

    #[test]
    fn rejects_batches_atomically_and_rejects_options() {
        for source in [
            "function f(){ return call(); }",
            "const o = {a:1};",
            "const x = 'string';",
            "// Stryker disable all\nconst x = 1;",
            "function f(x = 1) { return x; }",
            "const x = a.value;",
            "const stryCov_9fa48 = 1;",
            "const x = a + 0x10;",
            "const x = a + 1_000;",
            "const x = a + 1e2;",
            "const x = a + (b => b);",
            "export { 'source' as value } from 'module';",
            "export * from 'module' with { type: 'json' };",
        ] {
            let response = run(source, Value::Null);
            assert!(!response.supported, "{source}");
            assert!(response.result.is_none());
        }
        for options in [
            serde_json::json!({"plugins": ["jsx"]}),
            serde_json::json!({"ignorers": [{}]}),
            serde_json::json!({"unknown": true}),
        ] {
            assert!(!run("const x = 1 + 2;", options).supported);
        }
        let response = instrument_batch(
            r#"{"files":[{"name":"first.js","mutate":true,"content":"const x=1+2;"},{"name":"second.js","mutate":true,"content":"call();"}],"options":{}}"#,
        );
        assert!(!response.supported);
        assert!(response.result.is_none());
    }

    #[test]
    fn ignored_mutants_keep_ids_and_status_without_switches() {
        let response = run(
            "function add(a,b) { return a+b; }",
            serde_json::json!({"excludedMutations": ["BlockStatement", "ArithmeticOperator"]}),
        );
        let result = response.result.unwrap();
        assert_eq!(result.mutants.len(), 2);
        assert_eq!(result.mutants[1].id, "1");
        assert_eq!(result.mutants[1].status, Some("Ignored"));
        assert!(!result.files[0].content.contains("stryCov_9fa48"));
    }

    #[test]
    fn native_locations_count_utf16_columns_and_js_line_breaks() {
        let response = run(
            "import '😀';\r\nexport const x = 1+2;\u{2028}const y = false;",
            Value::Null,
        );
        let result = response.result.unwrap();
        assert_eq!(result.mutants[0].location.start.line, 1);
        assert_eq!(result.mutants[0].location.start.column, 17);
        assert_eq!(result.mutants[1].location.start.line, 2);
        assert_eq!(result.mutants[1].location.start.column, 10);
    }
}
