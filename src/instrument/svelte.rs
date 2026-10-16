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
    // Transform the module FIRST, independently of source order, without
    // resetting global IDs. Printing below restores original source order.
    let child_options = Options {
        no_header: true,
        excluded: options.excluded.clone(),
    };
    let mut state = ScriptState::default();
    let mut replacements = Vec::new();
    for (range, module) in scripts
        .module
        .iter()
        .map(|range| (range, true))
        .chain(scripts.instance.iter().map(|range| (range, false)))
    {
        state.module = module;
        let printed = instrument_program_inner(
            file,
            &file.content[range.clone()],
            SourceType::mjs(),
            // Svelte projects ORIGINAL text into line-relative UTF-16 columns.
            Positions::new(&file.content).at(range.start as u32),
            &child_options,
            records,
            next_id,
            None,
            true,
            Some(&mut state),
        )?;
        replacements.push((range, printed));
    }
    // Svelte places ONE shared header only for actually placed mutants, even
    // with outer noHeader:true. Ignored records alone never require a header.
    if state.needed && scripts.module.is_some() {
        replacements[0].1.insert_str(0, HEADER);
    }
    replacements.sort_unstable_by_key(|(range, _)| range.start);
    let mut output = String::new();
    if state.needed && scripts.module.is_none() {
        output.push_str("<script context=\"module\">\n");
        output.push_str(HEADER);
        output.push_str("\n</script>\n");
    }
    let mut cursor = 0;
    for (range, printed) in replacements {
        output.push_str(&file.content[cursor..range.start]);
        output.push('\n');
        output.push_str(&printed);
        output.push('\n');
        cursor = range.end;
    }
    output.push_str(&file.content[cursor..]);
    // Bare identifier expressions retain their original bytes upstream too.
    Ok(output)
}

#[derive(Default)]
pub(super) struct ScriptState {
    pub(super) needed: bool,
    pub(super) module: bool,
    pub(super) module_constants: HashSet<String>,
}

struct Scripts {
    module: Option<Range<usize>>,
    instance: Option<Range<usize>>,
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
    // Rust parser diagnostics are not the pinned JS compiler's diagnostics.
    .map_err(|_| UNSUPPORTED)?;
    if root.css.is_some()
        || root.options.is_some()
        || !root.parse_warnings.is_empty()
        || !root.unclosed_ancestors.is_empty()
    {
        return Err(UNSUPPORTED.into());
    }
    // Deferred parsing also defers template expressions. Never accept lazy or
    // recovered expressions merely because the structural parse succeeded.
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
    if module.is_none() && instance.is_none() {
        return Err(UNSUPPORTED.into());
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
            || source
                .get(cursor..start)
                .is_none_or(|gap| !gap.chars().all(super::js_whitespace))
        {
            return Err(UNSUPPORTED.into());
        }
        if let Some(node) = node {
            prove_node(source, node, 0, module.is_some() && instance.is_some())?;
        }
        cursor = end;
    }
    if source
        .get(cursor..)
        .is_none_or(|gap| !gap.chars().all(super::js_whitespace))
    {
        return Err(UNSUPPORTED.into());
    }
    Ok(Scripts { module, instance })
}

fn prove_script(source: &str, script: &Script<'_>, module: bool) -> Result<Range<usize>, String> {
    let range =
        script.content_offset as usize..script.content_offset as usize + script.raw_content.len();
    let (context, opening) = if module {
        (ScriptContext::Module, "<script context=\"module\">")
    } else {
        (ScriptContext::Default, "<script>")
    };
    // The typed context AND complete original delimiters must agree. Other
    // attribute spellings/values, TS and the `module` shorthand stay fallback.
    if script.is_typescript
        || script.context != context
        || if module {
            script.attributes.len() != 1 || script.attributes[0].name != "context"
        } else {
            !script.attributes.is_empty()
        }
        || source.get(script.start as usize..range.start) != Some(opening)
        || source.get(range.clone()) != Some(script.raw_content)
        || source.get(range.end..script.end as usize) != Some("</script>")
    {
        return Err(UNSUPPORTED.into());
    }
    Ok(range)
}

fn prove_node(
    source: &str,
    node: &TemplateNode<'_>,
    depth: usize,
    second_script: bool,
) -> Result<(), String> {
    if depth > 128 {
        return Err(UNSUPPORTED.into());
    }
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
            let name = tag.expression.identifier_name().ok_or(UNSUPPORTED)?;
            let start = tag.expression.start().ok_or(UNSUPPORTED)? as usize;
            let end = tag.expression.end().ok_or(UNSUPPORTED)? as usize;
            // Upstream remaps actual scriptN placeholders even inside bare
            // identifier mustaches. This bounded adapter has at most two scripts.
            if name == "script0"
                || (second_script && name == "script1")
                || forbidden_identifier(name)
                || source.get(start..end) != Some(name)
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
                prove_node(source, child, depth + 1, second_script)?;
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

fn forbidden_identifier(name: &str) -> bool {
    name.starts_with('$')
        || matches!(
            name,
            "stryNS_9fa48" | "stryCov_9fa48" | "stryMutAct_9fa48" | "arguments" | "eval"
        )
}

// Run on the SAME parsed current-version program as the mutation engine. Svelte
// has additional compiler semantics for runes/stores, reactive labels, imports
// and exports. These are outside this capability, even if valid JS.
#[derive(Default)]
pub(super) struct ScriptGuard {
    pub(super) unsupported: bool,
}

impl<'a> Visit<'a> for ScriptGuard {
    fn visit_statement(&mut self, node: &Statement<'a>) {
        self.unsupported |= matches!(
            node,
            Statement::ImportDeclaration(_)
                | Statement::ExportDeclaration(_)
                | Statement::ExportDefaultDeclaration(_)
                | Statement::ExportNamedDeclaration(_)
                | Statement::ExportFromDeclaration(_)
                | Statement::ExportAllDeclaration(_)
                | Statement::LabeledStatement(_)
        );
        walk::walk_statement(self, node);
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
            "<script>let n=1;</script><div><script></script></div>",
        ] {
            assert!(script_ranges(source).is_err(), "{source}");
        }
    }
}
