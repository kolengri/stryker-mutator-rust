//! Babel removes the parentheses of a single untyped identifier parameter.
//!
//! Oxc 0.154's non-minifying generator always emits them. Record the input AST
//! occurrences, then prove their generated parameter ranges in the parsed AST.
//! Never find arrow syntax by searching text (templates can contain the same text).

use oxc_ast::ast::{ArrowFunctionBody, ArrowFunctionExpression, BindingPattern, Expression};
use oxc_ast_visit::{Visit, walk};
use oxc_span::Span;

pub(super) const UNSUPPORTED: &str = "Only synchronous concise arrows with untyped identifier parameters inside printed mutation replacements have native formatting";
const UNPROVEN: &str = "Arrow parameter spelling requires upstream replacement formatting: unproven generated arrow ranges";

pub(super) fn supported(node: &ArrowFunctionExpression<'_>) -> bool {
    !node.r#async
        && !matches!(node.body, ArrowFunctionBody::FunctionBody(_))
        && node.type_parameters.is_none()
        && node.return_type.is_none()
        && node.params.rest.is_none()
        && node.params.items.iter().all(|param| {
            matches!(param.pattern, BindingPattern::BindingIdentifier(_))
                && param.type_annotation.is_none()
                && param.initializer.is_none()
                && !param.optional
                && param.accessibility.is_none()
                && !param.readonly
                && !param.r#override
                && param.decorators.is_empty()
        })
}

#[derive(Default)]
pub(super) struct Proof {
    signatures: Vec<Vec<String>>,
    unsupported: bool,
}

impl Proof {
    pub(super) fn record(&mut self, node: &ArrowFunctionExpression<'_>) {
        if supported(node) {
            self.signatures.push(
                node.params
                    .items
                    .iter()
                    .map(|param| match &param.pattern {
                        BindingPattern::BindingIdentifier(id) => id.name.to_string(),
                        _ => unreachable!(),
                    })
                    .collect(),
            );
        } else {
            self.unsupported = true;
        }
    }

    pub(super) fn check(&self) -> Result<(), String> {
        if self.unsupported {
            Err(UNSUPPORTED.into())
        } else {
            Ok(())
        }
    }

    pub(super) fn is_empty(&self) -> bool {
        self.signatures.is_empty()
    }

    pub(super) fn edits(
        &self,
        expression: &Expression<'_>,
        code: &str,
    ) -> Result<Vec<(Span, String)>, String> {
        let mut ranges = Ranges {
            code,
            expected: &self.signatures,
            visited: 0,
            edits: vec![],
            proven: true,
        };
        ranges.visit_expression(expression);
        if !ranges.proven || ranges.visited != self.signatures.len() {
            return Err(UNPROVEN.into());
        }
        Ok(ranges.edits)
    }
}

struct Ranges<'a> {
    code: &'a str,
    expected: &'a [Vec<String>],
    visited: usize,
    edits: Vec<(Span, String)>,
    proven: bool,
}

impl<'a> Visit<'a> for Ranges<'_> {
    fn visit_arrow_function_expression(&mut self, node: &ArrowFunctionExpression<'a>) {
        let expected = self.expected.get(self.visited);
        self.visited += 1;
        if !supported(node)
            || !expected.is_some_and(|names| {
                names.len() == node.params.items.len()
                    && node.params.items.iter().zip(names).all(|(param, name)| {
                        matches!(&param.pattern, BindingPattern::BindingIdentifier(id) if id.name == name.as_str())
                    })
            })
        {
            self.proven = false;
        } else if let [param] = node.params.items.as_slice()
            && let BindingPattern::BindingIdentifier(id) = &param.pattern
        {
            let span = node.params.span;
            // Check exact generator-owned punctuation at AST-owned byte ranges.
            // The identifier must occupy the entire interior of `(identifier)`.
            if span.start.checked_add(1) == Some(id.span.start)
                && id.span.end.checked_add(1) == Some(span.end)
                && self.code.get(span.start as usize..id.span.start as usize) == Some("(")
                && self.code.get(id.span.end as usize..span.end as usize) == Some(")")
                && self.code.get(id.span.start as usize..id.span.end as usize)
                    == Some(id.name.as_str())
            {
                self.edits.push((span, id.name.to_string()));
            } else {
                self.proven = false;
            }
        }
        walk::walk_arrow_function_expression(self, node);
    }
}
