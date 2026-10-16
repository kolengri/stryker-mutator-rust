//! Source-preserving HTML containers, qualified against Stryker 10's Angular
//! parser. SWC supplies both the computational tree and its actual lexer tokens;
//! an error-free HTML5 tree alone is deliberately insufficient evidence.

use std::ops::Range;

use swc_atoms::Atom;
use swc_common::{BytePos, Span, input::StringInput};
use swc_html_ast::{Child, Element, Namespace, Token, TokenAndSpan};
use swc_html_parser::{
    error::Error,
    lexer::{Lexer, State},
    parser::{Parser, ParserConfig, input::ParserInput},
};

use super::{ApiMutant, File, Options, Position, SourceType, instrument_program};

const UNSUPPORTED: &str = "HTML markup requires upstream parser equivalence";

struct Segment {
    bytes: Range<usize>,
    source_type: SourceType,
    offset: Position,
}

// Record only structural tokens, from the SAME lexer the tree builder drives.
// A standalone tokenization pass would miss its raw-text/script state changes.
struct Recording<'a, 't> {
    lexer: Lexer<'a, StringInput<'a>>,
    tokens: &'t mut Vec<TokenAndSpan>,
}

impl Iterator for Recording<'_, '_> {
    type Item = TokenAndSpan;

    fn next(&mut self) -> Option<Self::Item> {
        let token = self.lexer.next()?;
        if !matches!(token.token, Token::Character { .. } | Token::Eof) {
            self.tokens.push(token.clone());
        }
        Some(token)
    }
}

impl ParserInput for Recording<'_, '_> {
    fn start_pos(&mut self) -> BytePos {
        self.lexer.start_pos()
    }
    fn last_pos(&mut self) -> BytePos {
        self.lexer.last_pos()
    }
    fn take_errors(&mut self) -> Vec<Error> {
        self.lexer.take_errors()
    }
    fn set_last_start_tag_name(&mut self, name: &Atom) {
        self.lexer.set_last_start_tag_name(name);
    }
    fn set_input_state(&mut self, state: State) {
        self.lexer.set_input_state(state);
    }
    fn set_adjusted_current_node_to_html_namespace(&mut self, value: bool) {
        self.lexer
            .set_adjusted_current_node_to_html_namespace(value);
    }
}

pub(super) fn instrument(
    file: &File,
    options: &Options,
    records: &mut Vec<ApiMutant>,
    next_id: &mut usize,
) -> Result<String, String> {
    let segments = segments(&file.content)?;
    let mut output = String::new();
    let mut cursor = 0;
    for segment in segments {
        let printed = instrument_program(
            file,
            &file.content[segment.bytes.clone()],
            segment.source_type,
            segment.offset,
            options,
            records,
            next_id,
            None,
        )?;
        output.push_str(&file.content[cursor..segment.bytes.start]);
        output.push('\n');
        output.push_str(&printed);
        output.push('\n');
        cursor = segment.bytes.end;
    }
    output.push_str(&file.content[cursor..]);
    Ok(output)
}

fn segments(source: &str) -> Result<Vec<Segment>, String> {
    let length = u32::try_from(source.len())
        .ok()
        .and_then(|length| length.checked_add(1))
        .ok_or("HTML source exceeds 32-bit span limits")?;
    let mut tokens = vec![];
    let input = Recording {
        lexer: Lexer::new(StringInput::new(source, BytePos(1), BytePos(length))),
        tokens: &mut tokens,
    };
    let mut parser = Parser::new(
        input,
        ParserConfig {
            // Angular accepts fragments without a doctype. This flag suppresses
            // only the HTML5 document-doctype requirement (not syntax errors).
            iframe_srcdoc: true,
            allow_self_closing: true,
            ..ParserConfig::default()
        },
    );
    let document = parser
        .parse_document()
        .map_err(|error| error.message().into_owned())?;
    let errors = parser.take_errors();
    if !errors.is_empty() {
        return Err(format!(
            "HTML parser recovery requires upstream: {errors:?}"
        ));
    }
    let mut proof = Proof {
        source,
        tokens: &tokens,
        cursor: 0,
        segments: vec![],
    };
    proof.children(&document.children, 0..source.len(), false, 0)?;
    if proof.cursor != tokens.len() {
        return Err(UNSUPPORTED.into());
    }
    Ok(proof.segments)
}

struct Proof<'a> {
    source: &'a str,
    tokens: &'a [TokenAndSpan],
    cursor: usize,
    segments: Vec<Segment>,
}

fn bytes(span: Span) -> Result<Range<usize>, String> {
    let start = span.lo.0.checked_sub(1).ok_or(UNSUPPORTED)? as usize;
    let end = span.hi.0.checked_sub(1).ok_or(UNSUPPORTED)? as usize;
    (start <= end)
        .then_some(start..end)
        .ok_or(UNSUPPORTED.into())
}

fn void(name: &str) -> bool {
    matches!(
        name,
        "area"
            | "base"
            | "br"
            | "embed"
            | "hr"
            | "img"
            | "input"
            | "link"
            | "meta"
            | "param"
            | "source"
            | "track"
            | "wbr"
    )
}

fn ordinary(name: &str) -> bool {
    void(name)
        || matches!(
            name,
            "html"
                | "head"
                | "body"
                | "script"
                | "style"
                | "title"
                | "textarea"
                | "div"
                | "span"
                | "p"
                | "main"
                | "section"
                | "article"
                | "header"
                | "footer"
                | "h1"
                | "h2"
                | "h3"
                | "h4"
                | "h5"
                | "h6"
                | "pre"
                | "code"
                | "b"
                | "strong"
                | "em"
                | "i"
                | "a"
        )
}

fn plain_attribute(name: &str) -> bool {
    name.as_bytes().first().is_some_and(u8::is_ascii_lowercase)
        && name
            .bytes()
            .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || matches!(ch, b'-' | b'_'))
}

fn html_space(ch: u8) -> bool {
    matches!(ch, b' ' | b'\t' | b'\n' | b'\r' | b'\x0c')
}

impl Proof<'_> {
    fn element_range(&self, element: &Element) -> Result<Range<usize>, String> {
        let mut range = bytes(element.span)?;
        if matches!(element.tag_name.as_ref(), "html" | "body") {
            // SWC node_to_child extends these two spans over trailing children.
            // It can merge whitespace before/after </html> into one text node
            // whose span includes that closing token. Use the actual token end;
            // only parsed whitespace leaves may cross the explicit boundary.
            let closing = self.tokens[self.cursor..].iter().find(|token| {
                matches!(&token.token, Token::EndTag { tag_name, .. } if tag_name == &element.tag_name)
            }).ok_or(UNSUPPORTED)?;
            let close = bytes(closing.span)?;
            if close.start < range.start || close.end > range.end {
                return Err(UNSUPPORTED.into());
            }
            range.end = close.end;
        }
        Ok(range)
    }

    fn raw(&self, range: Range<usize>) -> Result<&str, String> {
        self.source.get(range).ok_or(UNSUPPORTED.into())
    }

    fn token(&mut self) -> Result<&TokenAndSpan, String> {
        let token = self.tokens.get(self.cursor).ok_or(UNSUPPORTED)?;
        self.cursor += 1;
        Ok(token)
    }

    // The proof walks the parser tree, not a replacement HTML scanner. Every
    // explicit node must consume exactly its original opening/closing tokens in
    // preorder, contained by its explicit parent. This rejects implicit closes,
    // adoption/foster reparenting, discarded tags, and normalized spellings.
    fn children(
        &mut self,
        children: &[Child],
        interior: Range<usize>,
        raw_text: bool,
        depth: usize,
    ) -> Result<(), String> {
        if depth > 128 {
            return Err("HTML nesting exceeds the bounded frontend".into());
        }
        let mut end = interior.start;
        for child in children {
            if let Child::Text(text) = child
                && text.data.bytes().all(html_space)
                && text
                    .raw
                    .as_ref()
                    .is_some_and(|raw| raw.bytes().all(html_space))
            {
                // Whitespace has no executable descendants. Its parsed raw
                // spelling must be whitespace too: an entity is not eligible.
                continue;
            }
            let span = match child {
                Child::Element(element) if element.span.is_dummy() => {
                    if !matches!(element.tag_name.as_ref(), "html" | "head" | "body")
                        || !element.attributes.is_empty()
                        || element.content.is_some()
                    {
                        return Err(UNSUPPORTED.into());
                    }
                    // Only the parser's absent document wrappers are transparent.
                    // Their explicit descendants still consume all source tokens.
                    self.children(&element.children, interior.clone(), false, depth + 1)?;
                    continue;
                }
                Child::Element(element) => element.span,
                Child::Text(text) => text.span,
                Child::Comment(comment) => comment.span,
                Child::DocumentType(doctype) => doctype.span,
            };
            let range = if let Child::Element(element) = child {
                self.element_range(element)?
            } else {
                bytes(span)?
            };
            if range.start < end || range.end > interior.end {
                return Err(UNSUPPORTED.into());
            }
            end = range.end;
            match child {
                Child::Element(element) => self.element(element, depth + 1)?,
                Child::Text(_) => {
                    let raw = self.raw(range)?;
                    if !raw_text && (raw.contains('&') || raw.contains("{{") || raw.contains("}}"))
                    {
                        return Err("HTML entities/interpolation require upstream parsing".into());
                    }
                }
                Child::Comment(_) => {
                    let token = self.token()?;
                    if !matches!(token.token, Token::Comment { .. }) || token.span != span {
                        return Err(UNSUPPORTED.into());
                    }
                    let raw = self.raw(range)?;
                    if !raw.starts_with("<!--") || !raw.ends_with("-->") {
                        return Err(UNSUPPORTED.into());
                    }
                }
                Child::DocumentType(_) => {
                    let token = self.token()?;
                    if !matches!(token.token, Token::Doctype { .. })
                        || token.span != span
                        || !self.raw(range)?.eq_ignore_ascii_case("<!doctype html>")
                    {
                        return Err(UNSUPPORTED.into());
                    }
                }
            }
        }
        Ok(())
    }

    fn element(&mut self, element: &Element, depth: usize) -> Result<(), String> {
        let name = element.tag_name.as_ref();
        if element.namespace != Namespace::HTML || element.content.is_some() || !ordinary(name) {
            return Err(UNSUPPORTED.into());
        }
        let range = self.element_range(element)?;
        let opening = self.token()?.clone();
        let Token::StartTag {
            tag_name,
            raw_tag_name,
            is_self_closing,
            attributes: opening_attributes,
        } = &opening.token
        else {
            return Err(UNSUPPORTED.into());
        };
        let open = bytes(opening.span)?;
        if open.start != range.start
            || tag_name != &element.tag_name
            || raw_tag_name.as_deref() != Some(name)
            || opening_attributes.len() != element.attributes.len()
            || *is_self_closing != element.is_self_closing
        {
            return Err(UNSUPPORTED.into());
        }
        for (token, attr) in opening_attributes.iter().zip(&element.attributes) {
            if token.span != attr.span
                || token.name != attr.name
                || token.value != attr.value
                || token.raw_name.as_deref() != Some(token.name.as_ref())
                || !plain_attribute(&token.name)
                || attr.namespace.is_some()
                || attr.prefix.is_some()
            {
                return Err(UNSUPPORTED.into());
            }
            let attr_range = bytes(token.span)?;
            if attr_range.start < open.start || attr_range.end > open.end {
                return Err(UNSUPPORTED.into());
            }
            let raw = self.raw(attr_range)?;
            if raw.contains('&') || raw.contains("{{") || raw.contains("}}") {
                return Err(
                    "HTML attribute entities/interpolation require upstream parsing".into(),
                );
            }
        }
        if void(name) {
            return if element.children.is_empty() && range == open {
                Ok(())
            } else {
                Err(UNSUPPORTED.into())
            };
        }
        if *is_self_closing {
            return Err("Self-closing nonvoid HTML elements require upstream parsing".into());
        }
        let raw_text = matches!(name, "script" | "style" | "title" | "textarea");
        // Raw-text nodes cannot contain elements/comments. SWC and Angular differ
        // for script escaped/double-escaped states and whitespace after `</`.
        if raw_text
            && element
                .children
                .iter()
                .any(|child| !matches!(child, Child::Text(_)))
        {
            return Err(UNSUPPORTED.into());
        }
        self.children(&element.children, open.end..range.end, raw_text, depth)?;
        let closing = self.token()?.clone();
        let Token::EndTag {
            tag_name,
            raw_tag_name,
            is_self_closing,
            attributes,
        } = &closing.token
        else {
            return Err(UNSUPPORTED.into());
        };
        let close = bytes(closing.span)?;
        if close.end != range.end
            || close.start < open.end
            || tag_name != &element.tag_name
            || raw_tag_name.as_deref() != Some(name)
            || *is_self_closing
            || !attributes.is_empty()
        {
            return Err(UNSUPPORTED.into());
        }
        let closing_raw = self.raw(close.clone())?;
        let Some(trailing) = closing_raw
            .strip_prefix(&format!("</{name}"))
            .and_then(|raw| raw.strip_suffix('>'))
        else {
            return Err(UNSUPPORTED.into());
        };
        if !trailing
            .bytes()
            .all(|ch| matches!(ch, b' ' | b'\t' | b'\n' | b'\r' | b'\x0c'))
        {
            return Err(UNSUPPORTED.into());
        }
        let content = open.end..close.start;
        if raw_text {
            let raw = self.raw(content.clone())?;
            if raw.contains("</") || raw.contains("<!--") || (name != "script" && raw.contains('&'))
            {
                return Err("Ambiguous HTML raw-text boundaries require upstream parsing".into());
            }
        }
        if name == "script" && !opening_attributes.iter().any(|attr| attr.name == "src") {
            let format = opening_attributes
                .iter()
                .find(|attr| attr.name == "type")
                .or_else(|| opening_attributes.iter().find(|attr| attr.name == "lang"));
            let format =
                format.map(|attr| attr.value.as_deref().unwrap_or("").to_ascii_lowercase());
            let source_type = match format.as_deref() {
                None | Some("js" | "text/javascript" | "javascript" | "module") => {
                    Some(SourceType::mjs())
                }
                Some("ts" | "text/typescript" | "typescript") => Some(SourceType::ts()),
                Some("tsx" | "text/tsx") => {
                    return Err("HTML TSX scripts require upstream instrumentation".into());
                }
                _ => None,
            };
            if let Some(source_type) = source_type {
                // Angular's line counter increments on LF only. Its column in
                // html-parser.js is the ABSOLUTE UTF-16 offset, not line column.
                let prefix = &self.source[..content.start];
                self.segments.push(Segment {
                    bytes: content,
                    source_type,
                    offset: Position {
                        line: prefix.bytes().filter(|&ch| ch == b'\n').count(),
                        column: prefix.encode_utf16().count() as u32,
                    },
                });
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explicit_document_boundaries_and_script_format() {
        let source = "<!doctype html>\n<html lang=\"en\"><head><meta charset=\"UTF-8\" /><title>Document</title></head>\n<body><script>function add(a,b){return a+b;}add(40,2);</script></body>\n</html>\n";
        assert_eq!(segments(source).unwrap().len(), 1);
        let typed = segments("<script lang=\"ts\">const x:number=1+2;</script>").unwrap();
        assert!(typed[0].source_type.is_typescript());
        assert!(segments("<script lang=\"tsx\">const x=true;</script>").is_err());
    }

    #[test]
    fn opening_attributes_select_formats_and_exclude_external_or_unknown_scripts() {
        let source = "<script lang=\"tsx\" type=\"js\">const js=true;</script><script lang=\"ts\">const ts:number=1;</script><script type=\"json\" lang=\"js\">invalid JS</script><script src>also invalid JS</script>";
        let programs = segments(source).unwrap();
        assert_eq!(programs.len(), 2);
        assert!(!programs[0].source_type.is_typescript());
        assert!(programs[1].source_type.is_typescript());
        assert_eq!(&source[programs[0].bytes.clone()], "const js=true;");
        assert_eq!(&source[programs[1].bytes.clone()], "const ts:number=1;");
    }

    #[test]
    fn explicit_boundaries_reject_normalized_implicit_and_reparented_structures() {
        for source in [
            "<SCRIPT>const x=true;</SCRIPT>",
            "<script TYPE=\"js\">const x=true;</script>",
            "<script type=\"js\" type=\"ts\">const x=true;</script>",
            "<div><p>implicit</div><script>const x=true;</script>",
            "<html><head></head><body></body><script>const moved=true;</script></html>",
            "<html><head></head><body></body></html><span>moved</span>",
            "<template><script>const hidden=true;</script></template>",
            "<script>const x=\"</ script>\";</script>",
        ] {
            assert!(segments(source).is_err(), "{source}");
        }
    }
}
