//! Bounded Svelte containers. The pinned parser proves node kinds and original
//! byte boundaries; it does not establish compiler equivalence on its own.
//! Only ranges cross into our Oxc 0.154 engine. The parser's Oxc 0.149 AST never
//! does, and deferred scripts are parsed exactly once by the existing engine.

use std::{collections::HashSet, ops::Range};

use oxc_ast::ast::{BindingIdentifier, IdentifierReference, Statement};
use oxc_ast_visit::{Visit, walk};
use rsvelte_core::{
    Allocator, ParseOptions,
    ast::{arena::ParseArena, js::Expression as TemplateExpression, typed_expr::JsNode, *},
    parse, resolve_lazy_expressions,
};

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
        arena: &root.arena,
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
    arena: &'s ParseArena,
    nested: Vec<Range<usize>>,
    expressions: Vec<Range<usize>>,
    names: Vec<String>,
    typescript: HashSet<usize>,
}

impl TemplateProof<'_> {
    fn identifier(&mut self, expression: &TemplateExpression<'_>) -> Result<(), String> {
        let name = expression.identifier_name().ok_or(UNSUPPORTED)?;
        let start = expression.start().ok_or(UNSUPPORTED)? as usize;
        let end = expression.end().ok_or(UNSUPPORTED)? as usize;
        if forbidden_identifier(name) || self.source.get(start..end) != Some(name) {
            return Err(UNSUPPORTED.into());
        }
        self.names.push(name.to_owned());
        Ok(())
    }

    fn expression(&mut self, expression: &TemplateExpression<'_>) -> Result<Range<usize>, String> {
        let range = expression.start().ok_or(UNSUPPORTED)? as usize
            ..expression.end().ok_or(UNSUPPORTED)? as usize;
        if self.source.get(range.clone()).is_none() {
            return Err(UNSUPPORTED.into());
        }
        if expression.node_type() == Some("Identifier") {
            self.identifier(expression)?;
        }
        // Stay within unparenthesized ordinary binary operands. In particular,
        // JS `choose<string>(n)` is a relational tree, not a typed call; its
        // right-operand delimiter must not silently broaden the old boundary.
        if let JsNode::BinaryExpression {
            left,
            right,
            operator,
            ..
        } = expression.as_node_ref()
        {
            let left = self.arena.get_js_node(*left);
            let right = self.arena.get_js_node(*right);
            if !self
                .source
                .get(
                    left.end().ok_or(UNSUPPORTED)? as usize
                        ..right.start().ok_or(UNSUPPORTED)? as usize,
                )
                .is_some_and(|s| s.trim_matches(super::js_whitespace) == operator.as_str())
            {
                return Err(UNSUPPORTED.into());
            }
        }
        self.expressions.push(range.clone());
        Ok(range)
    }

    fn delimited(
        &self,
        start: usize,
        end: usize,
        range: &Range<usize>,
        prefix: &str,
        suffix: &str,
    ) -> Result<(), String> {
        if !self
            .source
            .get(start..range.start)
            .is_some_and(|s| s.strip_prefix(prefix).is_some_and(whitespace))
            || !self
                .source
                .get(range.end..end)
                .is_some_and(|s| s.strip_suffix(suffix).is_some_and(whitespace))
        {
            return Err(UNSUPPORTED.into());
        }
        Ok(())
    }

    fn fragment(
        &mut self,
        fragment: &Fragment<'_>,
        depth: usize,
        const_tags: bool,
    ) -> Result<(), String> {
        let mut end = None;
        for node in &fragment.nodes {
            let span = node.span();
            if end.is_some_and(|end| end != span.0) {
                return Err(UNSUPPORTED.into());
            }
            if let TemplateNode::ConstTag(tag) = node {
                if !const_tags {
                    return Err(UNSUPPORTED.into());
                }
                // Modern rsvelte stores a declaration. Upstream's legacy AST
                // instruments the single declarator as an AssignmentExpression,
                // excluding the `const` keyword and retaining its original span.
                let JsNode::VariableDeclaration {
                    declarations, kind, ..
                } = tag.declaration.as_node_ref()
                else {
                    return Err(UNSUPPORTED.into());
                };
                let [
                    JsNode::VariableDeclarator {
                        id,
                        init: Some(init),
                        ..
                    },
                ] = self.arena.get_js_children(*declarations)
                else {
                    return Err(UNSUPPORTED.into());
                };
                let binding = self.arena.get_js_node(*id);
                let initializer = self.arena.get_js_node(*init);
                let name = binding.identifier_name().ok_or(UNSUPPORTED)?;
                if kind != "const" || forbidden_identifier(name) {
                    return Err(UNSUPPORTED.into());
                }
                let range = binding.start().ok_or(UNSUPPORTED)? as usize
                    ..initializer.end().ok_or(UNSUPPORTED)? as usize;
                self.delimited(tag.start as usize, tag.end as usize, &range, "{@const", "}")?;
                self.names.push(name.to_owned());
                self.expressions.push(range);
            } else {
                self.node(node, depth)?;
            }
            end = Some(span.1);
        }
        Ok(())
    }

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
                if !matches!(
                    tag.expression.node_type(),
                    Some(
                        "Identifier"
                            | "CallExpression"
                            | "BinaryExpression"
                            | "ConditionalExpression"
                            | "MemberExpression"
                    )
                ) {
                    return Err(UNSUPPORTED.into());
                }
                let range = self.expression(&tag.expression)?;
                self.delimited(tag.start as usize, tag.end as usize, &range, "{", "}")
            }
            TemplateNode::IfBlock(block) => {
                let range = self.expression(&block.test)?;
                let prefix = if block.elseif { "{:else if" } else { "{#if" };
                if !source
                    .get(block.start as usize..range.start)
                    .is_some_and(|s| s.strip_prefix(prefix).is_some_and(whitespace))
                {
                    return Err(UNSUPPORTED.into());
                }
                self.fragment(&block.consequent, depth + 1, false)?;
                if let Some(alternate) = &block.alternate {
                    self.fragment(alternate, depth + 1, false)?;
                }
                Ok(())
            }
            TemplateNode::EachBlock(block) => {
                let context = block.context.as_ref().ok_or(UNSUPPORTED)?;
                if block.index.is_some()
                    || block.key.is_some()
                    || block.fallback.is_some()
                    || context.node_type() != Some("Identifier")
                {
                    return Err(UNSUPPORTED.into());
                }
                self.expression(&block.expression)?;
                self.identifier(context)?;
                self.fragment(&block.body, depth + 1, true)
            }
            TemplateNode::ConstTag(_) => Err(UNSUPPORTED.into()),
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
                        | "button"
                        | "table"
                        | "tbody"
                        | "tr"
                        | "td"
                ) {
                    return Err(UNSUPPORTED.into());
                }
                let mut opening_end = element.start as usize + element.name.len() + 1;
                if source.get(element.start as usize..opening_end)
                    != Some(&format!("<{}", element.name))
                {
                    return Err(UNSUPPORTED.into());
                }
                for attribute in &element.attributes {
                    let (start, end) = attribute.span();
                    if element.name != "button"
                        || !source
                            .get(opening_end..start as usize)
                            .is_some_and(|s| !s.is_empty() && whitespace(s))
                    {
                        return Err(UNSUPPORTED.into());
                    }
                    match attribute {
                        Attribute::OnDirective(on)
                            if on.name == "click" && on.modifiers.is_empty() =>
                        {
                            let expression = on.expression.as_ref().ok_or(UNSUPPORTED)?;
                            if expression.node_type() != Some("ArrowFunctionExpression") {
                                return Err(UNSUPPORTED.into());
                            }
                            let range = self.expression(expression)?;
                            self.delimited(
                                start as usize,
                                end as usize,
                                &range,
                                "on:click={",
                                "}",
                            )?;
                        }
                        Attribute::Attribute(attribute) if attribute.name == "disabled" => {
                            let tag = match &attribute.value {
                                AttributeValue::Expression(tag) => tag,
                                AttributeValue::Sequence(parts) => match parts.as_slice() {
                                    [AttributeValuePart::ExpressionTag(tag)] => tag,
                                    _ => return Err(UNSUPPORTED.into()),
                                },
                                _ => return Err(UNSUPPORTED.into()),
                            };
                            let range = self.expression(&tag.expression)?;
                            self.delimited(
                                start as usize,
                                end as usize,
                                &range,
                                "disabled={",
                                "}",
                            )?;
                        }
                        _ => return Err(UNSUPPORTED.into()),
                    }
                    opening_end = end as usize;
                }
                // The typed child span starts immediately after the complete opening.
                let child_start = element
                    .fragment
                    .nodes
                    .first()
                    .map_or(element.end as usize - element.name.len() - 3, |node| {
                        node.span().0 as usize
                    });
                if !source
                    .get(opening_end..child_start)
                    .is_some_and(|s| s.strip_suffix('>').is_some_and(whitespace))
                {
                    return Err(UNSUPPORTED.into());
                }
                let close = format!("</{}>", element.name);
                if !raw.ends_with(&close) || child_start > element.end as usize - close.len() {
                    return Err(UNSUPPORTED.into());
                }
                let mut cursor = child_start;
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
    call_depth: usize,
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
                    | E::ConditionalExpression(_)
                    | E::StaticMemberExpression(_)
                    | E::ArrowFunctionExpression(_)
                    | E::AssignmentExpression(_)
            );
            self.unsupported |= self.call_depth > 0
                && matches!(
                    node,
                    E::ConditionalExpression(_)
                        | E::StaticMemberExpression(_)
                        | E::ArrowFunctionExpression(_)
                        | E::AssignmentExpression(_)
                );
            if let E::StaticMemberExpression(member) = node {
                self.unsupported |= member.optional;
            }
            if let E::ArrowFunctionExpression(arrow) = node {
                self.unsupported |= arrow.r#async
                    || matches!(arrow.body, oxc_ast::ast::ArrowFunctionBody::FunctionBody(_))
                    || !arrow.params.items.is_empty()
                    || arrow.params.rest.is_some();
            }
            if let E::CallExpression(call) = node {
                self.unsupported |= call.optional
                    || !matches!(call.callee, E::Identifier(_))
                    || call.type_arguments.is_some();
            }
        }
        walk::walk_expression(self, node);
    }

    fn visit_call_expression(&mut self, node: &oxc_ast::ast::CallExpression<'a>) {
        self.call_depth += 1;
        walk::walk_call_expression(self, node);
        self.call_depth -= 1;
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
            "<script>let n=1;</script><div>{n?.value}</div>",
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
