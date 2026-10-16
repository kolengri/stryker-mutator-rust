//! Bounded Svelte containers. The pinned parser proves node kinds and original
//! byte boundaries; it does not establish compiler equivalence on its own.
//! Only ranges cross into our Oxc 0.154 engine. The parser's Oxc 0.149 AST never
//! does, and deferred scripts are parsed exactly once by the existing engine.

use std::{collections::HashSet, ops::Range};

use oxc_ast::ast::{BindingIdentifier, IdentifierReference, Statement};
use oxc_ast_visit::{Visit, walk};
use rsvelte_core::{Allocator, ParseOptions, ast::*, parse, resolve_lazy_expressions};

use super::{ApiMutant, File, HEADER, Options, Positions, SourceType, instrument_program_inner};

const UNSUPPORTED: &str = "Svelte syntax requires upstream compiler equivalence";

pub(super) fn instrument(
    file: &File,
    options: &Options,
    records: &mut Vec<ApiMutant>,
    next_id: &mut usize,
) -> Result<String, String> {
    let scripts = script_ranges(&file.content)?;
    let mut state = ScriptState::default();
    let mut replacements = Vec::new();
    // Module first; every other script/expression follows original source order.
    let mut parts: Vec<_> = scripts
        .instance
        .iter()
        .chain(scripts.nested.iter())
        .map(|range| (range, false))
        .chain(scripts.expressions.iter().map(|range| (range, true)))
        .collect();
    parts.sort_unstable_by_key(|(range, _)| range.start);
    for (range, expression) in scripts
        .module
        .iter()
        .map(|range| (range, false))
        .chain(parts)
    {
        let document = scripts.nested.contains(range);
        let mut document_state = ScriptState {
            document: true,
            ..ScriptState::default()
        };
        let current = if document {
            &mut document_state
        } else {
            &mut state
        };
        current.module = scripts.module.as_ref() == Some(range);
        current.expression = expression;
        let typescript = if expression {
            !scripts.typescript.is_empty()
        } else {
            scripts.typescript.contains(&range.start)
        };
        let printed = instrument_program_inner(
            file,
            &file.content[range.clone()],
            SourceType::mjs().with_typescript(typescript),
            Positions::new(&file.content).at(range.start as u32),
            &Options {
                no_header: !document,
                excluded: options.excluded.clone(),
            },
            records,
            next_id,
            None,
            !expression,
            Some(current),
        )?;
        let printed = if expression {
            printed.strip_suffix(';').unwrap_or(&printed).to_owned()
        } else {
            printed
        };
        replacements.push((range, printed, expression));
    }
    // A document script owns its header and never captures component constants.
    // Component placements share one lexical module header, including noHeader.
    if state.needed && scripts.module.is_some() {
        replacements[0].1.insert_str(0, HEADER);
    }
    replacements.sort_unstable_by_key(|(range, _, _)| range.start);
    let mut output = String::new();
    if state.needed && scripts.module.is_none() {
        output.push_str("<script context=\"module\">\n");
        output.push_str(HEADER);
        output.push_str("\n</script>\n");
    }
    let mut cursor = 0;
    for (range, printed, expression) in replacements {
        output.push_str(&file.content[cursor..range.start]);
        if !expression {
            output.push('\n');
        }
        output.push_str(&printed);
        if !expression {
            output.push('\n');
        }
        cursor = range.end;
    }
    output.push_str(&file.content[cursor..]);
    Ok(output)
}

#[derive(Default)]
pub(super) struct ScriptState {
    pub(super) needed: bool,
    pub(super) module: bool,
    pub(super) document: bool,
    pub(super) expression: bool,
    pub(super) module_constants: HashSet<String>,
}

struct Scripts {
    module: Option<Range<usize>>,
    instance: Option<Range<usize>>,
    nested: Vec<Range<usize>>,
    expressions: Vec<Range<usize>>,
    typescript: HashSet<usize>,
}

fn script_ranges(source: &str) -> Result<Scripts, String> {
    if source.len() > u32::MAX as usize || source.contains('\u{feff}') {
        return Err(UNSUPPORTED.into());
    }
    let allocator = Allocator::default();
    let mut root = parse(
        source,
        &allocator,
        ParseOptions {
            modern: true,
            defer_script_parse: true,
            ..ParseOptions::default()
        },
    )
    .map_err(|_| UNSUPPORTED)?;
    if root.css.is_some()
        || root.options.is_some()
        || !root.parse_warnings.is_empty()
        || !root.unclosed_ancestors.is_empty()
    {
        return Err(UNSUPPORTED.into());
    }
    if resolve_lazy_expressions(&mut root, source).is_some() {
        return Err(UNSUPPORTED.into());
    }
    let module = root
        .module
        .as_ref()
        .map(|script| prove_script(source, script, true))
        .transpose()?;
    let instance = root
        .instance
        .as_ref()
        .map(|script| prove_script(source, script, false))
        .transpose()?;
    let mut proof = TemplateProof {
        source,
        nested: vec![],
        expressions: vec![],
        names: vec![],
        typescript: HashSet::new(),
    };
    for script in root.module.iter().chain(root.instance.iter()) {
        if script.is_typescript {
            proof.typescript.insert(script.content_offset as usize);
        }
    }
    let mut items: Vec<_> = root
        .fragment
        .nodes
        .iter()
        .map(|node| {
            let (start, end) = node.span();
            (start as usize, end as usize, Some(node))
        })
        .collect();
    for script in root.module.iter().chain(root.instance.iter()) {
        items.push((script.start as usize, script.end as usize, None));
    }
    items.sort_unstable_by_key(|item| item.0);
    let mut cursor = 0;
    for (start, end, node) in items {
        if start < cursor
            || end < start
            || !whitespace(source.get(cursor..start).ok_or(UNSUPPORTED)?)
        {
            return Err(UNSUPPORTED.into());
        }
        if let Some(node) = node {
            proof.node(node, 0)?;
        }
        cursor = end;
    }
    if !whitespace(source.get(cursor..).ok_or(UNSUPPORTED)?) {
        return Err(UNSUPPORTED.into());
    }
    let script_count =
        usize::from(module.is_some()) + usize::from(instance.is_some()) + proof.nested.len();
    if script_count == 0
        || proof
            .names
            .iter()
            .any(|name| (0..script_count).any(|index| name == &format!("script{index}")))
    {
        return Err(UNSUPPORTED.into());
    }
    Ok(Scripts {
        module,
        instance,
        nested: proof.nested,
        expressions: proof.expressions,
        typescript: proof.typescript,
    })
}

fn whitespace(text: &str) -> bool {
    text.chars().all(super::js_whitespace)
}

fn prove_script(source: &str, script: &Script<'_>, module: bool) -> Result<Range<usize>, String> {
    let range =
        script.content_offset as usize..script.content_offset as usize + script.raw_content.len();
    let opening = match (module, script.is_typescript) {
        (false, false) => "<script>",
        (true, false) => "<script context=\"module\">",
        (false, true) => "<script lang=\"ts\">",
        (true, true) => "<script lang=\"ts\" context=\"module\">",
    };
    // Canonical complete delimiters AND the parser's context must agree.
    if script.context
        != if module {
            ScriptContext::Module
        } else {
            ScriptContext::Default
        }
        || source.get(script.start as usize..range.start) != Some(opening)
        || source.get(range.clone()) != Some(script.raw_content)
        || source.get(range.end..script.end as usize) != Some("</script>")
    {
        return Err(UNSUPPORTED.into());
    }
    Ok(range)
}

struct TemplateProof<'s> {
    source: &'s str,
    nested: Vec<Range<usize>>,
    expressions: Vec<Range<usize>>,
    names: Vec<String>,
    typescript: HashSet<usize>,
}

impl TemplateProof<'_> {
    fn node(&mut self, node: &TemplateNode<'_>, depth: usize) -> Result<(), String> {
        if depth > 128 {
            return Err(UNSUPPORTED.into());
        }
        let source = self.source;
        let (start, end) = node.span();
        let raw = source
            .get(start as usize..end as usize)
            .ok_or(UNSUPPORTED)?;
        match node {
            TemplateNode::Text(text)
                if raw == text.raw && raw == text.data && !raw.contains(['&', '<', '{']) =>
            {
                Ok(())
            }
            TemplateNode::ExpressionTag(tag) => {
                // Bare identifiers and ordinary calls are the compiler-qualified
                // template slice. Other root expressions remain atomic fallback.
                if !matches!(
                    tag.expression.node_type(),
                    Some("Identifier" | "CallExpression")
                ) {
                    return Err(UNSUPPORTED.into());
                }
                let name = tag.expression.identifier_name();
                let start = tag.expression.start().ok_or(UNSUPPORTED)? as usize;
                let end = tag.expression.end().ok_or(UNSUPPORTED)? as usize;
                // Upstream remaps actual scriptN placeholders even inside bare
                // identifier mustaches. Validate against the final script count.
                if name.is_some_and(forbidden_identifier)
                    || name.is_some_and(|name| source.get(start..end) != Some(name))
                    || source
                        .get(tag.start as usize..start)
                        .and_then(|s| s.strip_prefix('{'))
                        .is_none_or(|s| !s.chars().all(super::js_whitespace))
                    || source
                        .get(end..tag.end as usize)
                        .and_then(|s| s.strip_suffix('}'))
                        .is_none_or(|s| !s.chars().all(super::js_whitespace))
                {
                    return Err(UNSUPPORTED.into());
                }
                if let Some(name) = name {
                    self.names.push(name.to_owned());
                }
                self.expressions.push(start..end);
                Ok(())
            }
            TemplateNode::RegularElement(element) if element.name == "script" && depth > 0 => {
                let typed = raw.starts_with("<script lang=\"ts\">");
                let opening = if typed {
                    "<script lang=\"ts\">"
                } else {
                    "<script>"
                };
                let start = element.start as usize + opening.len();
                let end = (element.end as usize)
                    .checked_sub("</script>".len())
                    .ok_or(UNSUPPORTED)?;
                if source.get(element.start as usize..start) != Some(opening)
                    || source.get(end..element.end as usize) != Some("</script>")
                    || start > end
                {
                    return Err(UNSUPPORTED.into());
                }
                // Raw-text must occupy the ENTIRE content span, with no recovered
                // children or HTML decoding. Empty scripts have no text child.
                match element.fragment.nodes.as_slice() {
                    [] if start == end => {}
                    [TemplateNode::Text(text)]
                        if text.start as usize == start
                            && text.end as usize == end
                            && source.get(start..end) == Some(&*text.raw)
                            && text.raw == text.data => {}
                    _ => return Err(UNSUPPORTED.into()),
                }
                self.nested.push(start..end);
                if typed {
                    self.typescript.insert(start);
                }
                Ok(())
            }
            TemplateNode::RegularElement(element) => {
                // Exclude raw-text, void, foreign, custom and special elements. This
                // deliberately small ordinary set has no compiler-specific modes.
                if !matches!(
                    element.name.as_str(),
                    "div"
                        | "span"
                        | "p"
                        | "h1"
                        | "h2"
                        | "h3"
                        | "h4"
                        | "h5"
                        | "h6"
                        | "section"
                        | "article"
                        | "main"
                        | "header"
                        | "footer"
                        | "nav"
                        | "ul"
                        | "ol"
                        | "li"
                        | "strong"
                        | "em"
                        | "b"
                        | "i"
                        | "small"
                        | "code"
                        | "pre"
                        | "blockquote"
                ) || !element.attributes.is_empty()
                {
                    return Err(UNSUPPORTED.into());
                }
                let open = format!("<{}>", element.name);
                let close = format!("</{}>", element.name);
                if !raw.starts_with(&open)
                    || !raw.ends_with(&close)
                    || raw.len() < open.len() + close.len()
                {
                    return Err(UNSUPPORTED.into());
                }
                let mut cursor = element.start as usize + open.len();
                for child in &element.fragment.nodes {
                    let (start, end) = child.span();
                    if start as usize != cursor || end < start {
                        return Err(UNSUPPORTED.into());
                    }
                    self.node(child, depth + 1)?;
                    cursor = end as usize;
                }
                if cursor != element.end as usize - close.len() {
                    return Err(UNSUPPORTED.into());
                }
                Ok(())
            }
            _ => Err(UNSUPPORTED.into()),
        }
    }
}

fn forbidden_identifier(name: &str) -> bool {
    name.starts_with('$')
        || matches!(
            name,
            "stryNS_9fa48" | "stryCov_9fa48" | "stryMutAct_9fa48" | "arguments" | "eval"
        )
}

#[derive(Default)]
pub(super) struct ScriptGuard {
    pub(super) unsupported: bool,
    pub(super) component: bool,
    pub(super) expression: bool,
    reactive: HashSet<u32>,
    typescript: bool,
}

impl ScriptGuard {
    pub(super) fn new(component: bool, expression: bool, typescript: bool) -> Self {
        Self {
            component,
            expression,
            typescript,
            ..Self::default()
        }
    }
}

impl<'a> Visit<'a> for ScriptGuard {
    fn visit_program(&mut self, node: &oxc_ast::ast::Program<'a>) {
        if self.component {
            for statement in &node.body {
                if let Statement::LabeledStatement(label) = statement
                    && label.label.name == "$"
                    && let Statement::ExpressionStatement(statement) = &label.body
                    && let oxc_ast::ast::Expression::AssignmentExpression(assignment) =
                        &statement.expression
                    && assignment.operator == oxc_syntax::operator::AssignmentOperator::Assign
                    && matches!(
                        assignment.left,
                        oxc_ast::ast::AssignmentTarget::AssignmentTargetIdentifier(_)
                    )
                {
                    self.reactive.insert(label.span.start);
                }
            }
        }
        walk::walk_program(self, node);
    }

    fn visit_statement(&mut self, node: &Statement<'a>) {
        if self.typescript {
            self.unsupported |= !matches!(
                node,
                Statement::ImportDeclaration(_)
                    | Statement::FunctionDeclaration(_)
                    | Statement::VariableDeclaration(_)
                    | Statement::ExpressionStatement(_)
                    | Statement::LabeledStatement(_)
                    | Statement::ReturnStatement(_)
                    | Statement::BlockStatement(_)
                    | Statement::EmptyStatement(_)
                    | Statement::ExportDeclaration(_)
            );
        }
        self.unsupported |= match node {
            Statement::ImportDeclaration(import) => {
                !self.component || !import.import_kind.is_type()
            }
            Statement::ExportDeclaration(export) => {
                !self.component
                    || !matches!(
                        export.declaration,
                        oxc_ast::ast::Declaration::FunctionDeclaration(_)
                    )
            }
            Statement::LabeledStatement(label) => !self.reactive.contains(&label.span.start),
            Statement::ExportDefaultDeclaration(_)
            | Statement::ExportNamedDeclaration(_)
            | Statement::ExportFromDeclaration(_)
            | Statement::ExportAllDeclaration(_) => true,
            _ => false,
        };
        walk::walk_statement(self, node);
    }

    fn visit_expression(&mut self, node: &oxc_ast::ast::Expression<'a>) {
        use oxc_ast::ast::Expression as E;
        self.unsupported |= matches!(
            node,
            E::TSAsExpression(_)
                | E::TSSatisfiesExpression(_)
                | E::TSNonNullExpression(_)
                | E::TSTypeAssertion(_)
                | E::TSInstantiationExpression(_)
        );
        if self.expression {
            self.unsupported |= !matches!(
                node,
                E::Identifier(_)
                    | E::NumericLiteral(_)
                    | E::StringLiteral(_)
                    | E::BooleanLiteral(_)
                    | E::BinaryExpression(_)
                    | E::CallExpression(_)
            );
            if let E::CallExpression(call) = node {
                self.unsupported |= call.optional
                    || !matches!(call.callee, E::Identifier(_))
                    || call.type_arguments.is_some();
            }
        }
        walk::walk_expression(self, node);
    }

    fn visit_ts_type(&mut self, node: &oxc_ast::ast::TSType<'a>) {
        use oxc_ast::ast::TSType as T;
        self.unsupported |= !matches!(
            node,
            T::TSNumberKeyword(_)
                | T::TSStringKeyword(_)
                | T::TSBooleanKeyword(_)
                | T::TSArrayType(_)
                | T::TSTypeReference(_)
        );
        if let T::TSTypeReference(reference) = node {
            self.unsupported |= reference.type_arguments.is_some();
        }
        walk::walk_ts_type(self, node);
    }

    fn visit_ts_type_parameter_declaration(
        &mut self,
        _: &oxc_ast::ast::TSTypeParameterDeclaration<'a>,
    ) {
        self.unsupported = true;
    }

    fn visit_binding_identifier(&mut self, node: &BindingIdentifier<'a>) {
        self.unsupported |= forbidden_identifier(&node.name);
    }
    fn visit_identifier_reference(&mut self, node: &IdentifierReference<'a>) {
        self.unsupported |= forbidden_identifier(&node.name);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn complete_typed_boundaries_and_empty_static_templates() {
        for source in [
            "<script>let name='world';</script><h1>Hello {name}</h1>",
            "<script></script>",
            "<div><script>let name='nested';</script><script></script></div>",
            "<script>let n=1;</script><div><script></script></div>",
            "<script context=\"module\">const name='world';</script>",
            "<script>let n=1;</script><div>{n}</div><script context=\"module\">let n=2;</script>",
            " <script>const café=1;</script>\r\n<div>😀 { café }</div> ",
            "<div><span>text</span></div><script>let n=1;</script>",
        ] {
            assert!(script_ranges(source).is_ok(), "{source}");
        }
    }

    #[test]
    fn unproved_syntax_recovery_and_delimiters_reject() {
        for source in [
            "<script/>",
            "<script module>let n=1;</script>",
            "<script context='module'>let n=1;</script>",
            "<script context=\"module\" lang=\"js\">let n=1;</script>",
            "<script context=\"module\">let n=1;</script><script context=\"module\"></script>",
            "<script context=\"module\"></script><script></script><p>{script1}</p>",
            "<script>let n=1;</script><p>open",
            "<script>let n=1;</script><p><div>x</div></p>",
            "<script>let n=1;</script><div>{n+1}</div>",
            "<script>let n=1;</script><div>{(n)}</div>",
            "<script>let n=1;</script><div>{\\u006e}</div>",
            "<script>let n=1;</script><style></style>",
            "<script>let n=1;</script><!-- comment -->",
            "<script>let n=1;</script><script></script>",
        ] {
            assert!(script_ranges(source).is_err(), "{source}");
        }
    }
}
