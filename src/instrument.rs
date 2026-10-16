//! Conservative native instrumentation, distinct from the broader candidate preview.
//!
//! Every accepted node has complete mutation/placement semantics for the supported
//! grammar. An unsupported node/options value rejects the entire batch. This is
//! essential: silently omitting one mutant would change mutation scores.

use std::collections::{HashMap, HashSet};

use oxc_allocator::{Allocator, Box as ArenaBox, CloneIn};
use oxc_ast::{ast::*, builder::AstBuilder};
use oxc_ast_visit::{Visit, VisitMut, walk, walk_mut};
use oxc_codegen::{Codegen, CodegenOptions, Gen};
use oxc_parser::{ParseOptions, Parser};
use oxc_semantic::SemanticBuilder;
use oxc_span::{GetSpan, SourceType, Span};
use oxc_syntax::operator::{
    BinaryOperator as B, LogicalOperator as L, UnaryOperator as U, UpdateOperator,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::mutations::{
    Utf16Offsets, assignment_operator_replacement, method_replacement as method_mapping,
};

mod parallel;

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
    #[serde(default)]
    execution: parallel::Request,
}

#[derive(Deserialize, Serialize)]
struct File {
    name: String,
    mutate: Selection,
    content: String,
}

#[derive(Serialize)]
pub(crate) struct Response {
    supported: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<InstrumentResult>,
    #[serde(skip_serializing_if = "Option::is_none")]
    execution: Option<parallel::Execution>,
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

#[derive(Deserialize, Serialize)]
struct Location {
    start: Position,
    end: Position,
}

#[derive(Clone, Copy, Deserialize, PartialEq, Eq, PartialOrd, Ord, Serialize)]
struct Position {
    line: usize,
    column: u32,
}

// Preserve the caller's boolean/array representation in returned files. These
// comparisons intentionally include touching boundaries, matching Stryker 10.
#[derive(Deserialize, Serialize)]
#[serde(untagged)]
enum Selection {
    Boolean(bool),
    Ranges(Vec<Location>),
}

impl Selection {
    fn includes(&self, location: &Location) -> bool {
        match self {
            Self::Boolean(enabled) => *enabled,
            Self::Ranges(ranges) => ranges
                .iter()
                .any(|range| range.start <= location.start && range.end >= location.end),
        }
    }

    fn overlaps(&self, location: &Location) -> bool {
        match self {
            Self::Boolean(enabled) => *enabled,
            Self::Ranges(ranges) => ranges
                .iter()
                .any(|range| range.start <= location.end && range.end >= location.start),
        }
    }
}

// Validation uses the entire upstream registry, not just native mutators.
const MUTATOR_NAMES: &[&str] = &[
    "arithmeticoperator",
    "arraydeclaration",
    "arrowfunction",
    "blockstatement",
    "booleanliteral",
    "conditionalexpression",
    "callexpression",
    "equalityoperator",
    "logicaloperator",
    "methodexpression",
    "objectliteral",
    "stringliteral",
    "unaryoperator",
    "updateoperator",
    "regex",
    "optionalchaining",
    "assignmentoperator",
];

struct Directive {
    names: Vec<String>,
    next_line: bool,
    reason: Option<String>,
    warns: bool,
}

fn js_whitespace(ch: char) -> bool {
    matches!(
        ch,
        '\t' | '\u{000b}'
            | '\u{000c}'
            | ' '
            | '\u{00a0}'
            | '\u{feff}'
            | '\n'
            | '\r'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200a}' | '\u{202f}' | '\u{205f}' | '\u{3000}'
    )
}

impl Directive {
    fn parse(text: &str) -> Option<Self> {
        // Equivalent to upstream's anchored regex, including its single optional
        // whitespace, greedy ASCII name list, unanchored tail and optional reason.
        let text = if text.chars().next().is_some_and(js_whitespace) {
            &text[text.chars().next()?.len_utf8()..]
        } else {
            text
        };
        let text = text.strip_prefix("Stryker ")?;
        let (disable, text) = if let Some(text) = text.strip_prefix("disable ") {
            (true, text)
        } else {
            (false, text.strip_prefix("restore ")?)
        };
        // The optional scope backtracks when it leaves no valid name. In that
        // case upstream matches "next" as a name and emits an unused warning.
        let (next_line, text) = if let Some(scoped) = text.strip_prefix("next-line ")
            && scoped
                .bytes()
                .next()
                .is_some_and(|ch| ch.is_ascii_alphabetic() || matches!(ch, b',' | b' '))
        {
            (true, scoped)
        } else {
            (false, text)
        };
        let length = text
            .bytes()
            .take_while(|ch| ch.is_ascii_alphabetic() || matches!(ch, b',' | b' '))
            .count();
        if length == 0 {
            return None;
        }
        let names: Vec<_> = text[..length]
            .split(',')
            .map(|name| name.trim_matches(js_whitespace).to_string())
            .collect();
        let warns = names.iter().any(|name| {
            name != "all" && !MUTATOR_NAMES.contains(&name.to_ascii_lowercase().as_str())
        });
        let reason = text[length..]
            .strip_prefix(':')
            .map(|text| {
                text.split(['\r', '\n', '\u{2028}', '\u{2029}'])
                    .next()
                    .unwrap_or_default()
            })
            .filter(|text| !text.is_empty())
            .unwrap_or("Ignored using a comment")
            .trim_matches(js_whitespace)
            .to_string();
        Some(Self {
            names: names
                .into_iter()
                .map(|name| name.to_ascii_lowercase())
                .collect(),
            next_line,
            reason: disable.then_some(reason),
            warns,
        })
    }
}

struct Rule {
    names: Vec<String>,
    line: Option<usize>,
    reason: Option<String>,
}

// Token attachment is not Babel leading-comment ownership. Only gaps in actual
// statement/member lists are proven here. Unowned closing/EOF
// comments are preserved but do not create rules.
struct CommentBoundaries<'s> {
    gaps: Vec<(Span, Option<u32>)>,
    source: &'s str,
}

impl<'s> CommentBoundaries<'s> {
    fn list(&mut self, start: u32, end: u32, statements: &[Statement<'_>]) {
        let mut previous = start;
        for statement in statements {
            let span = statement.span();
            self.gaps
                .push((Span::new(previous, span.start), Some(span.start)));
            previous = span.end;
        }
        self.gaps.push((Span::new(previous, end), None));
    }

    fn directives(
        program: &Program<'_>,
        source: &'s str,
    ) -> Result<HashMap<u32, Vec<Directive>>, String> {
        let mut boundaries = Self {
            gaps: vec![],
            source,
        };
        boundaries.visit_program(program);
        boundaries.gaps.sort_unstable_by_key(|(span, _)| span.start);
        let mut directives: HashMap<u32, Vec<Directive>> = HashMap::new();
        for comment in &program.comments {
            if !matches!(
                comment.kind,
                CommentKind::Line | CommentKind::SingleLineBlock | CommentKind::MultiLineBlock
            ) {
                return Err("HTML comments require upstream instrumentation".into());
            }
            let index = boundaries
                .gaps
                .partition_point(|(gap, _)| gap.start <= comment.span.start);
            let Some((gap, owner)) = index
                .checked_sub(1)
                .and_then(|index| boundaries.gaps.get(index))
            else {
                return Err(
                    "Ambiguous comment attachment requires upstream instrumentation".into(),
                );
            };
            if comment.span.end > gap.end {
                return Err("Comments outside statement-list boundaries require upstream attachment and replacement printing".into());
            }
            if let Some(owner) = owner
                && let Some(directive) =
                    Directive::parse(comment.content_span().source_text(source))
            {
                directives.entry(*owner).or_default().push(directive);
            }
        }
        Ok(directives)
    }
}

impl<'a> Visit<'a> for CommentBoundaries<'_> {
    fn visit_program(&mut self, node: &Program<'a>) {
        self.list(node.span.start, node.span.end, &node.body);
        walk::walk_program(self, node);
    }

    fn visit_block_statement(&mut self, node: &BlockStatement<'a>) {
        self.list(node.span.start + 1, node.span.end - 1, &node.body);
        walk::walk_block_statement(self, node);
    }

    fn visit_class_body(&mut self, node: &ClassBody<'a>) {
        let mut previous = node.span.start + 1;
        for element in &node.body {
            let span = element.span();
            self.gaps
                .push((Span::new(previous, span.start), Some(span.start)));
            previous = span.end;
        }
        self.gaps
            .push((Span::new(previous, node.span.end - 1), None));
        walk::walk_class_body(self, node);
    }

    fn visit_static_block(&mut self, node: &StaticBlock<'a>) {
        // The span includes `static`. Starting after its first brace also
        // rejects comments in the header, even if that brace is in a comment.
        let brace = node.span.source_text(self.source).find('{').unwrap();
        self.list(
            node.span.start + brace as u32 + 1,
            node.span.end - 1,
            &node.body,
        );
        walk::walk_static_block(self, node);
    }

    fn visit_function_body(&mut self, node: &FunctionBody<'a>) {
        self.list(node.span.start + 1, node.span.end - 1, &node.statements);
        walk::walk_function_body(self, node);
    }
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
            parallel::execute(input.files, &options, input.execution)
        });
    match result {
        Ok((result, execution)) => Response {
            supported: true,
            reason: None,
            result: Some(result),
            execution: Some(execution),
        },
        Err(reason) => Response {
            supported: false,
            reason: Some(reason),
            result: None,
            execution: None,
        },
    }
}

fn instrument_file(
    file: &File,
    options: &Options,
    records: &mut Vec<ApiMutant>,
    next_id: &mut usize,
) -> Result<String, String> {
    instrument_file_inner(file, options, records, next_id, None)
}

fn instrument_file_inner(
    file: &File,
    options: &Options,
    records: &mut Vec<ApiMutant>,
    next_id: &mut usize,
    relocation_proven: Option<&mut bool>,
) -> Result<String, String> {
    if file.content.len() > u32::MAX as usize {
        return Err("Source exceeds 32-bit span limits".into());
    }
    let source_type = SourceType::from_path(&file.name).map_err(|error| error.to_string())?;
    if source_type.is_jsx() {
        return Err("JSX and TSX require upstream instrumentation".into());
    }
    // Babel uses the TS parser for declaration extensions too, without Oxc's
    // ambient-definition restrictions on otherwise ordinary runtime statements.
    let source_type = source_type.with_typescript(source_type.is_typescript());
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
        || parsed.program.hashbang.is_some()
        || !parsed.program.directives.is_empty()
    {
        return Err("Directive prologues, hashbangs, and Flow preprocessing require upstream instrumentation".into());
    }
    let directives = CommentBoundaries::directives(&parsed.program, &file.content)?;
    let semantics = SemanticBuilder::new()
        .with_check_syntax_error(true)
        .build(&parsed.program);
    if !semantics.diagnostics.is_empty() {
        return Err(format!("Syntax error: {:?}", semantics.diagnostics));
    }
    // Parser compatibility is independent of mutation traversal: opaque TS
    // expressions and unselected ranges can still contain parameter defaults.
    let mut assignments = ParameterAssignments {
        source: &file.content,
        parameter_expression: false,
        unproven: false,
    };
    assignments.visit_program(&parsed.program);
    if assignments.unproven {
        return Err("Typed or parenthesized identifier assignment targets in defaults require upstream parameter parsing".into());
    }
    let mut bindings = ReservedBindings::default();
    bindings.visit_program(&parsed.program);
    if bindings.found {
        return Err("Source shadows an instrumentation helper or runtime global".into());
    }
    if let Some(proven) = relocation_proven {
        // This parallel-only walk intentionally has none of ReservedBindings'
        // opaque TypeScript skips. Even an unexecuted helper reference prevents
        // attributing every helper call in completed output to the emitter.
        *proven = !parallel::has_helper_identifiers(&parsed.program);
    }
    let mut emitter = Emitter {
        source: &file.content,
        file_name: &file.name,
        positions: Positions::new(&file.content),
        options,
        selection: &file.mutate,
        pruned: false,
        directives,
        rules: vec![],
        records,
        next_id,
        placed: 0,
        printed_statement: false,
        ts_skip_generation: 0,
        labels: vec![],
        comment_spans: parsed
            .program
            .comments
            .iter()
            .map(|comment| comment.span)
            .collect(),
    };
    emitter.pruned = !file.mutate.overlaps(&emitter.location(parsed.program.span));
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
        // Leave the first statement's comment preamble ahead of the helpers.
        let preamble = parsed
            .program
            .body
            .first()
            .map_or(0, |statement| statement.span().start as usize);
        output.insert_str(preamble, HEADER);
    }
    Ok(output)
}

#[derive(Default)]
struct ReservedBindings {
    found: bool,
}

impl<'a> Visit<'a> for ReservedBindings {
    fn visit_ts_as_expression(&mut self, _: &TSAsExpression<'a>) {}
    fn visit_ts_type_annotation(&mut self, _: &TSTypeAnnotation<'a>) {}
    fn visit_ts_type_parameter_declaration(&mut self, _: &TSTypeParameterDeclaration<'a>) {}
    fn visit_ts_type_parameter_instantiation(&mut self, _: &TSTypeParameterInstantiation<'a>) {}
    fn visit_ts_type_alias_declaration(&mut self, _: &TSTypeAliasDeclaration<'a>) {}
    fn visit_ts_interface_declaration(&mut self, _: &TSInterfaceDeclaration<'a>) {}
    fn visit_function(&mut self, node: &Function<'a>, flags: oxc_syntax::scope::ScopeFlags) {
        if !node.declare && node.body.is_some() {
            walk::walk_function(self, node, flags);
        }
    }
    fn visit_variable_declaration(&mut self, node: &VariableDeclaration<'a>) {
        if !node.declare {
            walk::walk_variable_declaration(self, node);
        }
    }
    fn visit_ts_external_module_declaration(&mut self, node: &TSExternalModuleDeclaration<'a>) {
        if !node.declare {
            walk::walk_ts_external_module_declaration(self, node);
        }
    }
    fn visit_ts_namespace_declaration(&mut self, node: &TSNamespaceDeclaration<'a>) {
        if !node.declare {
            walk::walk_ts_namespace_declaration(self, node);
        }
    }
    fn visit_ts_global_declaration(&mut self, node: &TSGlobalDeclaration<'a>) {
        if !node.declare {
            walk::walk_ts_global_declaration(self, node);
        }
    }

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
    loop_test: bool,
    logical_parent: Option<L>,
    binding_name: Option<&'a str>,
    printed_ancestor: bool,
    skip_string: bool,
    raw_string_rhs: Option<Span>,
}

fn arithmetic_replacement(binary: &BinaryExpression<'_>) -> Option<B> {
    // Match Stryker's syntactic exclusion, including the rightmost operand of
    // one immediately nested binary on the left. This is not type inference.
    let left = match &binary.left {
        Expression::BinaryExpression(left) => &left.right,
        left => left,
    };
    if [left, &binary.right].iter().any(|operand| {
        matches!(
            operand,
            Expression::StringLiteral(_) | Expression::TemplateLiteral(_)
        )
    }) {
        return None;
    }
    match binary.operator {
        B::Addition => Some(B::Subtraction),
        B::Subtraction => Some(B::Addition),
        B::Multiplication => Some(B::Division),
        B::Division | B::Remainder => Some(B::Multiplication),
        _ => None,
    }
}

fn assignment_replacement(
    node: &AssignmentExpression<'_>,
) -> Option<oxc_syntax::operator::AssignmentOperator> {
    // Match the direct syntactic RHS exclusion, without inferring its value.
    if !node.operator.is_logical()
        && matches!(
            node.right,
            Expression::StringLiteral(_) | Expression::TemplateLiteral(_)
        )
    {
        None
    } else {
        assignment_operator_replacement(node.operator)
    }
}

fn method_target<'b, 'a>(callee: &'b Expression<'a>) -> Option<(&'b Expression<'a>, &'b str)> {
    match callee {
        Expression::StaticMemberExpression(member) => {
            Some((&member.object, member.property.name.as_str()))
        }
        Expression::ComputedMemberExpression(member) => match &member.expression {
            Expression::Identifier(identifier) => Some((&member.object, identifier.name.as_str())),
            _ => None,
        },
        _ => None,
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ChainKind {
    Call,
    StaticMember,
    ComputedMember,
    PrivateMember,
    NonNull,
}

fn chain_kind(node: &Expression<'_>) -> Option<ChainKind> {
    match node {
        Expression::CallExpression(_) => Some(ChainKind::Call),
        Expression::StaticMemberExpression(_) => Some(ChainKind::StaticMember),
        Expression::ComputedMemberExpression(_) => Some(ChainKind::ComputedMember),
        Expression::PrivateFieldExpression(_) => Some(ChainKind::PrivateMember),
        Expression::TSNonNullExpression(_) => Some(ChainKind::NonNull),
        // The wrapper aliases the effective ChainElement, including its kind.
        Expression::ChainExpression(chain) => match &chain.expression {
            ChainElement::CallExpression(_) => Some(ChainKind::Call),
            ChainElement::StaticMemberExpression(_) => Some(ChainKind::StaticMember),
            ChainElement::ComputedMemberExpression(_) => Some(ChainKind::ComputedMember),
            ChainElement::TSNonNullExpression(_) => Some(ChainKind::NonNull),
            _ => None,
        },
        _ => None,
    }
}

fn private_chain(node: &Expression<'_>) -> bool {
    match node {
        Expression::PrivateFieldExpression(_) => true,
        Expression::CallExpression(call) => private_chain(&call.callee),
        Expression::StaticMemberExpression(member) => private_chain(&member.object),
        Expression::ComputedMemberExpression(member) => private_chain(&member.object),
        Expression::TSNonNullExpression(non_null) => private_chain(&non_null.expression),
        _ => false,
    }
}

fn super_chain(node: &Expression<'_>) -> bool {
    match node {
        Expression::Super(_) => true,
        Expression::CallExpression(call) => super_chain(&call.callee),
        Expression::StaticMemberExpression(member) => super_chain(&member.object),
        Expression::ComputedMemberExpression(member) => super_chain(&member.object),
        Expression::TSNonNullExpression(non_null) => super_chain(&non_null.expression),
        _ => false,
    }
}

fn non_null_chain(node: &Expression<'_>) -> bool {
    match node {
        Expression::TSNonNullExpression(_) => true,
        Expression::CallExpression(call) => non_null_chain(&call.callee),
        Expression::StaticMemberExpression(member) => non_null_chain(&member.object),
        Expression::ComputedMemberExpression(member) => non_null_chain(&member.object),
        Expression::PrivateFieldExpression(member) => non_null_chain(&member.object),
        _ => false,
    }
}

fn delete_reference(node: &Expression<'_>) -> bool {
    match node {
        Expression::StaticMemberExpression(_) | Expression::ComputedMemberExpression(_) => true,
        Expression::TSNonNullExpression(non_null) => delete_reference(&non_null.expression),
        Expression::ChainExpression(chain) => {
            matches!(
                &chain.expression,
                ChainElement::StaticMemberExpression(_) | ChainElement::ComputedMemberExpression(_)
            ) || matches!(&chain.expression, ChainElement::TSNonNullExpression(non_null) if delete_reference(&non_null.expression))
        }
        _ => false,
    }
}

// Babel kind propagates only along an uninterrupted callee/object spine. A
// nested ChainExpression marks parentheses and starts a separate expression.
fn optional_kind(node: &Expression<'_>) -> bool {
    match node {
        Expression::CallExpression(call) => call.optional || optional_kind(&call.callee),
        Expression::StaticMemberExpression(member) => {
            member.optional || optional_kind(&member.object)
        }
        Expression::ComputedMemberExpression(member) => {
            member.optional || optional_kind(&member.object)
        }
        Expression::TSNonNullExpression(non_null) => optional_kind(&non_null.expression),
        _ => false,
    }
}

fn own_optional(node: &Expression<'_>) -> bool {
    match node {
        Expression::CallExpression(call) => call.optional,
        Expression::StaticMemberExpression(member) => member.optional,
        Expression::ComputedMemberExpression(member) => member.optional,
        _ => false,
    }
}

fn simple_printed_type(node: &TSType<'_>) -> bool {
    match node {
        TSType::TSTypeReference(reference) => {
            reference.type_arguments.is_none()
                && matches!(reference.type_name, TSTypeName::IdentifierReference(_))
        }
        TSType::TSAnyKeyword(_)
        | TSType::TSBigIntKeyword(_)
        | TSType::TSBooleanKeyword(_)
        | TSType::TSNeverKeyword(_)
        | TSType::TSNullKeyword(_)
        | TSType::TSNumberKeyword(_)
        | TSType::TSObjectKeyword(_)
        | TSType::TSStringKeyword(_)
        | TSType::TSSymbolKeyword(_)
        | TSType::TSUndefinedKeyword(_)
        | TSType::TSUnknownKeyword(_)
        | TSType::TSVoidKeyword(_) => true,
        _ => false,
    }
}

fn chain_prints(node: &Expression<'_>) -> bool {
    if own_optional(node) {
        return true;
    }
    match node {
        Expression::ChainExpression(_) => true,
        Expression::CallExpression(call) => {
            matches!(&call.callee, Expression::Identifier(identifier) if identifier.name == "Array")
                || method_target(&call.callee)
                    .is_some_and(|(_, name)| method_mapping(name).is_some())
                || chain_prints(&call.callee)
        }
        Expression::StaticMemberExpression(member) => chain_prints(&member.object),
        Expression::ComputedMemberExpression(member) => chain_prints(&member.object),
        Expression::PrivateFieldExpression(member) => chain_prints(&member.object),
        Expression::TSNonNullExpression(non_null) => chain_prints(&non_null.expression),
        _ => false,
    }
}

#[derive(Default)]
struct StringLiteralCount(usize);

impl<'a> Visit<'a> for StringLiteralCount {
    fn visit_string_literal(&mut self, _: &StringLiteral<'a>) {
        self.0 += 1;
    }
}

// Replace a cloned AST node, never splice unprotected text into a callee. The
// generator restores precedence for the mutated ancestor's entire chain.
struct ReplaceExpression<'a, 'b> {
    target: Span,
    kind: ChainKind,
    replacement: &'b Expression<'a>,
    allocator: &'a Allocator,
    replaced: usize,
}

impl<'a> VisitMut<'a> for ReplaceExpression<'a, '_> {
    fn visit_expression(&mut self, node: &mut Expression<'a>) {
        if node.span() == self.target && chain_kind(node) == Some(self.kind) {
            let replacement = self.replacement.clone_in(self.allocator);
            // The wrapper and its ChainElement root alias the same Babel node.
            // Replace the wrapper once and do not visit its root hook. For an
            // interior segment, the parser's new wrapper must be removed: it
            // would otherwise introduce parentheses and terminate short-circuiting.
            *node = match replacement {
                Expression::ChainExpression(chain)
                    if !matches!(node, Expression::ChainExpression(_)) =>
                {
                    Expression::from(chain.unbox().expression)
                }
                replacement => replacement,
            };
            self.replaced += 1;
        } else {
            walk_mut::walk_expression(self, node);
        }
    }

    fn visit_simple_assignment_target(&mut self, node: &mut SimpleAssignmentTarget<'a>) {
        // Lvalue roots do not pass through visit_expression. Only their object
        // and computed key are expressions; never replace the reference itself.
        match node {
            SimpleAssignmentTarget::StaticMemberExpression(member) => {
                self.visit_expression(&mut member.object);
            }
            SimpleAssignmentTarget::ComputedMemberExpression(member) => {
                self.visit_expression(&mut member.object);
                self.visit_expression(&mut member.expression);
            }
            SimpleAssignmentTarget::PrivateFieldExpression(member) => {
                self.visit_expression(&mut member.object);
            }
            _ => walk_mut::walk_simple_assignment_target(self, node),
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum TargetPlacement {
    Assignment,
    Update,
    Iteration,
}

fn is_parameter_property(parameter: &FormalParameter<'_>) -> bool {
    parameter.accessibility.is_some() || parameter.readonly || parameter.r#override
}

// Babel's parameter expression scope rejects some assignment targets that Oxc
// accepts. Extra grouping can change that decision, but those source-dependent
// forms remain conservative fallback here. This syntactic walk must also reach
// defaults below opaque TS nodes, without depending on mutation emission owners.
// Class heritage, computed keys, and static blocks inherit the current parser
// expression scope. Field initializers and function/arrow bodies reset it, while
// every nested parameter list establishes its own parameter expression scope.
struct ParameterAssignments<'s> {
    source: &'s str,
    parameter_expression: bool,
    unproven: bool,
}

impl ParameterAssignments<'_> {
    fn expression_scope(&mut self, parameter_expression: bool, visit: impl FnOnce(&mut Self)) {
        let previous = self.parameter_expression;
        self.parameter_expression = parameter_expression;
        visit(self);
        self.parameter_expression = previous;
    }
}

impl<'a> Visit<'a> for ParameterAssignments<'_> {
    fn visit_assignment_expression(&mut self, node: &AssignmentExpression<'a>) {
        self.unproven |= self.parameter_expression
            && match &node.left {
                AssignmentTarget::TSAsExpression(_) => true,
                AssignmentTarget::AssignmentTargetIdentifier(identifier) => self.source
                    [node.span.start as usize..identifier.span.start as usize]
                    .contains('('),
                _ => false,
            };
        walk::walk_assignment_expression(self, node);
    }

    fn visit_formal_parameters(&mut self, node: &FormalParameters<'a>) {
        self.expression_scope(true, |visitor| walk::walk_formal_parameters(visitor, node));
    }

    fn visit_function(&mut self, node: &Function<'a>, flags: oxc_syntax::scope::ScopeFlags) {
        self.expression_scope(false, |visitor| walk::walk_function(visitor, node, flags));
    }

    fn visit_arrow_function_expression(&mut self, node: &ArrowFunctionExpression<'a>) {
        self.expression_scope(false, |visitor| {
            walk::walk_arrow_function_expression(visitor, node)
        });
    }

    fn visit_property_definition(&mut self, node: &PropertyDefinition<'a>) {
        self.visit_decorators(&node.decorators);
        self.visit_property_key(&node.key);
        if let Some(annotation) = &node.type_annotation {
            self.visit_ts_type_annotation(annotation);
        }
        if let Some(value) = &node.value {
            self.expression_scope(false, |visitor| visitor.visit_expression(value));
        }
    }

    fn visit_accessor_property(&mut self, node: &AccessorProperty<'a>) {
        self.visit_decorators(&node.decorators);
        self.visit_property_key(&node.key);
        if let Some(annotation) = &node.type_annotation {
            self.visit_ts_type_annotation(annotation);
        }
        if let Some(value) = &node.value {
            self.expression_scope(false, |visitor| visitor.visit_expression(value));
        }
    }
}

struct InvalidatedContinue<'a> {
    labels: Vec<&'a str>,
    found: bool,
}

impl<'a> Visit<'a> for InvalidatedContinue<'_> {
    fn visit_continue_statement(&mut self, node: &ContinueStatement<'a>) {
        self.found |= node
            .label
            .as_ref()
            .is_some_and(|label| self.labels.contains(&label.name.as_str()));
    }

    fn visit_function(&mut self, _: &Function<'a>, _: oxc_syntax::scope::ScopeFlags) {}

    fn visit_arrow_function_expression(&mut self, _: &ArrowFunctionExpression<'a>) {}
}

// Match upstream's syntactic descendant predicate, including nested functions
// and classes; this intentionally is not a lexical-scope analysis.
#[derive(Default)]
struct DirectSuperCall {
    found: bool,
}

impl<'a> Visit<'a> for DirectSuperCall {
    fn visit_call_expression(&mut self, node: &CallExpression<'a>) {
        self.found |= matches!(node.callee, Expression::Super(_));
        walk::walk_call_expression(self, node);
    }
}

struct Switch {
    target: Span,
    kind: Option<ChainKind>,
    id: String,
    replacement: String,
}

struct Emitter<'s, 'r> {
    source: &'s str,
    file_name: &'s str,
    positions: Positions,
    options: &'s Options,
    selection: &'s Selection,
    pruned: bool,
    directives: HashMap<u32, Vec<Directive>>,
    rules: Vec<Rule>,
    records: &'r mut Vec<ApiMutant>,
    next_id: &'r mut usize,
    placed: usize,
    printed_statement: bool,
    // Babel pushes filter state before path.skip(), whose exit never runs.
    // Within this grammar, a skipped TS descendant hides the enclosing
    // statement-call candidate from its exit filter. This is not a general
    // emulation of Babel's traversal stack.
    ts_skip_generation: usize,
    labels: Vec<(Span, String)>,
    comment_spans: Vec<Span>,
}

impl Emitter<'_, '_> {
    fn skip_ts(&mut self, span: Span) -> Result<String, String> {
        if !self.pruned {
            self.ts_skip_generation += 1;
        }
        self.scope(span, false, |emitter| Ok(emitter.text(span).into()))
    }

    fn location(&self, span: Span) -> Location {
        Location {
            start: self.positions.at(span.start),
            end: self.positions.at(span.end),
        }
    }

    fn scope<T>(
        &mut self,
        span: Span,
        leading_comments: bool,
        emit: impl FnOnce(&mut Self) -> Result<T, String>,
    ) -> Result<T, String> {
        let previous = self.pruned;
        if !previous
            && leading_comments
            && let Some(directives) = self.directives.remove(&span.start)
        {
            for directive in directives {
                if directive.warns {
                    return Err(
                        "Warning-producing Stryker directives require upstream logging".into(),
                    );
                }
                self.rules.push(Rule {
                    names: directive.names,
                    line: directive
                        .next_line
                        .then(|| self.positions.at(span.start).line),
                    reason: directive.reason,
                });
            }
        }
        self.pruned |= !self.selection.overlaps(&self.location(span));
        // Still validate pruned grammar, but neither collect nor process its
        // descendant directives. This preserves the conservative grammar gate.
        let result = emit(self);
        self.pruned = previous;
        result
    }

    fn ignore_reason(&self, line: usize, name: &str) -> Option<String> {
        self.rules
            .iter()
            .rev()
            .find(|rule| {
                rule.line.is_none_or(|target| target == line)
                    && rule
                        .names
                        .iter()
                        .any(|candidate| candidate == "all" || candidate.eq_ignore_ascii_case(name))
            })
            .and_then(|rule| rule.reason.clone())
            .or_else(|| {
                self.options
                    .excluded
                    .contains(name)
                    .then(|| format!("Ignored because of excluded mutation \"{name}\""))
            })
    }

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

    fn single_quoted_logical_rhs(
        &self,
        node: &Expression<'_>,
        context: Context<'_>,
    ) -> Option<Span> {
        if context.printed_ancestor {
            return None;
        }
        let Expression::LogicalExpression(logical) = node else {
            return None;
        };
        let Expression::StringLiteral(string) = &logical.right else {
            return None;
        };
        let raw = self
            .text(string.span)
            .strip_prefix('\'')?
            .strip_suffix('\'')?;
        if !raw
            .bytes()
            .all(|byte| byte.is_ascii_graphic() || byte == b' ')
            || raw.contains(['\\', '\'', '"'])
        {
            return None;
        }
        let mut strings = StringLiteralCount::default();
        strings.visit_expression(node);
        (strings.0 == 1).then_some(string.span)
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
        if self.pruned || !self.selection.includes(&self.location(span)) {
            return;
        }
        let id = self.next_id.to_string();
        *self.next_id += 1;
        let reason = self.ignore_reason(self.positions.at(span.start).line, name);
        let ignored = reason.as_ref().is_some_and(|reason| !reason.is_empty());
        self.records.push(ApiMutant {
            file_name: self.file_name.into(),
            id: id.clone(),
            location: self.location(span),
            mutator_name: name,
            replacement: replacement.clone(),
            status_reason: reason,
            status: ignored.then_some("Ignored"),
        });
        if !ignored {
            switches.push(Switch {
                target: span,
                kind: None,
                id,
                replacement,
            });
            self.placed += 1;
        }
    }

    fn expression(
        &mut self,
        node: &Expression<'_>,
        mut context: Context<'_>,
    ) -> Result<String, String> {
        // Only call/member/non-null nodes on a callee/object spine defer placement. Keys
        // and arguments keep independent placements in the original branch.
        context.printed_ancestor |= chain_prints(node);
        context.printed_ancestor |= self.printed_statement;
        let mut switches = vec![];
        let mut original = self.expression_deferred(node, context, &mut switches)?;
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
            let replacement = if switch.target == node.span() && switch.kind == chain_kind(node) {
                switch.replacement
            } else {
                self.replace_in_chain(node, switch.target, switch.kind, &switch.replacement)?
            };
            output = format!(
                "(stryMutAct_9fa48(\"{}\") ? ({replacement}) : {output})",
                switch.id
            );
        }
        Ok(output)
    }

    fn expression_deferred(
        &mut self,
        node: &Expression<'_>,
        context: Context<'_>,
        pending: &mut Vec<Switch>,
    ) -> Result<String, String> {
        // Oxc's wrapper is not a Babel node. Delegate collection/context once
        // to its effective root while keeping the wrapper for branch printing.
        if let Expression::ChainExpression(chain) = node {
            let allocator = Allocator::default();
            let inner = Expression::from(chain.expression.clone_in(&allocator));
            if private_chain(&inner) {
                return Err("Optional private chains require upstream instrumentation".into());
            }
            return self.expression_deferred(&inner, context, pending);
        }
        if matches!(node, Expression::TSAsExpression(_)) {
            if context.printed_ancestor {
                return Err("Opaque as expression inside a printed replacement requires upstream formatting".into());
            }
            return self.skip_ts(node.span());
        }
        if non_null_chain(node) && (private_chain(node) || super_chain(node)) {
            return Err(
                "Non-null private and super spines require upstream instrumentation".into(),
            );
        }
        self.scope(node.span(), false, |emitter| {
            emitter.expression_inner(node, context, pending)
        })
    }

    fn chain_child(
        &mut self,
        node: &Expression<'_>,
        context: Context<'_>,
        pending: &mut Vec<Switch>,
    ) -> Result<String, String> {
        if matches!(node, Expression::ChainExpression(_)) {
            return Err(
                "Parenthesized optional-chain spines require upstream replacement topology".into(),
            );
        }
        if chain_kind(node).is_some() {
            self.expression_deferred(node, context, pending)
        } else {
            self.expression(node, context)
        }
    }

    fn replace_in_chain(
        &self,
        root: &Expression<'_>,
        target: Span,
        kind: Option<ChainKind>,
        text: &str,
    ) -> Result<String, String> {
        let allocator = Allocator::default();
        let replacement = Parser::new(&allocator, text, SourceType::mjs().with_typescript(true))
            .parse_expression()
            .map_err(|error| format!("Invalid native replacement: {error:?}"))?;
        let mut branch = root.clone_in(&allocator);
        let mut visitor = ReplaceExpression {
            target,
            kind: kind.ok_or("Native descendant replacement requires a typed chain target")?,
            replacement: &replacement,
            allocator: &allocator,
            replaced: 0,
        };
        visitor.visit_expression(&mut branch);
        if visitor.replaced != 1 {
            return Err(format!(
                "Native chain replacement matched {} targets instead of one",
                visitor.replaced
            ));
        }
        Ok(self.print(&branch))
    }

    fn method_replacement(&self, call: &CallExpression<'_>) -> Option<String> {
        let (object, name) = method_target(&call.callee)?;
        let replacement = method_mapping(name)?;
        let Some(name) = replacement else {
            return Some(self.print(object));
        };
        let allocator = Allocator::default();
        let mut mutated = call.clone_in(&allocator);
        let optional = match &call.callee {
            Expression::StaticMemberExpression(member) => member.optional,
            Expression::ComputedMemberExpression(member) => member.optional,
            _ => unreachable!("method_target accepts only public members"),
        };
        // Upstream intentionally turns a computed Identifier into a static
        // property on rename, preserving the member and call optional markers.
        let builder = AstBuilder::new(&allocator);
        // Babel constructs a new call for MethodExpression, dropping only
        // this call's type arguments; untouched calls in its spine retain theirs.
        mutated.type_arguments = None;
        mutated.callee = Expression::StaticMemberExpression(StaticMemberExpression::boxed(
            call.callee.span(),
            object.clone_in(&allocator),
            IdentifierName::new(call.callee.span(), name, &builder),
            optional,
            &builder,
        ));
        Some(self.print(&Expression::CallExpression(ArenaBox::new_in(
            mutated, &builder,
        ))))
    }

    fn lvalue(
        &mut self,
        target: &SimpleAssignmentTarget<'_>,
        context: Context<'_>,
        pending: &mut Vec<Switch>,
        placement: TargetPlacement,
    ) -> Result<String, String> {
        if matches!(target, SimpleAssignmentTarget::TSAsExpression(_)) {
            if context.printed_ancestor || placement != TargetPlacement::Assignment {
                return Err("Opaque as targets in updates, iteration, or printed replacements require upstream instrumentation".into());
            }
            return self.skip_ts(target.span());
        }
        self.scope(target.span(), false, |emitter| {
            let start = pending.len();
            let mut edits = vec![];
            let (object, key) = match target {
                SimpleAssignmentTarget::AssignmentTargetIdentifier(_) => return Ok(emitter.text(target.span()).into()),
                SimpleAssignmentTarget::StaticMemberExpression(member) if !member.optional => (&member.object, None),
                SimpleAssignmentTarget::ComputedMemberExpression(member) if !member.optional => (&member.object, Some(&member.expression)),
                SimpleAssignmentTarget::PrivateFieldExpression(member) if !member.optional => (&member.object, None),
                _ => return Err("Destructuring, optional, and typed assignment targets require upstream instrumentation".into()),
            };
            if matches!(object, Expression::Super(_)) {
                return Err("Super assignment targets require upstream instrumentation".into());
            }
            let mut child_context = Context {
                printed_ancestor: context.printed_ancestor || chain_prints(object),
                ..Context::default()
            };
            edits.push((object.span(), emitter.chain_child(object, child_context, pending)?));
            if pending.len() != start {
                if placement != TargetPlacement::Assignment {
                    // Babel attempts a conditional in an update argument or an
                    // iteration target and throws. Preserve it via fallback.
                    return Err("Active update target-object or iteration target-object mutations require upstream placement (invalid conditional lvalue)".into());
                }
                child_context.printed_ancestor = true;
            }
            if let Some(key) = key {
                edits.push((key.span(), emitter.expression(key, child_context)?));
            }
            Ok(emitter.apply(target.span(), edits))
        })
    }

    fn expression_inner(
        &mut self,
        node: &Expression<'_>,
        context: Context<'_>,
        pending: &mut Vec<Switch>,
    ) -> Result<String, String> {
        if context.printed_ancestor
            && matches!(
                node,
                Expression::ArrowFunctionExpression(_)
                    | Expression::FunctionExpression(_)
                    | Expression::ClassExpression(_)
                    | Expression::NewExpression(_)
            )
        {
            return Err(
                "Function, class, and new expressions inside printed mutation replacements require upstream formatting"
                    .into(),
            );
        }
        // Collect before descending: Stryker IDs follow Babel pre-order and the
        // allMutators ordering. Mutation branches use the uninstrumented snapshot.
        let raw_string_rhs = self.single_quoted_logical_rhs(node, context);
        let mut switches = vec![];
        if let Expression::BinaryExpression(binary) = node
            && let Some(replacement) = arithmetic_replacement(binary)
        {
            let text = self.changed(node, |node| {
                if let Expression::BinaryExpression(binary) = node {
                    binary.operator = replacement;
                }
            });
            self.collect(node.span(), text, "ArithmeticOperator", &mut switches);
        }
        if let Expression::ArrayExpression(array) = node {
            self.collect(
                node.span(),
                if array.elements.is_empty() {
                    "[\"Stryker was here\"]"
                } else {
                    "[]"
                }
                .into(),
                "ArrayDeclaration",
                &mut switches,
            );
        }
        if let Expression::CallExpression(call) = node
            && !optional_kind(node)
            && matches!(&call.callee, Expression::Identifier(identifier) if identifier.name == "Array")
        {
            self.collect(
                node.span(),
                if call.arguments.is_empty() {
                    "Array([])"
                } else {
                    "Array()"
                }
                .into(),
                "ArrayDeclaration",
                &mut switches,
            );
        }
        if let Expression::NewExpression(new) = node {
            if matches!(&new.callee, Expression::Identifier(identifier) if identifier.name == "RegExp")
                && matches!(new.arguments.first(), Some(Argument::StringLiteral(_)))
            {
                return Err(
                    "RegExp constructor pattern mutations require upstream instrumentation".into(),
                );
            }
            if matches!(&new.callee, Expression::Identifier(identifier) if identifier.name == "Array")
            {
                self.collect(
                    node.span(),
                    if new.arguments.is_empty() {
                        "new Array([])"
                    } else {
                        "new Array()"
                    }
                    .into(),
                    "ArrayDeclaration",
                    &mut switches,
                );
            }
        }
        if let Expression::CallExpression(call) = node
            && let Some((Expression::Super(_), name)) = method_target(&call.callee)
            && method_mapping(name).is_some()
        {
            return Err("Mapped super calls require upstream placement".into());
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
        let conditionals: &[&str] = if context.loop_test {
            &["false"]
        } else if context.if_test {
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
            let allocator = Allocator::default();
            let mut cloned = node.clone_in(&allocator);
            let Expression::LogicalExpression(cloned_logical) = &mut cloned else {
                unreachable!()
            };
            cloned_logical.operator = replacement;
            // Babel preserves this one validated raw RHS when cloning. Oxc's
            // quote option is safe only for a clone with this sole literal.
            let mut generator =
                Codegen::new()
                    .with_source_text(self.source)
                    .with_options(CodegenOptions {
                        single_quote: raw_string_rhs.is_some(),
                        ..CodegenOptions::default()
                    });
            generator.print_expression(&cloned);
            let text = generator.into_source_text();
            self.collect(node.span(), text, "LogicalOperator", &mut switches);
        }
        if let Expression::CallExpression(call) = node
            && let Some(replacement) = self.method_replacement(call)
        {
            self.collect(node.span(), replacement, "MethodExpression", &mut switches);
        }
        if let Expression::ObjectExpression(object) = node
            && !object.properties.is_empty()
        {
            self.collect(node.span(), "{}".into(), "ObjectLiteral", &mut switches);
        }
        match node {
            Expression::StringLiteral(string) if !context.skip_string => self.collect(
                node.span(),
                if string.value.is_empty() {
                    "\"Stryker was here!\""
                } else {
                    "\"\""
                }
                .into(),
                "StringLiteral",
                &mut switches,
            ),
            Expression::TemplateLiteral(template) => self.collect(
                node.span(),
                if template.quasis.len() == 1 && template.quasis[0].value.raw.is_empty() {
                    "`Stryker was here!`"
                } else {
                    "``"
                }
                .into(),
                "StringLiteral",
                &mut switches,
            ),
            _ => {}
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

        if let Expression::UpdateExpression(_) = node {
            let replacement = self.changed(node, |node| {
                if let Expression::UpdateExpression(update) = node {
                    update.operator = match update.operator {
                        UpdateOperator::Increment => UpdateOperator::Decrement,
                        UpdateOperator::Decrement => UpdateOperator::Increment,
                    };
                }
            });
            self.collect(node.span(), replacement, "UpdateOperator", &mut switches);
        }

        if own_optional(node) {
            let replacement = self.changed(node, |node| match node {
                Expression::CallExpression(call) => {
                    call.optional = false;
                    call.type_arguments = None;
                }
                Expression::StaticMemberExpression(member) => member.optional = false,
                Expression::ComputedMemberExpression(member) => member.optional = false,
                _ => unreachable!("own_optional accepts only calls and public members"),
            });
            self.collect(node.span(), replacement, "OptionalChaining", &mut switches);
        }

        if let Expression::AssignmentExpression(assignment) = node
            && let Some(operator) = assignment_replacement(assignment)
        {
            let replacement = self.changed(node, |node| {
                if let Expression::AssignmentExpression(assignment) = node {
                    assignment.operator = operator;
                }
            });
            self.collect(
                node.span(),
                replacement,
                "AssignmentOperator",
                &mut switches,
            );
        }

        for switch in &mut switches {
            switch.kind = chain_kind(node);
        }
        pending.extend(switches);
        let mut edits = vec![];
        match node {
            Expression::Identifier(_) | Expression::BooleanLiteral(_) | Expression::NullLiteral(_) | Expression::ThisExpression(_) | Expression::Super(_) => {},
            Expression::CallExpression(call) => {
                if call.optional && matches!(method_target(&call.callee), Some((Expression::Super(_), _))) {
                    return Err("Optional super calls require upstream instrumentation".into());
                }
                if let Some(arguments) = &call.type_arguments {
                    if context.printed_ancestor && !arguments.params.iter().all(simple_printed_type) {
                        return Err("Complex call type arguments inside a printed replacement require upstream formatting".into());
                    }
                    self.skip_ts(arguments.span)?;
                }
                let child_context = Context { printed_ancestor: context.printed_ancestor, ..Context::default() };
                edits.push((call.callee.span(), self.chain_child(&call.callee, child_context, pending)?));
                let skip_string = !optional_kind(node) && matches!(&call.callee, Expression::Identifier(identifier) if matches!(identifier.name.as_str(), "require" | "Symbol"));
                for argument in &call.arguments {
                    let argument = argument.as_expression().ok_or("Spread arguments require upstream instrumentation")?;
                    edits.push((argument.span(), self.expression(argument, Context { skip_string, ..child_context })?));
                }
            }
            Expression::NewExpression(new) => {
                // NewExpression is a placement boundary: do not defer callee
                // mutations into `new`, or treat its member callee as a call.
                edits.push((new.callee.span(), self.expression(&new.callee, Context::default())?));
                if let Some(arguments) = &new.type_arguments {
                    self.skip_ts(arguments.span)?;
                }
                for argument in &new.arguments {
                    let argument = argument.as_expression().ok_or("Spread constructor arguments require upstream instrumentation")?;
                    edits.push((argument.span(), self.expression(argument, Context::default())?));
                }
            }
            Expression::FunctionExpression(function) => {
                return self.function(function);
            }
            Expression::ClassExpression(class) => return self.class(class),
            Expression::PrivateFieldExpression(member) => {
                if member.optional {
                    return Err("Optional private members require upstream instrumentation".into());
                }
                edits.push((member.object.span(), self.chain_child(&member.object, Context { printed_ancestor: context.printed_ancestor, ..Context::default() }, pending)?));
            }
            Expression::StaticMemberExpression(member) => {
                edits.push((member.object.span(), self.chain_child(&member.object, Context { printed_ancestor: context.printed_ancestor, ..Context::default() }, pending)?));
            }
            Expression::ComputedMemberExpression(member) => {
                let child_context = Context { printed_ancestor: context.printed_ancestor, ..Context::default() };
                edits.push((member.object.span(), self.chain_child(&member.object, child_context, pending)?));
                edits.push((member.expression.span(), self.expression(&member.expression, child_context)?));
            }
            Expression::TSNonNullExpression(non_null) => {
                edits.push((non_null.expression.span(), self.chain_child(&non_null.expression, Context {
                    printed_ancestor: context.printed_ancestor, ..Context::default()
                }, pending)?));
            }
            Expression::AssignmentExpression(assignment) => {
                let target = assignment.left.as_simple_assignment_target().ok_or("Destructuring assignment targets require upstream instrumentation")?;
                if matches!(target, SimpleAssignmentTarget::TSAsExpression(_)) && !assignment.operator.is_assign() {
                    return Err("Compound as assignment targets require upstream replacement formatting".into());
                }
                let start = pending.len();
                let mut child_context = Context { printed_ancestor: context.printed_ancestor || assignment_replacement(assignment).is_some(), ..Context::default() };
                edits.push((target.span(), self.lvalue(target, child_context, pending, TargetPlacement::Assignment)?));
                child_context.printed_ancestor |= pending.len() != start;
                edits.push((assignment.right.span(), self.expression(&assignment.right, child_context)?));
            }
            Expression::UpdateExpression(update) => {
                edits.push((update.argument.span(), self.lvalue(&update.argument, Context { printed_ancestor: true, ..Context::default() }, pending, TargetPlacement::Update)?));
            }
            Expression::NumericLiteral(_) => {
                // Oxc normalizes some number spellings while Babel preserves raw
                // literals in cloned mutations. Reject incompatible record text.
                if self.print(node) != self.text(node.span()) { return Err("Numeric literal spelling requires upstream replacement formatting".into()); }
            }
            Expression::StringLiteral(_) => {
                // Babel keeps raw string spellings in cloned operator mutants;
                // Oxc prints the decoded value. Standalone switches preserve the
                // original bytes, but printed ancestors need identical spelling.
                if context.printed_ancestor && context.raw_string_rhs != Some(node.span()) && self.print(node) != self.text(node.span()) {
                    return Err("String literal spelling requires upstream replacement formatting".into());
                }
            }
            Expression::TemplateLiteral(template) => {
                if self.printed_statement && template.quasis.iter().any(|quasi| quasi.value.raw.contains(['\r', '\n'])) {
                    return Err("Multiline templates in whole-for replacements require upstream formatting".into());
                }
                for child in &template.expressions {
                    edits.push((child.span(), self.expression(child, Context { printed_ancestor: context.printed_ancestor, ..Context::default() })?));
                }
                if context.printed_ancestor && template.quasis.iter().any(|quasi| quasi.value.raw.contains('\r')) {
                    return Err("Template line endings require upstream replacement formatting".into());
                }
            }
            Expression::ArrayExpression(array) => {
                // Oxc expands arrays with more than two elements over multiple
                // lines; Babel keeps them inline in cloned operator mutants.
                if context.printed_ancestor && array.elements.len() > 2 {
                    return Err("Multiline array printing requires upstream replacement formatting".into());
                }
                for element in &array.elements {
                    let child = element.as_expression().ok_or("Array holes and spread require upstream instrumentation")?;
                    edits.push((child.span(), self.expression(child, Context { printed_ancestor: context.printed_ancestor, ..Context::default() })?));
                }
            }
            Expression::ObjectExpression(object) => {
                if context.printed_ancestor {
                    return Err("Objects inside printed mutation replacements require upstream formatting".into());
                }
                for property in &object.properties {
                    let ObjectPropertyKind::ObjectProperty(property) = property else {
                        return Err("Object spread requires upstream instrumentation".into());
                    };
                    if property.method || property.kind != PropertyKind::Init {
                        return Err("Object methods and accessors require upstream instrumentation".into());
                    }
                    // A mutated computed key is placed at an ancestor by Babel,
                    // rather than at the key itself. Only inert literal keys are
                    // accepted here; their strings are deliberately not mutated.
                    if property.computed && !matches!(property.key, PropertyKey::StringLiteral(_) | PropertyKey::NumericLiteral(_)) {
                        return Err("Computed object keys require upstream placement semantics".into());
                    }
                    edits.push((property.value.span(), self.expression(&property.value, Context::default())?));
                }
            }
            Expression::BinaryExpression(binary) => {
                if !matches!(binary.operator, B::Addition | B::Subtraction | B::Multiplication | B::Division | B::Remainder | B::Equality | B::Inequality | B::StrictEquality | B::StrictInequality | B::LessThan | B::LessEqualThan | B::GreaterThan | B::GreaterEqualThan) { return Err("Unsupported binary operator in native grammar".into()); }
                let printed = context.printed_ancestor || arithmetic_replacement(binary).is_some() || binary.operator.is_equality() || binary.operator.is_compare();
                let child_context = Context { printed_ancestor: printed, ..Context::default() };
                edits.push((binary.left.span(), self.expression(&binary.left, child_context)?));
                edits.push((binary.right.span(), self.expression(&binary.right, child_context)?));
            }
            Expression::LogicalExpression(logical) => {
                let child_context = Context { logical_parent: Some(logical.operator), printed_ancestor: true, ..Context::default() };
                edits.push((logical.left.span(), self.expression(&logical.left, child_context)?));
                edits.push((logical.right.span(), self.expression(&logical.right, Context { raw_string_rhs, ..child_context })?));
            }
            Expression::UnaryExpression(unary) => {
                if unary.operator == U::Delete {
                    if !delete_reference(&unary.argument) {
                        return Err("Only public member delete references have native placement semantics".into());
                    }
                    // Keep the reference intact. Only its callee/object spine
                    // defers to delete; keys and arguments place their own switches.
                    let child_context = Context { printed_ancestor: context.printed_ancestor || chain_prints(&unary.argument), ..Context::default() };
                    edits.push((unary.argument.span(), self.expression_deferred(&unary.argument, child_context, pending)?));
                    return Ok(self.apply(node.span(), edits));
                }
                let printed = context.printed_ancestor || matches!(unary.operator, U::UnaryPlus | U::UnaryNegation | U::LogicalNot | U::BitwiseNot);
                edits.push((unary.argument.span(), self.expression(&unary.argument, Context { printed_ancestor: printed, ..Context::default() })?));
            }
            Expression::ConditionalExpression(conditional) => {
                for child in [&conditional.test, &conditional.consequent, &conditional.alternate] {
                    edits.push((child.span(), self.expression(child, Context { printed_ancestor: context.printed_ancestor, ..Context::default() })?));
                }
            }
            Expression::SequenceExpression(sequence) => {
                for child in &sequence.expressions {
                    edits.push((child.span(), self.expression(child, Context { printed_ancestor: context.printed_ancestor, ..Context::default() })?));
                }
            }
            Expression::ArrowFunctionExpression(arrow) => {
                if arrow.r#async { return Err("Async arrows require upstream instrumentation".into()); }
                if let Some(parameters) = &arrow.type_parameters {
                    self.skip_ts(parameters.span)?;
                }
                edits.extend(self.parameters(&arrow.params, false)?);
                if let Some(returns) = &arrow.return_type {
                    self.skip_ts(returns.span)?;
                }
                match &arrow.body {
                    ArrowFunctionBody::FunctionBody(body) => edits.push((body.span, self.body(body)?)),
                    _ => {
                        let body = arrow.body.as_expression().ok_or("Unsupported arrow body")?;
                        edits.push((body.span(), self.expression(body, Context::default())?));
                    }
                }
            }
            _ => return Err("Unsupported expression in native grammar (import, regex, and type syntax require upstream)".into()),
        }
        Ok(self.apply(node.span(), edits))
    }

    fn parameters(
        &mut self,
        params: &FormalParameters<'_>,
        constructor: bool,
    ) -> Result<Vec<(Span, String)>, String> {
        if params.items.iter().any(|parameter| {
            !matches!(parameter.pattern, BindingPattern::BindingIdentifier(_))
                || (!constructor && is_parameter_property(parameter))
                // Pinned Babel drops standalone override when printing a
                // parameter property. Preserving it would add a runtime
                // assignment after output-only TS transformation.
                || (parameter.r#override
                    && parameter.accessibility.is_none()
                    && !parameter.readonly)
                || !parameter.decorators.is_empty()
        }) || params.rest.as_ref().is_some_and(|rest| {
            !matches!(rest.rest.argument, BindingPattern::BindingIdentifier(_))
                || !rest.decorators.is_empty()
        }) {
            return Err(
                "Only identifier parameters, defaults, and rest are supported natively".into(),
            );
        }
        let mut edits = vec![];
        for parameter in &params.items {
            // Oxc combines Babel's TSParameterProperty, AssignmentPattern and
            // typed Identifier. Enter only those actual Babel node boundaries;
            // FormalParameters itself is not a Babel node.
            let inner = Span::new(parameter.pattern.span().start, parameter.span.end);
            let emit = |emitter: &mut Self| {
                emitter.scope(inner, false, |emitter| {
                    if let Some(annotation) = &parameter.type_annotation {
                        let skip =
                            |emitter: &mut Self| emitter.skip_ts(annotation.span).map(|_| ());
                        if parameter.initializer.is_some() {
                            // Babel's left Identifier includes its annotation;
                            // Oxc's BindingIdentifier span contains only the name.
                            emitter.scope(
                                Span::new(inner.start, annotation.span.end),
                                false,
                                skip,
                            )?;
                        } else {
                            skip(emitter)?;
                        }
                    }
                    parameter
                        .initializer
                        .as_ref()
                        .map(|initializer| {
                            // AssignmentPattern does not preserve inferred names
                            // with the variable-binding wrapper used by arrows.
                            emitter
                                .expression(initializer, Context::default())
                                .map(|output| (initializer.span(), output))
                        })
                        .transpose()
                })
            };
            let edit = if is_parameter_property(parameter) {
                self.scope(parameter.span, false, emit)?
            } else {
                emit(self)?
            };
            if let Some(edit) = edit {
                edits.push(edit);
            }
        }
        if let Some(rest) = &params.rest {
            self.scope(rest.span, false, |emitter| {
                if let Some(annotation) = &rest.type_annotation {
                    emitter.skip_ts(annotation.span)?;
                }
                Ok(())
            })?;
        }
        Ok(edits)
    }

    fn function_edits(
        &mut self,
        function: &Function<'_>,
        suppress_block: bool,
        constructor: bool,
    ) -> Result<Vec<(Span, String)>, String> {
        if function.r#async || function.generator || function.this_param.is_some() {
            return Err(
                "Async, generator, or this-parameter functions require upstream instrumentation"
                    .into(),
            );
        }
        if let Some(parameters) = &function.type_parameters {
            self.skip_ts(parameters.span)?;
        }
        let mut edits = self.parameters(&function.params, constructor)?;
        if let Some(returns) = &function.return_type {
            self.skip_ts(returns.span)?;
        }
        let body = function.body.as_ref().ok_or("Function without body")?;
        if !body.directives.is_empty() {
            return Err("Function directives require upstream instrumentation".into());
        }
        let rendered = self.scope(body.span, false, |emitter| {
            emitter.block_inner(body.span, &body.statements, !suppress_block)
        })?;
        edits.push((body.span, rendered));
        Ok(edits)
    }

    fn function(&mut self, function: &Function<'_>) -> Result<String, String> {
        if function.declare || function.body.is_none() {
            return self.skip_ts(function.span);
        }
        let edits = self.function_edits(function, false, false)?;
        Ok(self.apply(function.span, edits))
    }

    fn class(&mut self, class: &Class<'_>) -> Result<String, String> {
        if self.printed_statement
            || class.r#abstract
            || class.declare
            || !class.decorators.is_empty()
        {
            return Err("Decorated, abstract, ambient, or whole-for classes require upstream instrumentation".into());
        }
        let mut edits = vec![];
        if let Some(parameters) = &class.type_parameters {
            self.skip_ts(parameters.span)?;
        }
        if let Some(heritage) = &class.heritage {
            edits.push((
                heritage.expression.span(),
                self.expression(&heritage.expression, Context::default())?,
            ));
            if let Some(arguments) = &heritage.type_arguments {
                self.skip_ts(arguments.span)?;
            }
        }
        for implements in &class.implements {
            self.scope(implements.span, false, |emitter| {
                if let Some(arguments) = &implements.type_arguments {
                    emitter.skip_ts(arguments.span)?;
                }
                Ok(())
            })?;
        }
        let initialized_public = class.body.body.iter().any(|member| {
            matches!(member, ClassElement::PropertyDefinition(field)
                if !matches!(field.key, PropertyKey::PrivateIdentifier(_)) && field.value.is_some())
        });
        let body = self.scope(class.body.span, false, |emitter| {
            let mut edits = vec![];
            for element in &class.body.body {
            let rendered = emitter.scope(element.span(), true, |emitter| {
                let mut edits = vec![];
                match element {
                    ClassElement::PropertyDefinition(field) => {
                        if !field.decorators.is_empty() || field.declare
                            || field.r#type != PropertyDefinitionType::PropertyDefinition
                        {
                            return Err("Decorated, ambient, or abstract fields require upstream instrumentation".into());
                        }
                        if field.computed {
                            return Err("Computed class field keys require upstream placement".into());
                        }
                        if !matches!(field.key, PropertyKey::StaticIdentifier(_) | PropertyKey::PrivateIdentifier(_) | PropertyKey::StringLiteral(_) | PropertyKey::NumericLiteral(_)) {
                            return Err("Unsupported class field key".into());
                        }
                        // Public quoted keys are deliberately not StringLiteral
                        // mutation sites. Erasable annotations precede values.
                        if let Some(annotation) = &field.type_annotation {
                            emitter.skip_ts(annotation.span)?;
                        }
                        if let Some(value) = &field.value {
                            edits.push((value.span(), emitter.expression(value, Context::default())?));
                        }
                    }
                    ClassElement::MethodDefinition(method) => {
                        if !method.decorators.is_empty() || method.computed
                            || !matches!(method.key, PropertyKey::StaticIdentifier(_))
                            || method.r#type != MethodDefinitionType::MethodDefinition
                            || method.value.declare || method.value.body.is_none()
                        {
                            return Err("Decorated, computed, quoted, private, or ambient methods require upstream instrumentation".into());
                        }
                        let body = method.value.body.as_ref().ok_or("Method without body")?;
                        let constructor = method.kind == MethodDefinitionKind::Constructor;
                        let mut super_call = DirectSuperCall::default();
                        if constructor && (initialized_public || method.value.params.items.iter().any(is_parameter_property)) {
                            super_call.visit_function_body(body);
                        }
                        edits.extend(emitter.function_edits(&method.value, super_call.found, constructor)?);
                    }
                    ClassElement::StaticBlock(block) => {
                        for statement in &block.body {
                            edits.push((statement.span(), emitter.statement(statement, true)?));
                        }
                    }
                    _ => return Err("Auto-accessors and class index signatures require upstream instrumentation".into()),
                }
                Ok(emitter.apply(element.span(), edits))
            })?;
            edits.push((element.span(), rendered));
            }
            Ok(emitter.apply(class.body.span, edits))
        })?;
        edits.push((class.body.span, body));
        Ok(self.apply(class.span, edits))
    }

    fn variables(&mut self, variables: &VariableDeclaration<'_>) -> Result<String, String> {
        if variables.declare {
            return self.skip_ts(variables.span);
        }
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
            if variable.definite {
                return Err("Definite assignment bindings require upstream instrumentation".into());
            }
            if let Some(annotation) = &variable.type_annotation {
                self.skip_ts(annotation.span)?;
            }
            if let Some(initializer) = &variable.init {
                edits.push((
                    initializer.span(),
                    self.scope(variable.span, false, |emitter| {
                        emitter.expression(
                            initializer,
                            Context {
                                binding_name: Some(binding.name.as_str()),
                                ..Context::default()
                            },
                        )
                    })?,
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
        self.scope(span, false, |emitter| {
            emitter.block_inner(span, statements, true)
        })
    }

    fn block_inner(
        &mut self,
        span: Span,
        statements: &[Statement<'_>],
        mutate_block: bool,
    ) -> Result<String, String> {
        let mut switches = vec![];
        if mutate_block && !statements.is_empty() {
            self.collect(span, "{}".into(), "BlockStatement", &mut switches);
        }
        let edits = statements
            .iter()
            .map(|statement| {
                self.statement(statement, true)
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

    fn catch_clause(&mut self, clause: &CatchClause<'_>) -> Result<String, String> {
        self.scope(clause.span, false, |emitter| {
            if let Some(parameter) = &clause.param {
                if !matches!(parameter.pattern, BindingPattern::BindingIdentifier(_)) {
                    return Err(
                        "Destructured catch bindings require upstream instrumentation".into(),
                    );
                }
                // Babel's Identifier includes its annotation. Keep that range
                // boundary and visit the real TS node before the catch body:
                // its skip event affects enclosing statement-call filtering.
                emitter.scope(parameter.span, false, |emitter| {
                    if let Some(annotation) = &parameter.type_annotation {
                        emitter.skip_ts(annotation.span)?;
                    }
                    Ok(())
                })?;
            }
            let body = &clause.body;
            let rendered = emitter.block(body.span, &body.body)?;
            Ok(emitter.apply(clause.span, vec![(body.span, rendered)]))
        })
    }

    fn declaration(&mut self, node: &Declaration<'_>) -> Result<String, String> {
        self.scope(node.span(), false, |emitter| {
            emitter.declaration_inner(node)
        })
    }

    fn declaration_inner(&mut self, node: &Declaration<'_>) -> Result<String, String> {
        match node {
            Declaration::FunctionDeclaration(function) => self.function(function),
            Declaration::ClassDeclaration(class) => self.class(class),
            Declaration::VariableDeclaration(variables) => self.variables(variables),
            Declaration::TSTypeAliasDeclaration(_)
            | Declaration::TSInterfaceDeclaration(_)
            | Declaration::TSEnumDeclaration(_) => self.skip_ts(node.span()),
            Declaration::TSExternalModuleDeclaration(module) if module.declare => {
                self.skip_ts(node.span())
            }
            Declaration::TSNamespaceDeclaration(module) if module.declare => {
                self.skip_ts(node.span())
            }
            Declaration::TSGlobalDeclaration(module) if module.declare => self.skip_ts(node.span()),
            _ => Err("Unsupported exported declaration in native grammar".into()),
        }
    }

    fn for_left(&mut self, node: &ForStatementLeft<'_>) -> Result<String, String> {
        if let ForStatementLeft::VariableDeclaration(variables) = node {
            return self.scope(variables.span, false, |emitter| {
                emitter
                    .variables(variables)
                    .map(|text| text.trim_end_matches(';').into())
            });
        }
        let target = node
            .as_assignment_target()
            .and_then(AssignmentTarget::as_simple_assignment_target)
            .ok_or("Destructuring iteration targets require upstream instrumentation")?;
        self.lvalue(
            target,
            Context::default(),
            &mut vec![],
            TargetPlacement::Iteration,
        )
    }

    fn switch_case(&mut self, node: &SwitchCase<'_>) -> Result<String, String> {
        self.scope(node.span, false, |emitter| {
            let mut switches = vec![];
            if !node.consequent.is_empty() {
                let replacement = match &node.test {
                    // Babel retains the original spelling when cloning a case.
                    Some(Expression::StringLiteral(string)) => format!("case {}:", emitter.text(string.span)),
                    Some(test @ Expression::SequenceExpression(_)) => format!("case ({}):", emitter.print(test)),
                    Some(test) => format!("case {}:", emitter.print(test)),
                    None => "default:".into(),
                };
                emitter.collect(node.span, replacement, "ConditionalExpression", &mut switches);
            }
            let mut edits = vec![];
            if let Some(test) = &node.test {
                edits.push((test.span(), emitter.expression(test, Context {
                    printed_ancestor: !node.consequent.is_empty() && !matches!(test, Expression::StringLiteral(_)),
                    ..Context::default()
                })?));
            }
            let Some(first) = node.consequent.first() else {
                return Ok(emitter.apply(node.span, edits));
            };
            let head = emitter.apply(Span::new(node.span.start, first.span().start), edits);
            let mut edits = vec![];
            for statement in &node.consequent {
                edits.push((statement.span(), emitter.statement(statement, true)?));
            }
            let body = emitter.apply(Span::new(first.span().start, node.span.end), edits);
            Ok(if let Some(switch) = switches.first() {
                format!("{head} if (stryMutAct_9fa48(\"{}\")) {{}} else {{ stryCov_9fa48(\"{}\"); {body} }}", switch.id, switch.id)
            } else { format!("{head}{body}") })
        })
    }

    // Only whole-for clones need statement replacement text. Keep this bounded
    // formatter beside the existing expression printer and apply its same guards
    // to every descendant while traversing the original branch.
    fn print_statement(&self, node: &Statement<'_>) -> Result<String, String> {
        fn indent(text: &str) -> String {
            text.lines()
                .map(|line| format!("  {line}"))
                .collect::<Vec<_>>()
                .join("\n")
        }
        fn ends_in_if(mut node: &Statement<'_>) -> bool {
            loop {
                node = match node {
                    Statement::ForStatement(node) => &node.body,
                    Statement::ForInStatement(node) => &node.body,
                    Statement::ForOfStatement(node) => &node.body,
                    Statement::WhileStatement(node) => &node.body,
                    Statement::DoWhileStatement(node) => &node.body,
                    Statement::LabeledStatement(node) => &node.body,
                    _ => return matches!(node, Statement::IfStatement(_)),
                };
            }
        }
        let expression = |node: &Expression<'_>| self.print(node);
        let variables = |node: &VariableDeclaration<'_>, header: bool| -> Result<String, String> {
            let mut declarations = vec![];
            for declaration in &node.declarations {
                if node.declare || declaration.type_annotation.is_some() || declaration.definite {
                    return Err(
                        "Typed declarations in whole-for replacements require upstream formatting"
                            .into(),
                    );
                }
                let BindingPattern::BindingIdentifier(binding) = &declaration.id else {
                    return Err("Destructuring bindings require upstream instrumentation".into());
                };
                declarations.push(if let Some(init) = &declaration.init {
                    let text = expression(init);
                    let text = if matches!(init, Expression::SequenceExpression(_)) {
                        format!("({text})")
                    } else {
                        text
                    };
                    format!("{} = {text}", binding.name)
                } else {
                    binding.name.to_string()
                });
            }
            Ok(format!(
                "{} {}",
                node.kind.as_str(),
                declarations.join(
                    if !header && node.declarations.iter().any(|node| node.init.is_some()) {
                        ",\n  "
                    } else {
                        ", "
                    }
                )
            ))
        };
        let loop_body = |node: &Statement<'_>, for_parent: bool| -> Result<String, String> {
            let text = match node {
                Statement::VariableDeclaration(node) if for_parent => {
                    format!("{};", variables(node, true)?)
                }
                _ => self.print_statement(node)?,
            };
            Ok(if matches!(node, Statement::EmptyStatement(_)) {
                text
            } else {
                format!(" {text}")
            })
        };
        let for_left = |node: &ForStatementLeft<'_>| -> Result<String, String> {
            if let ForStatementLeft::VariableDeclaration(node) = node {
                variables(node, true)
            } else {
                let mut generator = Codegen::new().with_source_text(self.source);
                node.to_assignment_target()
                    .print(&mut generator, oxc_codegen::Context::empty());
                Ok(generator.into_source_text())
            }
        };
        Ok(match node {
            Statement::BlockStatement(block) => {
                if block.body.is_empty() {
                    "{}".into()
                } else {
                    let body = block
                        .body
                        .iter()
                        .map(|node| self.print_statement(node))
                        .collect::<Result<Vec<_>, _>>()?
                        .join("\n");
                    format!("{{\n{}\n}}", indent(&body))
                }
            }
            Statement::ExpressionStatement(node) => format!("{};", expression(&node.expression)),
            Statement::VariableDeclaration(node) => format!("{};", variables(node, false)?),
            Statement::ReturnStatement(node) => {
                node.argument.as_ref().map_or("return;".into(), |node| {
                    format!("return {};", expression(node))
                })
            }
            Statement::BreakStatement(node) => node
                .label
                .as_ref()
                .map_or("break;".into(), |label| format!("break {};", label.name)),
            Statement::ContinueStatement(node) => {
                node.label.as_ref().map_or("continue;".into(), |label| {
                    format!("continue {};", label.name)
                })
            }
            Statement::EmptyStatement(_) => ";".into(),
            Statement::IfStatement(node) => {
                let mut consequent = self.print_statement(&node.consequent)?;
                if node.alternate.is_some() && ends_in_if(&node.consequent) {
                    consequent = format!("{{\n{}\n}}", indent(&consequent));
                }
                let braced = consequent.ends_with('}');
                let mut result = format!("if ({}) {consequent}", expression(&node.test));
                if let Some(alternate) = &node.alternate {
                    if braced {
                        result.push(' ');
                    }
                    result.push_str(&format!("else {}", self.print_statement(alternate)?));
                }
                result
            }
            Statement::WhileStatement(node) => format!(
                "while ({}){}",
                expression(&node.test),
                loop_body(&node.body, false)?
            ),
            Statement::DoWhileStatement(node) => format!(
                "do {} while ({});",
                self.print_statement(&node.body)?,
                expression(&node.test)
            ),
            Statement::ForStatement(node) => {
                let init = match &node.init {
                    Some(ForStatementInit::VariableDeclaration(node)) => variables(node, true)?,
                    Some(node) => {
                        expression(node.as_expression().ok_or("Unsupported for initializer")?)
                    }
                    None => String::new(),
                };
                let test = node
                    .test
                    .as_ref()
                    .map(|node| format!(" {}", expression(node)))
                    .unwrap_or_default();
                let update = node
                    .update
                    .as_ref()
                    .map(|node| format!(" {}", expression(node)))
                    .unwrap_or_default();
                format!(
                    "for ({init};{test};{update}){}",
                    loop_body(&node.body, true)?
                )
            }
            Statement::ForInStatement(node) => format!(
                "for ({} in {}){}",
                for_left(&node.left)?,
                expression(&node.right),
                loop_body(&node.body, true)?
            ),
            Statement::ForOfStatement(node) => {
                let right = expression(&node.right);
                let right = if matches!(node.right, Expression::SequenceExpression(_)) {
                    format!("({right})")
                } else {
                    right
                };
                format!(
                    "for ({} of {right}){}",
                    for_left(&node.left)?,
                    loop_body(&node.body, true)?
                )
            }
            Statement::LabeledStatement(node) => {
                format!("{}: {}", node.label.name, self.print_statement(&node.body)?)
            }
            Statement::SwitchStatement(node) => {
                let mut cases = vec![];
                for case in &node.cases {
                    let head = case.test.as_ref().map_or("default:".into(), |test| {
                        let text = expression(test);
                        if matches!(test, Expression::SequenceExpression(_)) {
                            format!("case ({text}):")
                        } else {
                            format!("case {text}:")
                        }
                    });
                    let body = case
                        .consequent
                        .iter()
                        .map(|node| self.print_statement(node))
                        .collect::<Result<Vec<_>, _>>()?
                        .join("\n");
                    cases.push(if body.is_empty() {
                        head
                    } else {
                        format!("{head}\n{}", indent(&body))
                    });
                }
                if cases.is_empty() {
                    format!("switch ({}) {{}}", expression(&node.discriminant))
                } else {
                    format!(
                        "switch ({}) {{\n{}\n}}",
                        expression(&node.discriminant),
                        indent(&cases.join("\n"))
                    )
                }
            }
            _ => {
                return Err(
                    "Statement in whole-for replacement requires upstream formatting".into(),
                );
            }
        })
    }

    fn expression_statement(
        &mut self,
        span: Span,
        expression: &Expression<'_>,
        deletion: bool,
        skip_string: bool,
    ) -> Result<String, String> {
        let start = self.records.len();
        let mut switches = vec![];
        if deletion {
            self.collect(span, ";".into(), "CallExpression", &mut switches);
        }
        let own = self.records.get(start).map(|record| record.id.clone());
        let skip_generation = self.ts_skip_generation;
        let original = self.expression(
            expression,
            Context {
                skip_string,
                ..Context::default()
            },
        )?;
        let active = self.records[start..]
            .iter()
            .filter(|record| record.status.is_none())
            .count();
        if self.ts_skip_generation == skip_generation
            && active != 1
            && let Some(id) = own
            && self.records[start].id == id
            && self.records[start].status_reason.is_none()
        {
            self.records.remove(start);
            self.placed -= switches.len();
            switches.clear();
        }
        let original = Self::terminate(self.apply(span, vec![(expression.span(), original)]));
        Ok(if let Some(switch) = switches.first() {
            // Protect generated else from an enclosing unbraced if.
            format!(
                "{{ if (stryMutAct_9fa48(\"{}\")) ; else {{ stryCov_9fa48(\"{}\"); {original} }} }}",
                switch.id, switch.id
            )
        } else {
            original
        })
    }

    fn statement(&mut self, node: &Statement<'_>, statement_list: bool) -> Result<String, String> {
        self.scope(node.span(), true, |emitter| {
            emitter.statement_inner(node, statement_list)
        })
    }

    fn statement_inner(
        &mut self,
        node: &Statement<'_>,
        statement_list: bool,
    ) -> Result<String, String> {
        let mut edits = vec![];
        match node {
            Statement::FunctionDeclaration(function) => {
                if !statement_list { return Err("Unbraced or labelled function declarations require upstream instrumentation".into()); }
                return self.function(function);
            }
            Statement::VariableDeclaration(variables) => return self.variables(variables),
            Statement::ClassDeclaration(class) => return self.class(class),
            Statement::TSTypeAliasDeclaration(_) | Statement::TSInterfaceDeclaration(_) | Statement::TSEnumDeclaration(_) => return self.skip_ts(node.span()),
            Statement::TSExternalModuleDeclaration(module) if module.declare => return self.skip_ts(node.span()),
            Statement::TSNamespaceDeclaration(module) if module.declare => return self.skip_ts(node.span()),
            Statement::TSGlobalDeclaration(module) if module.declare => return self.skip_ts(node.span()),
            Statement::BlockStatement(block) => return self.block(block.span, &block.body),
            Statement::TryStatement(statement) => {
                edits.push((statement.block.span, self.block(statement.block.span, &statement.block.body)?));
                if let Some(handler) = &statement.handler {
                    edits.push((handler.span, self.catch_clause(handler)?));
                }
                if let Some(finalizer) = &statement.finalizer {
                    edits.push((finalizer.span, self.block(finalizer.span, &finalizer.body)?));
                }
            }
            Statement::ReturnStatement(statement) => if let Some(expression) = &statement.argument { edits.push((expression.span(), self.expression(expression, Context::default())?)); },
            Statement::ExpressionStatement(statement) => {
                let deletion = matches!(&statement.expression, Expression::CallExpression(call) if !matches!(call.callee, Expression::Super(_)));
                return self.expression_statement(statement.span, &statement.expression, deletion, true);
            }
            Statement::ThrowStatement(statement) => {
                return self.expression_statement(statement.span, &statement.argument, matches!(statement.argument, Expression::NewExpression(_)), false);
            }
            Statement::IfStatement(statement) => {
                edits.push((statement.test.span(), self.expression(&statement.test, Context { if_test: true, ..Context::default() })?));
                edits.push((statement.consequent.span(), self.statement(&statement.consequent, false)?));
                if let Some(alternate) = &statement.alternate { edits.push((alternate.span(), self.statement(alternate, false)?)); }
            }
            Statement::WhileStatement(statement) => {
                edits.push((statement.test.span(), self.expression(&statement.test, Context { loop_test: true, ..Context::default() })?));
                edits.push((statement.body.span(), self.statement(&statement.body, false)?));
            }
            Statement::DoWhileStatement(statement) => {
                // Babel visits the body before the test, even though the test
                // owns the loop's ConditionalExpression candidate.
                edits.push((statement.body.span(), self.statement(&statement.body, false)?));
                edits.push((statement.test.span(), self.expression(&statement.test, Context { loop_test: true, ..Context::default() })?));
            }
            Statement::ForStatement(statement) => {
                let mut switches = vec![];
                let previous_printed = self.printed_statement;
                if statement.test.is_none() {
                    if self.comment_spans.iter().any(|comment| {
                        statement.span.contains_inclusive(*comment)
                            || (comment.end <= statement.span.start && self.text(Span::new(comment.end, statement.span.start)).trim_matches(js_whitespace).is_empty())
                            || (comment.start >= statement.span.end && self.text(Span::new(statement.span.end, comment.start)).trim_matches(js_whitespace).is_empty())
                    }) {
                        return Err("Comments in or adjacent to whole-for replacements require upstream formatting".into());
                    }
                    let allocator = Allocator::default();
                    let mut replacement = node.clone_in(&allocator);
                    let Statement::ForStatement(replacement_for) = &mut replacement else { unreachable!() };
                    replacement_for.test = Some(Expression::new_boolean_literal(Span::default(), false, &AstBuilder::new(&allocator)));
                    let text = self.print_statement(&replacement)?;
                    self.collect(statement.span, text, "ConditionalExpression", &mut switches);
                    // Wrapping the directly labelled loop in an if makes those
                    // labels cease to denote an iteration statement in upstream.
                    if !switches.is_empty() {
                        let mut invalid = InvalidatedContinue {
                            labels: self.labels.iter().filter(|(span, _)| *span == statement.span).map(|(_, label)| label.as_str()).collect(),
                            found: false,
                        };
                        invalid.visit_statement(&statement.body);
                        if invalid.found { return Err("Labelled continue across a whole-for mutation requires upstream invalid placement".into()); }
                    }
                    self.printed_statement = true;
                }
                if let Some(init) = &statement.init {
                    let text = if let ForStatementInit::VariableDeclaration(variables) = init {
                        self.scope(variables.span, false, |emitter| emitter.variables(variables))?.trim_end_matches(';').into()
                    } else { self.expression(init.as_expression().ok_or("Unsupported for initializer")?, Context::default())? };
                    edits.push((init.span(), text));
                }
                if let Some(test) = &statement.test { edits.push((test.span(), self.expression(test, Context { loop_test: true, ..Context::default() })?)); }
                if let Some(update) = &statement.update { edits.push((update.span(), self.expression(update, Context::default())?)); }
                edits.push((statement.body.span(), self.statement(&statement.body, false)?));
                self.printed_statement = previous_printed;
                let original = self.apply(statement.span, edits);
                return Ok(if let Some(switch) = switches.first() {
                    // The clone is uninstrumented; only the baseline descends.
                    // A block also protects dangling-else and label boundaries.
                    format!("{{ if (stryMutAct_9fa48(\"{}\")) {{ {} }} else {{ stryCov_9fa48(\"{}\"); {original} }} }}", switch.id, switch.replacement, switch.id)
                } else { original });
            }
            Statement::ForInStatement(statement) => {
                edits.push((statement.left.span(), self.for_left(&statement.left)?));
                edits.push((statement.right.span(), self.expression(&statement.right, Context::default())?));
                edits.push((statement.body.span(), self.statement(&statement.body, false)?));
            }
            Statement::ForOfStatement(statement) => {
                if statement.r#await { return Err("for-await requires upstream instrumentation".into()); }
                edits.push((statement.left.span(), self.for_left(&statement.left)?));
                edits.push((statement.right.span(), self.expression(&statement.right, Context::default())?));
                edits.push((statement.body.span(), self.statement(&statement.body, false)?));
            }
            Statement::SwitchStatement(statement) => {
                edits.push((statement.discriminant.span(), self.expression(&statement.discriminant, Context::default())?));
                for case in &statement.cases { edits.push((case.span, self.switch_case(case)?)); }
            }
            Statement::LabeledStatement(statement) => {
                let mut body = &statement.body;
                while let Statement::LabeledStatement(labelled) = body { body = &labelled.body; }
                self.labels.push((body.span(), statement.label.name.to_string()));
                let result = self.statement(&statement.body, false);
                self.labels.pop();
                edits.push((statement.body.span(), result?));
            }
            Statement::BreakStatement(_) | Statement::ContinueStatement(_) => return Ok(Self::terminate(self.text(node.span()).into())),
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
            _ => return Err("Unsupported statement in native grammar (default exports and control-flow extensions require upstream)".into()),
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
            "function f(){ return (obj?.call)(); }",
            "const o = {method(){ return 1; }};",
            "const x = a === 'string';",
            "const x = 1 /* Stryker disable all */ + 2;",
            "function f({x} = obj) { return x; }",
            "const x = (a?.value).next;",
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
            r#"{"files":[{"name":"first.js","mutate":true,"content":"const x=1+2;"},{"name":"second.js","mutate":true,"content":"(call?.())();"}],"options":{}}"#,
        );
        assert!(!response.supported);
        assert!(response.result.is_none());
    }

    #[test]
    fn literal_records_skip_keys_and_keep_nested_preorder() {
        let response = run(
            "const value = { 'key': ['', `x${1+2}`], empty: {} }; 'skip';",
            serde_json::json!({"noHeader": true}),
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
                ("0", "ObjectLiteral", "{}"),
                ("1", "ArrayDeclaration", "[]"),
                ("2", "StringLiteral", "\"Stryker was here!\""),
                ("3", "StringLiteral", "``"),
                ("4", "ArithmeticOperator", "1 - 2"),
            ]
        );
        let output = &result.files[0].content;
        assert!(!output.contains("function stryNS_9fa48"));
        assert!(output.contains("stryMutAct_9fa48(\"0\")"));
        assert!(output.contains("stryCov_9fa48(\"4\")"));
        assert!(output.contains("'key':"));
        assert!(output.ends_with("'skip';"));
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

    #[test]
    fn call_filter_keeps_monotonic_batch_ids_and_no_removed_switches() {
        let response = instrument_batch(
            r#"{"files":[{"name":"a.js","mutate":true,"content":"foo(1+2);"},{"name":"b.js","mutate":true,"content":"bar(); Array();"}]}"#,
        );
        assert!(response.supported);
        let result = response.result.unwrap();
        assert_eq!(
            result
                .mutants
                .iter()
                .map(|m| (m.id.as_str(), m.mutator_name, m.replacement.as_str()))
                .collect::<Vec<_>>(),
            vec![
                ("1", "ArithmeticOperator", "1 - 2"),
                ("2", "CallExpression", ";"),
                ("4", "ArrayDeclaration", "Array([])"),
            ]
        );
        assert!(!result.files[0].content.contains("stryMutAct_9fa48(\"0\")"));
        assert!(!result.files[1].content.contains("stryMutAct_9fa48(\"3\")"));
    }

    #[test]
    fn optional_chain_wrapper_collects_the_effective_if_test_once() {
        let response = run("if (obj?.trim?.().length) ;", Value::Null);
        assert!(response.supported, "{:?}", response.reason);
        let result = response.result.unwrap();
        assert_eq!(
            result
                .mutants
                .iter()
                .map(|m| (m.id.as_str(), m.mutator_name, m.replacement.as_str()))
                .collect::<Vec<_>>(),
            vec![
                ("0", "ConditionalExpression", "true"),
                ("1", "ConditionalExpression", "false"),
                ("2", "MethodExpression", "obj"),
                ("3", "OptionalChaining", "obj?.trim()"),
                ("4", "OptionalChaining", "obj.trim"),
            ]
        );
        assert!(
            result.files[0]
                .content
                .contains("stryCov_9fa48(\"0\", \"1\", \"2\", \"3\", \"4\")")
        );
    }

    #[test]
    fn interior_optional_replacement_preserves_the_continuous_chain() {
        let response = run("const x = obj?.endsWith(\"x\").length;", Value::Null);
        assert!(response.supported, "{:?}", response.reason);
        let result = response.result.unwrap();
        assert_eq!(result.mutants.len(), 3);
        assert_eq!(result.mutants[0].replacement, "obj?.startsWith(\"x\")");
        assert!(
            result.files[0]
                .content
                .contains("? (obj?.startsWith(\"x\").length)")
        );
        assert!(
            !result.files[0]
                .content
                .contains("(obj?.startsWith(\"x\")).length")
        );
        assert_eq!(result.mutants[1].replacement, "obj.endsWith");
        assert_eq!(result.mutants[2].mutator_name, "StringLiteral");
    }

    #[test]
    fn chain_mutation_keeps_target_metadata_and_uninstrumented_ancestor_branch() {
        let response = run("const x = obj.trim(a + b).length;", Value::Null);
        assert!(response.supported);
        let result = response.result.unwrap();
        assert_eq!(result.mutants[0].mutator_name, "MethodExpression");
        assert_eq!(result.mutants[0].replacement, "obj");
        assert_eq!(result.mutants[0].location.start.column, 10);
        assert_eq!(result.mutants[0].location.end.column, 25);
        assert!(result.files[0].content.contains("? (obj.length)"));
        assert!(
            result.files[0]
                .content
                .contains("obj.trim((stryMutAct_9fa48(\"1\")")
        );
    }

    #[test]
    fn assignments_lift_only_target_spine_switches_and_keep_child_preorder() {
        let response = run(
            "factory().trim().field += rhs?.value; obj[key.trim()] += x++;",
            Value::Null,
        );
        assert!(response.supported, "{:?}", response.reason);
        let result = response.result.unwrap();
        assert_eq!(
            result
                .mutants
                .iter()
                .map(|m| (m.id.as_str(), m.mutator_name, m.replacement.as_str()))
                .collect::<Vec<_>>(),
            vec![
                (
                    "0",
                    "AssignmentOperator",
                    "factory().trim().field -= rhs?.value"
                ),
                ("1", "MethodExpression", "factory()"),
                ("2", "OptionalChaining", "rhs.value"),
                ("3", "AssignmentOperator", "obj[key.trim()] -= x++"),
                ("4", "MethodExpression", "key"),
                ("5", "UpdateOperator", "x--"),
            ]
        );
        let output = &result.files[0].content;
        assert!(output.contains("? (factory().field += rhs?.value)"));
        assert!(output.contains("stryCov_9fa48(\"0\", \"1\")"));
        assert!(output.contains("stryCov_9fa48(\"2\")"));
        assert!(output.contains("obj[(stryMutAct_9fa48(\"4\")"));
    }

    #[test]
    fn update_target_spines_reject_only_active_pending_mutations() {
        let source = "factory().trim().field++;";
        let rejected = run(source, Value::Null);
        assert!(!rejected.supported);
        assert!(rejected.result.is_none());
        assert!(rejected.reason.unwrap().contains("update target-object"));

        let ignored = run(
            source,
            serde_json::json!({"excludedMutations": ["MethodExpression"]}),
        );
        assert!(ignored.supported, "{:?}", ignored.reason);
        let result = ignored.result.unwrap();
        assert_eq!(result.mutants[0].replacement, "factory().trim().field--");
        assert_eq!(result.mutants[1].status, Some("Ignored"));
        assert!(!result.files[0].content.contains("stryMutAct_9fa48(\"1\")"));
        for source in [
            "factory().field++;",
            "obj[key.trim()]++;",
            "++obj[index++];",
        ] {
            let accepted = run(source, Value::Null);
            assert!(accepted.supported, "{source}: {:?}", accepted.reason);
        }
    }

    #[test]
    fn assignment_and_update_printer_guards_follow_serialized_ancestors() {
        for source in [
            "a += 'raw';", // No assignment candidate: only the string is printed.
            "a = x => x;",
            "obj.x = {key: 1};",
        ] {
            let response = run(source, Value::Null);
            assert!(response.supported, "{source}: {:?}", response.reason);
        }
        for source in [
            "obj['raw']++;",
            "a += ('raw' + b);",
            "factory().trim().field = 'raw';",
            "factory().trim().field = x => x;",
            "a += {key: 1};",
            "[a] = b;",
            "([a] = b, c++);",
        ] {
            let response = run(source, Value::Null);
            assert!(!response.supported, "{source}");
            assert!(response.result.is_none());
        }
    }

    #[test]
    fn non_null_chain_replacement_uses_effective_kind_and_visits_alias_once() {
        for source in ["obj!", "obj?.x!"] {
            let allocator = Allocator::default();
            let mut root = Parser::new(&allocator, source, SourceType::mjs().with_typescript(true))
                .parse_expression()
                .unwrap();
            let replacement = Parser::new(&allocator, "obj", SourceType::mjs())
                .parse_expression()
                .unwrap();
            let mut visitor = ReplaceExpression {
                target: root.span(),
                kind: ChainKind::Call,
                replacement: &replacement,
                allocator: &allocator,
                replaced: 0,
            };
            visitor.visit_expression(&mut root);
            assert_eq!(visitor.replaced, 0, "span alone must not match {source}");
            visitor.kind = ChainKind::NonNull;
            visitor.visit_expression(&mut root);
            assert_eq!(
                visitor.replaced, 1,
                "wrapper aliases must enter once: {source}"
            );
            assert!(matches!(root, Expression::Identifier(_)));
        }
    }

    #[test]
    fn typed_chain_replacement_rejects_missing_or_ambiguous_target_identity() {
        let allocator = Allocator::default();
        let mut root = Parser::new(&allocator, "obj.trim() + obj.trim()", SourceType::mjs())
            .parse_expression()
            .unwrap();
        let Expression::BinaryExpression(binary) = &mut root else {
            unreachable!()
        };
        let target = binary.left.span();
        // Deliberately alias the source span to exercise exact-one validation.
        let Expression::CallExpression(right) = &mut binary.right else {
            unreachable!()
        };
        right.span = target;
        let replacement = Parser::new(&allocator, "obj", SourceType::mjs())
            .parse_expression()
            .unwrap();
        let mut visitor = ReplaceExpression {
            target,
            kind: ChainKind::Call,
            replacement: &replacement,
            allocator: &allocator,
            replaced: 0,
        };
        visitor.visit_expression(&mut root);
        assert_eq!(visitor.replaced, 2);
        visitor.target = Span::new(100, 101);
        visitor.replaced = 0;
        visitor.visit_expression(&mut root);
        assert_eq!(visitor.replaced, 0);
    }
}
