use globset::{GlobBuilder, GlobMatcher};
use std::path::{Component, Path, PathBuf};

pub(super) fn file_pattern(cwd: &Path, pattern: &str) -> Result<Pattern, String> {
    let mut absolute = PathBuf::new();
    for component in cwd.join(pattern).components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                absolute.pop();
            }
            _ => absolute.push(component.as_os_str()),
        }
    }
    Pattern::new(&super::name(&absolute)?, false)
}

pub(super) struct Pattern {
    segments: Vec<Option<GlobMatcher>>,
}

impl Pattern {
    pub fn new(pattern: &str, case_insensitive: bool) -> Result<Self, String> {
        if pattern.contains(['\\', '\0'])
            || pattern.contains("{.")
            || pattern.contains(",.")
            || ["!(", "?(", "+(", "@(", "*("]
                .iter()
                .any(|value| pattern.contains(value))
        {
            return Err(format!("Unsupported native glob syntax: {pattern}"));
        }
        let mut brace_depth = 0;
        for byte in pattern.bytes() {
            match byte {
                b'{' => brace_depth += 1,
                b'}' => brace_depth -= 1,
                b'/' if brace_depth != 0 => {
                    return Err("Path separators inside glob braces are not supported".into());
                }
                _ => {}
            }
            if brace_depth < 0 {
                return Err(format!("Invalid glob: {pattern}"));
            }
        }
        if brace_depth != 0 {
            return Err(format!("Invalid glob: {pattern}"));
        }
        if pattern.contains('{') && pattern.contains("..") {
            return Err("Brace sequence expansion is not supported by the native runtime".into());
        }
        let segments = pattern
            .trim_start_matches("./")
            .trim_end_matches('/')
            .split('/')
            .map(|segment| {
                if segment == "**" {
                    return Ok(None);
                }
                if segment.contains("**") {
                    return Err(format!("Unsupported embedded globstar: {pattern}"));
                }
                GlobBuilder::new(segment)
                    .literal_separator(true)
                    .case_insensitive(case_insensitive)
                    .build()
                    .map(|glob| Some(glob.compile_matcher()))
                    .map_err(|error| format!("Invalid glob {pattern}: {error}"))
            })
            .collect::<Result<_, _>>()?;
        Ok(Self { segments })
    }

    pub fn matches(&self, path: &str, hidden: bool) -> bool {
        self.matches_path(path, hidden, false)
    }

    fn matches_path(&self, path: &str, hidden: bool, partial: bool) -> bool {
        fn matches(
            segments: &[Option<GlobMatcher>],
            parts: &[&str],
            hidden: bool,
            partial: bool,
        ) -> bool {
            if partial && parts.is_empty() {
                return true;
            }
            let Some(segment) = segments.first() else {
                return parts.is_empty();
            };
            match segment {
                None => {
                    matches(&segments[1..], parts, hidden, partial)
                        || parts.first().is_some_and(|part| {
                            (hidden || !part.starts_with('.'))
                                && matches(segments, &parts[1..], hidden, partial)
                        })
                }
                Some(glob) => parts.first().is_some_and(|part| {
                    (hidden || !part.starts_with('.') || glob.glob().glob().starts_with('.'))
                        && glob.is_match(part)
                        && matches(&segments[1..], &parts[1..], hidden, partial)
                }),
            }
        }
        matches(
            &self.segments,
            &path.split('/').collect::<Vec<_>>(),
            hidden,
            partial,
        )
    }
}

pub(super) struct Ignore {
    pattern: Pattern,
    anchored: bool,
    directory: bool,
    negative: bool,
    disabled: bool,
}

impl Ignore {
    pub fn new(value: &str) -> Result<Self, String> {
        let disabled = value.is_empty() || value.starts_with('#');
        let negations = value.bytes().take_while(|byte| *byte == b'!').count();
        let value = &value[negations..];
        Ok(Self {
            pattern: Pattern::new(value.trim_start_matches('/'), true)?,
            anchored: value.starts_with('/'),
            directory: value.ends_with('/'),
            negative: negations % 2 == 1,
            disabled,
        })
    }

    fn matches(&self, path: &str, directory: bool) -> bool {
        if self.disabled {
            return false;
        }
        ((!self.directory || directory)
            && (self.pattern.matches(path, true)
                || (!self.anchored
                    && self
                        .pattern
                        .matches(path.rsplit('/').next().unwrap_or(path), true))))
            || (directory && self.negative && self.pattern.matches_path(path, true, true))
    }
}

pub(super) fn included(rules: &[Ignore], path: &str, directory: bool) -> bool {
    let mut included = true;
    for rule in rules {
        if rule.negative != included && rule.matches(path, directory) {
            included = rule.negative;
        }
    }
    included
}
