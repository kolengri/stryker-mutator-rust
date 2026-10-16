//! Conservative native instrumentation, distinct from the broader candidate preview.
//!
//! Every accepted node has complete mutation/placement semantics for the supported
//! grammar. An unsupported node/options value rejects the entire batch. This is
//! essential: silently omitting one mutant would change mutation scores.

use std::collections::{HashMap, HashSet};

use oxc_allocator::{Allocator, CloneIn};
use oxc_ast::ast::*;
use oxc_ast_visit::{Visit, VisitMut, walk, walk_mut};
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
// Program/BlockStatement statement lists are proven here. Unowned closing/EOF
// comments are preserved but do not create rules.
#[derive(Default)]
struct CommentBoundaries {
    gaps: Vec<(Span, Option<u32>)>,
}

impl CommentBoundaries {
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
        source: &str,
    ) -> Result<HashMap<u32, Vec<Directive>>, String> {
        let mut boundaries = Self::default();
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

impl<'a> Visit<'a> for CommentBoundaries {
    fn visit_program(&mut self, node: &Program<'a>) {
        self.list(node.span.start, node.span.end, &node.body);
        walk::walk_program(self, node);
    }

    fn visit_block_statement(&mut self, node: &BlockStatement<'a>) {
        self.list(node.span.start + 1, node.span.end - 1, &node.body);
        walk::walk_block_statement(self, node);
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
            let mut records = vec![];
            let mut next_id = 0;
            let mut files = Vec::with_capacity(input.files.len());
            for file in input.files {
                let content = instrument_file(&file, &options, &mut records, &mut next_id)
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
    next_id: &mut usize,
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
        selection: &file.mutate,
        pruned: false,
        directives,
        rules: vec![],
        records,
        next_id,
        placed: 0,
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
    skip_string: bool,
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

// Literal upstream mapping plus its generated reverse entries. setUTCDate
// deliberately does not overwrite the reverse setTime -> setDate entry.
fn method_mapping(name: &str) -> Option<Option<&'static str>> {
    Some(match name {
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
        "setDate" | "setUTCDate" => Some("setTime"),
        "setTime" => Some("setDate"),
        "setFullYear" => Some("setMonth"),
        "setMonth" => Some("setFullYear"),
        "setHours" => Some("setMinutes"),
        "setMinutes" => Some("setHours"),
        "setSeconds" => Some("setMilliseconds"),
        "setMilliseconds" => Some("setSeconds"),
        "setUTCFullYear" => Some("setUTCMonth"),
        "setUTCMonth" => Some("setUTCFullYear"),
        "setUTCHours" => Some("setUTCMinutes"),
        "setUTCMinutes" => Some("setUTCHours"),
        "setUTCSeconds" => Some("setUTCMilliseconds"),
        "setUTCMilliseconds" => Some("setUTCSeconds"),
        _ => return None,
    })
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

fn is_chain_node(node: &Expression<'_>) -> bool {
    matches!(
        node,
        Expression::CallExpression(_)
            | Expression::StaticMemberExpression(_)
            | Expression::ComputedMemberExpression(_)
    )
}

fn chain_prints(node: &Expression<'_>) -> bool {
    match node {
        Expression::CallExpression(call) => {
            matches!(&call.callee, Expression::Identifier(identifier) if identifier.name == "Array")
                || method_target(&call.callee)
                    .is_some_and(|(_, name)| method_mapping(name).is_some())
                || chain_prints(&call.callee)
        }
        Expression::StaticMemberExpression(member) => chain_prints(&member.object),
        Expression::ComputedMemberExpression(member) => chain_prints(&member.object),
        _ => false,
    }
}

// Replace a cloned AST node, never splice unprotected text into a callee. The
// generator restores precedence for the mutated ancestor's entire chain.
struct ReplaceExpression<'a, 'b> {
    target: Span,
    replacement: &'b Expression<'a>,
    allocator: &'a Allocator,
}

impl<'a> VisitMut<'a> for ReplaceExpression<'a, '_> {
    fn visit_expression(&mut self, node: &mut Expression<'a>) {
        if node.span() == self.target {
            *node = self.replacement.clone_in(self.allocator);
        } else {
            walk_mut::walk_expression(self, node);
        }
    }
}

struct Switch {
    target: Span,
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
}

impl Emitter<'_, '_> {
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
        // Only call/member nodes on a callee/object spine defer placement. Keys
        // and arguments keep independent placements in the original branch.
        context.printed_ancestor |= chain_prints(node);
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
            let replacement = if switch.target == node.span() {
                switch.replacement
            } else {
                self.replace_in_chain(node, switch.target, &switch.replacement)?
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
        if is_chain_node(node) {
            self.expression_deferred(node, context, pending)
        } else {
            self.expression(node, context)
        }
    }

    fn replace_in_chain(
        &self,
        root: &Expression<'_>,
        target: Span,
        text: &str,
    ) -> Result<String, String> {
        let allocator = Allocator::default();
        let replacement = Parser::new(&allocator, text, SourceType::mjs())
            .parse_expression()
            .map_err(|error| format!("Invalid native replacement: {error:?}"))?;
        let mut branch = root.clone_in(&allocator);
        ReplaceExpression {
            target,
            replacement: &replacement,
            allocator: &allocator,
        }
        .visit_expression(&mut branch);
        Ok(self.print(&branch))
    }

    fn method_replacement(&self, call: &CallExpression<'_>) -> Result<Option<String>, String> {
        let Some((object, name)) = method_target(&call.callee) else {
            return Ok(None);
        };
        let Some(replacement) = method_mapping(name) else {
            return Ok(None);
        };
        let Some(name) = replacement else {
            return Ok(Some(self.print(object)));
        };
        let arguments = call
            .arguments
            .iter()
            .map(|argument| {
                argument
                    .as_expression()
                    .map(|expression| self.print(expression))
                    .ok_or("Spread arguments require upstream instrumentation")
            })
            .collect::<Result<Vec<_>, _>>()?
            .join(", ");
        let text = format!("({}).{name}({arguments})", self.print(object));
        let allocator = Allocator::default();
        let expression = Parser::new(&allocator, &text, SourceType::mjs())
            .parse_expression()
            .map_err(|error| format!("Invalid method replacement: {error:?}"))?;
        Ok(Some(self.print(&expression)))
    }

    fn expression_inner(
        &mut self,
        node: &Expression<'_>,
        context: Context<'_>,
        pending: &mut Vec<Switch>,
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
        if let Expression::CallExpression(call) = node
            && let Some(replacement) = self.method_replacement(call)?
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

        pending.extend(switches);
        let mut edits = vec![];
        match node {
            Expression::Identifier(_) | Expression::BooleanLiteral(_) | Expression::NullLiteral(_) | Expression::ThisExpression(_) => {},
            Expression::CallExpression(call) => {
                if call.optional || call.type_arguments.is_some() { return Err("Optional or typed calls require upstream instrumentation".into()); }
                let child_context = Context { printed_ancestor: context.printed_ancestor, ..Context::default() };
                edits.push((call.callee.span(), self.chain_child(&call.callee, child_context, pending)?));
                let skip_string = matches!(&call.callee, Expression::Identifier(identifier) if matches!(identifier.name.as_str(), "require" | "Symbol"));
                for argument in &call.arguments {
                    let argument = argument.as_expression().ok_or("Spread arguments require upstream instrumentation")?;
                    edits.push((argument.span(), self.expression(argument, Context { skip_string, ..child_context })?));
                }
            }
            Expression::StaticMemberExpression(member) => {
                if member.optional { return Err("Optional members require upstream instrumentation".into()); }
                edits.push((member.object.span(), self.chain_child(&member.object, Context { printed_ancestor: context.printed_ancestor, ..Context::default() }, pending)?));
            }
            Expression::ComputedMemberExpression(member) => {
                if member.optional { return Err("Optional members require upstream instrumentation".into()); }
                let child_context = Context { printed_ancestor: context.printed_ancestor, ..Context::default() };
                edits.push((member.object.span(), self.chain_child(&member.object, child_context, pending)?));
                edits.push((member.expression.span(), self.expression(&member.expression, child_context)?));
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
                if context.printed_ancestor && self.print(node) != self.text(node.span()) {
                    return Err("String literal spelling requires upstream replacement formatting".into());
                }
            }
            Expression::TemplateLiteral(template) => {
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
            _ => return Err("Unsupported expression in native grammar (optional chains, private members, new, import, regex, classes, assignments, updates, and type syntax require upstream)".into()),
        }
        Ok(self.apply(node.span(), edits))
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
        self.scope(span, false, |emitter| emitter.block_inner(span, statements))
    }

    fn block_inner(&mut self, span: Span, statements: &[Statement<'_>]) -> Result<String, String> {
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
        self.scope(node.span(), false, |emitter| {
            emitter.declaration_inner(node)
        })
    }

    fn declaration_inner(&mut self, node: &Declaration<'_>) -> Result<String, String> {
        match node {
            Declaration::FunctionDeclaration(function) => self.function(function),
            Declaration::VariableDeclaration(variables) => self.variables(variables),
            _ => Err("Unsupported exported declaration in native grammar".into()),
        }
    }

    fn statement(&mut self, node: &Statement<'_>, top_level: bool) -> Result<String, String> {
        self.scope(node.span(), true, |emitter| {
            emitter.statement_inner(node, top_level)
        })
    }

    fn statement_inner(&mut self, node: &Statement<'_>, top_level: bool) -> Result<String, String> {
        let mut edits = vec![];
        match node {
            Statement::FunctionDeclaration(function) => {
                if !top_level { return Err("Nested function declarations require upstream hoisting semantics".into()); }
                return self.function(function);
            }
            Statement::VariableDeclaration(variables) => return self.variables(variables),
            Statement::BlockStatement(block) => return self.block(block.span, &block.body),
            Statement::ReturnStatement(statement) => if let Some(expression) = &statement.argument { edits.push((expression.span(), self.expression(expression, Context::default())?)); },
            Statement::ExpressionStatement(statement) => {
                let start = self.records.len();
                let mut switches = vec![];
                if matches!(statement.expression, Expression::CallExpression(_)) {
                    self.collect(statement.span, ";".into(), "CallExpression", &mut switches);
                }
                let own = self.records.get(start).filter(|record| record.mutator_name == "CallExpression").map(|record| record.id.clone());
                let original = self.expression(&statement.expression, Context { skip_string: true, ..Context::default() })?;
                let active = self.records[start..].iter().filter(|record| record.status.is_none()).count();
                if active != 1 && let Some(id) = own
                    && self.records[start].id == id && self.records[start].status_reason.is_none()
                {
                    self.records.remove(start);
                    self.placed -= switches.len();
                    switches.clear();
                }
                let original = Self::terminate(self.apply(statement.span, vec![(statement.expression.span(), original)]));
                return Ok(if let Some(switch) = switches.first() {
                    // A block protects both the original and generated else from
                    // binding to an enclosing unbraced if.
                    format!("{{ if (stryMutAct_9fa48(\"{}\")) ; else {{ stryCov_9fa48(\"{}\"); {original} }} }}", switch.id, switch.id)
                } else { original });
            },
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
            "function f(){ return call?.(); }",
            "const o = {method(){ return 1; }};",
            "const x = a === 'string';",
            "const x = 1 /* Stryker disable all */ + 2;",
            "function f(x = 1) { return x; }",
            "const x = a?.value;",
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
            r#"{"files":[{"name":"first.js","mutate":true,"content":"const x=1+2;"},{"name":"second.js","mutate":true,"content":"call?.();"}],"options":{}}"#,
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
}
