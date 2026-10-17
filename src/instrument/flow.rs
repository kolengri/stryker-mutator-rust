//! Admission for a deliberately small, runtime-bearing Flow subset.
//! Hermes proves original grammar and inert leaf spans. Only Oxc's JS tree is
//! used for mutation/traversal/printing; every public/source read stays original.

use hermes_ast::{node::Node, visitor::Visitor};
use hermes_parser::{ParseFlags, parse_named};
use oxc_ast::ast::*;
use oxc_ast_visit::{Visit as OxcVisit, walk};
use oxc_span::{GetSpan, Span};
use serde_json::Value;

#[derive(Clone, Copy, Default)]
pub(super) struct Policy;

impl Policy {
    pub(super) fn parse(value: &Value) -> Result<Option<Self>, String> {
        if value.is_null() || value.as_array().is_some_and(Vec::is_empty) {
            return Ok(None);
        }
        let plugins = value.as_array().ok_or("Flow plugins must be an array")?;
        if plugins.len() != 1 {
            return Err("Only a single explicit Flow parser plugin is qualified".into());
        }
        match &plugins[0] {
            Value::String(name) if name == "flow" => Ok(Some(Self)),
            Value::Array(tuple) if tuple.len() == 2 && tuple[0] == "flow" => {
                let options = tuple[1]
                    .as_object()
                    .ok_or("Flow plugin options must be an object")?;
                if options
                    .iter()
                    .any(|(name, value)| name != "all" || !value.is_boolean())
                {
                    return Err("Only Flow's boolean all option is qualified".into());
                }
                Ok(Some(Self))
            }
            _ => Err("Unsupported native instrumentation option: plugins".into()),
        }
    }
}

pub(super) struct Prepared {
    pub(super) masked: String,
    annotations: Vec<Span>,
}

impl Prepared {
    pub(super) fn check_print(&self, span: Span) -> Result<(), String> {
        if self
            .annotations
            .iter()
            .any(|annotation| span.contains_inclusive(*annotation))
        {
            return Err("Printed ancestor contains Flow syntax absent from the JS AST".into());
        }
        Ok(())
    }

    pub(super) fn check_program(&self, program: &Program<'_>, source: &str) -> Result<(), String> {
        let first = program
            .body
            .first()
            .map_or(source.len() as u32, |node| node.span().start);
        for comment in &program.comments {
            let text = comment.content_span().source_text(source);
            // Only original leading pragmas are qualified. Detection is over
            // Oxc's actual comments, never a lexical scan of source/code strings.
            if comment.span.start >= first && (text.contains("@flow") || text.contains("@noflow")) {
                return Err("Flow pragmas after code require upstream policy".into());
            }
        }
        let mut guard = ProgramGuard {
            source,
            annotations: &self.annotations,
            found: false,
            truncated_declaration: false,
        };
        guard.visit_program(program);
        if guard.truncated_declaration {
            return Err("Flow annotation extends beyond a reconstructed declaration".into());
        }
        if guard.found {
            return Err(
                "Flow annotation in a filtered statement subtree requires upstream filtering"
                    .into(),
            );
        }
        Ok(())
    }
}

struct ProgramGuard<'s> {
    source: &'s str,
    annotations: &'s [Span],
    found: bool,
    truncated_declaration: bool,
}
impl ProgramGuard<'_> {
    fn check_variables(&mut self, node: &VariableDeclaration<'_>) {
        // Masking a final, uninitialized annotation lets Oxc's ASI path end
        // the declaration at the binding. The emitter would insert ';' before
        // the original annotation left outside that shortened span.
        for declaration in &node.declarations {
            if let BindingPattern::BindingIdentifier(binding) = &declaration.id {
                self.truncated_declaration |= self.annotations.iter().any(|annotation| {
                    annotation.end > node.span.end
                        && annotation.start >= binding.span.end
                        && self.source[binding.span.end as usize..annotation.start as usize]
                            .chars()
                            .all(super::js_whitespace)
                });
            }
        }
    }
}
impl<'a> OxcVisit<'a> for ProgramGuard<'_> {
    fn visit_statement(&mut self, node: &Statement<'a>) {
        if let Statement::VariableDeclaration(declaration) = node {
            self.check_variables(declaration);
        }
        // Loop-header reconstruction removes its temporary ';' before splicing
        // the original annotation, so only standalone declarations need this
        // endpoint proof.
        walk::walk_statement(self, node);
    }

    fn visit_declaration(&mut self, node: &Declaration<'a>) {
        if let Declaration::VariableDeclaration(declaration) = node {
            self.check_variables(declaration);
        }
        walk::walk_declaration(self, node);
    }

    fn visit_expression_statement(&mut self, node: &ExpressionStatement<'a>) {
        if matches!(node.expression, Expression::CallExpression(_)) {
            self.found |= self
                .annotations
                .iter()
                .any(|span| node.span.contains_inclusive(*span));
        }
        walk::walk_expression_statement(self, node);
    }

    fn visit_throw_statement(&mut self, node: &ThrowStatement<'a>) {
        if matches!(node.argument, Expression::NewExpression(_)) {
            self.found |= self
                .annotations
                .iter()
                .any(|span| node.span.contains_inclusive(*span));
        }
        walk::walk_throw_statement(self, node);
    }
}

struct Admission<'s> {
    source: &'s str,
    annotations: Vec<Span>,
    error: Option<String>,
}
impl Admission<'_> {
    fn reject(&mut self, reason: &str) {
        self.error.get_or_insert_with(|| reason.into());
    }

    fn annotation(&mut self, node: &Node<'_>) {
        let Node::TypeAnnotation(wrapper) = node else {
            self.reject("Expected a Flow annotation wrapper");
            return;
        };
        let leaf = wrapper.type_annotation;
        let keyword = match leaf {
            Node::NumberTypeAnnotation(_) => "number",
            Node::StringTypeAnnotation(_) => "string",
            Node::BooleanTypeAnnotation(_) => "boolean",
            _ => {
                self.reject("Only primitive number/string/boolean Flow annotations are qualified");
                return;
            }
        };
        let range = node.range();
        let inner = leaf.range();
        let (start, end, leaf_start, leaf_end) = (
            range.start.offset,
            range.end.offset,
            inner.start.offset,
            inner.end.offset,
        );
        let valid = start < leaf_start
            && leaf_start < leaf_end
            && leaf_end <= end
            && range.start.source == inner.start.source
            && range.end.source == inner.end.source
            && self.source.get(leaf_start as usize..leaf_end as usize) == Some(keyword)
            && self.source.get(start as usize..start as usize + 1) == Some(":")
            && self
                .source
                .get(start as usize + 1..leaf_start as usize)
                .is_some_and(|s| s.chars().all(super::js_whitespace))
            && self
                .source
                .get(leaf_end as usize..end as usize)
                .is_some_and(|s| s.chars().all(super::js_whitespace));
        if !valid {
            self.reject("Annotation spans do not prove a comment-free inert primitive");
            return;
        }
        self.annotations.push(Span::new(start, end));
    }

    fn identifier(&mut self, node: &Node<'_>) {
        let Node::Identifier(identifier) = node else {
            self.reject("Flow bindings must be ordinary identifiers");
            return;
        };
        if identifier.optional.get() {
            self.reject("Optional Flow bindings require upstream grammar");
        }
        if let Some(annotation) = identifier.type_annotation {
            self.annotation(annotation);
        }
    }
}
impl<'gc> Visitor<'gc> for Admission<'_> {
    fn visit_node(&mut self, node: &'gc Node<'gc>) {
        if self.error.is_some() {
            return;
        }
        match node {
            Node::VariableDeclarator(variable) => {
                self.identifier(variable.id);
                if let Some(init) = variable.init { self.visit_node(init); }
            }
            Node::FunctionDeclaration(function) => {
                let Some(id) = function.id else { self.reject("Flow requires a named function declaration"); return; };
                self.identifier(id);
                if function.type_parameters.is_some() || function.predicate.is_some() { self.reject("Flow generics and predicates require upstream grammar"); return; }
                for parameter in function.params.iter() {
                    if let Node::AssignmentPattern(default) = parameter {
                        self.identifier(default.left);
                        self.visit_node(default.right);
                    } else { self.identifier(parameter); }
                }
                if let Some(annotation) = function.return_type { self.annotation(annotation); }
                self.visit_node(function.body);
            }
            Node::Identifier(identifier) if identifier.optional.get() || identifier.type_annotation.is_some() => self.reject("Typed bindings outside variables/named declarations require upstream grammar"),
            Node::ClassDeclaration(_) | Node::ClassExpression(_) => self.reject("Classes are outside the qualified Flow grammar"),
            _ if node.is_flow() || node.is_ts() || node.is_jsx() => self.reject("Flow casts, declarations, generics and extensions require upstream instrumentation"),
            _ => node.visit_children(self),
        }
    }
}

pub(super) fn prepare(source: &str) -> Result<Prepared, String> {
    // Accepted syntax cannot contain generics/casts: the facade's ambiguous
    // Flow mode cannot change the meaning of anything this admission accepts.
    // Oxc then proves the masked JavaScript grammar and module early errors.
    let mut parsed = parse_named(
        source,
        "native-flow.js",
        ParseFlags {
            parse_flow: true,
            strict_mode: true,
            ..Default::default()
        },
    )
    .map_err(|error| format!("Flow syntax error: {error}"))?;
    let annotations = parsed.with_program(|_, root| {
        let mut admission = Admission {
            source,
            annotations: vec![],
            error: None,
        };
        admission.visit_node(root);
        admission.error.map_or(Ok(admission.annotations), Err)
    })?;
    let mut masked = source.as_bytes().to_vec();
    for span in &annotations {
        let text = source
            .get(span.start as usize..span.end as usize)
            .ok_or("Invalid Flow annotation span")?;
        for (offset, ch) in text.char_indices() {
            if !matches!(ch, '\r' | '\n' | '\u{2028}' | '\u{2029}') {
                masked[span.start as usize + offset..span.start as usize + offset + ch.len_utf8()]
                    .fill(b' ');
            }
        }
    }
    Ok(Prepared {
        masked: String::from_utf8(masked).map_err(|error| error.to_string())?,
        annotations,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn masks_preserve_original_bytes_outside_annotations_and_all_line_terminators() {
        let source = "const astral = '😀';\r\nconst n:\u{2003}\r\n\u{2028}number = 1 + 2;";
        let prepared = prepare(source).unwrap();
        assert_eq!(prepared.masked.len(), source.len());
        assert_eq!(prepared.annotations.len(), 1);
        let annotation = prepared.annotations[0];
        assert_eq!(
            annotation.source_text(source),
            ":\u{2003}\r\n\u{2028}number"
        );
        assert_eq!(
            &prepared.masked[..annotation.start as usize],
            &source[..annotation.start as usize]
        );
        assert_eq!(
            &prepared.masked[annotation.end as usize..],
            &source[annotation.end as usize..]
        );
        for (offset, ch) in source.char_indices() {
            if matches!(ch, '\r' | '\n' | '\u{2028}' | '\u{2029}') {
                assert_eq!(
                    &prepared.masked.as_bytes()[offset..offset + ch.len_utf8()],
                    &source.as_bytes()[offset..offset + ch.len_utf8()]
                );
            }
        }
        // Byte-equal masking deliberately changes UTF-16 columns. Positions
        // must continue to read the original source, which retains this gap.
        assert_ne!(
            prepared.masked[..annotation.end as usize]
                .encode_utf16()
                .count(),
            source[..annotation.end as usize].encode_utf16().count()
        );
    }

    #[test]
    fn annotation_comments_and_non_inert_types_are_rejected() {
        for source in [
            "const n: /* keep */ number = 1 + 2;",
            "const n: // keep\nnumber = 1 + 2;",
            "const n: ?number = 1;",
            "const n = (1 + 2: number);",
            "declare const n: number;",
        ] {
            assert!(prepare(source).is_err(), "{source}");
        }
    }

    #[test]
    fn no_flow_policy_remains_absent_and_unknown_policies_reject() {
        for value in [Value::Null, serde_json::json!([])] {
            assert!(Policy::parse(&value).unwrap().is_none());
        }
        for value in [
            serde_json::json!(["flow", "typescript"]),
            serde_json::json!([["flow", {"all": "true"}]]),
            serde_json::json!([["flow", {"enums": true}]]),
        ] {
            assert!(Policy::parse(&value).is_err());
        }
    }
}
