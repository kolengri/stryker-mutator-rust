use super::super::config::Runner;
use super::*;

fn config(root: &Path) -> Config {
    let mut options = super::super::config::defaults();
    options["mutate"] = json!([]);
    options["disableTypeChecks"] = false.into();
    options["cleanTempDir"] = "always".into();
    Config {
        eta: None,
        cwd: root.canonicalize().unwrap(),
        options,
        concurrency: 1,
        command: "must not execute".into(),
        runner: Runner::Command,
        node_executable: None,
        bridge_module: None,
        modules: vec![],
    }
}

fn write(root: &Path, path: &str, source: &str) {
    let path = root.join(path);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, source).unwrap();
}

fn names(project: &Project) -> Vec<String> {
    project
        .files
        .iter()
        .map(|path| name(path).unwrap())
        .collect()
}

#[test]
fn generated_output_paths_match_project_names_and_preserve_ordered_reinclusion() {
    let directory = tempfile::tempdir().unwrap();
    let mut config = config(directory.path());
    config.options["tempDirName"] = json!(Path::new("build").join("cache/sandboxes"));
    config.options["jsonReporter"]["fileName"] =
        json!(config.cwd.join("reports/nested/mutation.json"));
    config.options["htmlReporter"]["fileName"] = json!(
        directory
            .path()
            .parent()
            .unwrap()
            .join("external-report.html")
    );
    write(&config.cwd, "build/cache/sandboxes/old.ts", "unchanged");
    write(&config.cwd, "reports/nested/mutation.json", "{}");
    write(&config.cwd, "src/value.js", "export const value = 1;");
    assert_eq!(names(&prepare(&config).unwrap()), ["src/value.js"]);

    config.options["ignorePatterns"] = json!(["!/reports/nested/mutation.json"]);
    assert_eq!(
        names(&prepare(&config).unwrap()),
        ["reports/nested/mutation.json", "src/value.js"]
    );
    // Only generated filesystem paths are normalized, not user glob syntax.
    config.options["ignorePatterns"] = json!([r"src\**"]);
    assert!(
        prepare(&config)
            .err()
            .unwrap()
            .contains("Unsupported native glob syntax")
    );
    assert_eq!(
        fs::read_to_string(config.cwd.join("reports/nested/mutation.json")).unwrap(),
        "{}"
    );
    assert!(!config.cwd.join(".stryker-tmp").exists());
}

#[test]
fn generated_outputs_keep_literal_names_and_ignore_only_their_owned_location() {
    for folder in ["#cache", "!cache", "cache[1]", "cache{", "cache}"] {
        let directory = tempfile::tempdir().unwrap();
        let mut config = config(directory.path());
        config.options["tempDirName"] = folder.into();
        config.options["jsonReporter"]["fileName"] =
            json!(config.cwd.join("reports/[mutation]{raw}!.json"));
        write(&config.cwd, &format!("{folder}/old.js"), "owned output");
        write(&config.cwd, "reports/[mutation]{raw}!.json", "{}");
        write(&config.cwd, "cache1/keep.js", "real input");
        write(
            &config.cwd,
            &format!("src/{folder}/keep.js"),
            "nested real input",
        );
        assert_eq!(
            names(&prepare(&config).unwrap()),
            ["cache1/keep.js".to_owned(), format!("src/{folder}/keep.js")],
            "{folder}"
        );
        // User rules still apply in their original order after owned outputs.
        if folder == "#cache" || folder == "!cache" {
            config.options["ignorePatterns"] = json!([format!("!/{folder}/old.js")]);
            assert!(
                names(&prepare(&config).unwrap()).contains(&format!("{folder}/old.js")),
                "{folder}"
            );
        }
        assert_eq!(
            fs::read_to_string(config.cwd.join(format!("{folder}/old.js"))).unwrap(),
            "owned output"
        );
    }
}

#[cfg(unix)]
#[test]
fn generated_output_paths_keep_posix_backslashes_literal() {
    for folder in [r"cache\x", "cache\\"] {
        let directory = tempfile::tempdir().unwrap();
        let mut config = config(directory.path());
        config.options["tempDirName"] = folder.into();
        write(&config.cwd, &format!("{folder}/old.js"), "owned output");
        write(&config.cwd, "cache/keep.js", "real input");
        write(&config.cwd, "cachex/keep.js", "real input");
        write(
            &config.cwd,
            &format!("src/{folder}/keep.js"),
            "nested real input",
        );
        assert_eq!(
            names(&prepare(&config).unwrap()),
            [
                "cache/keep.js".to_owned(),
                "cachex/keep.js".to_owned(),
                format!("src/{folder}/keep.js"),
            ],
            "{folder}"
        );
        assert_eq!(
            fs::read_to_string(config.cwd.join(format!("{folder}/old.js"))).unwrap(),
            "owned output"
        );
    }
}

#[test]
fn default_mutation_excludes_repeated_extglob_test_prefixes() {
    // Expected selections come from core 10.0.0's default patterns evaluated
    // by its pinned Minimatch 10.2.6 through ProjectReader.
    for stem in [
        "x.spec",
        "x.sspec",
        "x.SSpec",
        "x.sSspec",
        "x.ssSpec",
        "x.test",
        "x.Ttest",
        "x.tTest",
        "x.TTTest",
        "π.sSspec",
    ] {
        assert!(!default_match(&format!("src/{stem}.js")), "{stem}");
    }
    for stem in [
        "spec",
        "sspec",
        "test",
        "x.speC",
        "x.SPEC",
        "x.tests",
        "x.sspecHelper",
        "x.ſpec",
        "π.Ṫest",
    ] {
        assert!(default_match(&format!("src/{stem}.js")), "{stem}");
    }
}

#[test]
fn default_mutation_matches_concatenated_extension_alternatives() {
    for extension in [
        "jsjs",
        "jsts",
        "jsjsx",
        "jsxjs",
        "jsxtsx",
        "ctsjsxmjs",
        "htmlvuesvelte",
        "mtscts",
    ] {
        assert!(default_match(&format!("src/x.{extension}")), "{extension}");
        assert!(
            default_match(&format!("lib/nested/x.{extension}")),
            "{extension}"
        );
        assert!(
            !default_match(&format!("src/x.sSspec.{extension}")),
            "{extension}"
        );
        assert!(
            !default_match(&format!("src/x.Ttest.{extension}")),
            "{extension}"
        );
    }
    for extension in ["Js", "jsX", "jsj", "xts", "tsxX", "json", "js.ts"] {
        let expected = extension == "js.ts";
        assert_eq!(
            default_match(&format!("src/x.{extension}")),
            expected,
            "{extension}"
        );
    }
}

#[test]
fn default_mutation_preserves_hidden_directory_and_extension_boundaries() {
    for extension in [
        "cjs", "mjs", "js", "ts", "mts", "cts", "jsx", "tsx", "html", "vue", "svelte",
    ] {
        for path in [
            format!("src/nested/ordinary.{extension}"),
            format!("lib/nested/π.{extension}"),
        ] {
            assert!(default_match(&path), "{path}");
        }
        for path in [
            format!("src/nested/x.sSspec.{extension}"),
            format!("lib/nested/x.Ttest.{extension}"),
            format!("src/.hidden.{extension}"),
            format!("src/.hidden/x.{extension}"),
            format!("src/__tests__/x.{extension}"),
            format!("lib/nested/__tests__/x.{extension}"),
            format!("Src/x.{extension}"),
            format!("other/x.{extension}"),
        ] {
            assert!(!default_match(&path), "{path}");
        }
        assert!(default_match(&format!("src/__Tests__/x.{extension}")));
        assert!(default_match(&format!("src/__tests__.{extension}")));
    }
}

#[test]
fn ordered_ignores_reinclude_exact_nested_files_and_reexclude_secrets() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    for path in [
        "src/nested/keep.js",
        "src/nested/other.js",
        "src/secret/key",
        "src/secret/more/key",
        "other.js",
    ] {
        write(root, path, "asset");
    }
    let mut config = config(root);
    config.options["ignorePatterns"] = json!(["**", "!src/**/keep.js"]);
    assert_eq!(names(&prepare(&config).unwrap()), ["src/nested/keep.js"]);
    config.options["ignorePatterns"] = json!(["**", "!src/**", "src/secret"]);
    assert_eq!(
        names(&prepare(&config).unwrap()),
        ["src/nested/keep.js", "src/nested/other.js"]
    );
    assert!(!root.join(".stryker-tmp").exists());
}

#[test]
fn ignore_parent_partial_matching_is_case_insensitive_and_root_anchored() {
    let directory = tempfile::tempdir().unwrap();
    for path in [
        "SRC/Deep/KEEP.js",
        "SRC/Deep/drop.js",
        "nested/stryker.log",
        "stryker.log",
        ".hidden/keep",
        "foo/file",
        "nested/foo/file",
    ] {
        write(directory.path(), path, "asset");
    }
    let mut config = config(directory.path());
    config.options["ignorePatterns"] = json!([
        "**",
        "!/src/deep/keep.js",
        "!nested/stryker.log",
        "!.hidden/keep"
    ]);
    assert_eq!(
        names(&prepare(&config).unwrap()),
        [".hidden/keep", "SRC/Deep/KEEP.js", "nested/stryker.log"]
    );
    config.options["ignorePatterns"] = json!(["/foo/", "# comment", ""]);
    let selected = names(&prepare(&config).unwrap());
    assert!(!selected.contains(&"foo/file".into()));
    assert!(selected.contains(&"nested/foo/file".into()));
    assert!(!selected.contains(&"stryker.log".into()));
    assert!(selected.contains(&"nested/stryker.log".into()));
}

#[test]
fn metadata_retains_traversal_order_mutation_ranges_and_test_pattern_order() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    for path in [
        "src/a.js",
        "src/b.js",
        "test/a.js",
        "test/b.js",
        "test/.hidden.js",
    ] {
        write(root, path, "export const value = 1;\n");
    }
    let mut config = config(root);
    config.options["mutate"] = json!(["src/*.js", "!src/b.js", "src/b.js:1:0-1:24"]);
    config.options["testFiles"] = json!([
        "test/b.js",
        "test/*.js",
        "test/.hidden.js",
        root.join("test/a.js").to_str().unwrap()
    ]);
    let project = prepare(&config).unwrap();
    assert_eq!(
        project.test_files,
        ["test/b.js", "test/a.js", "test/.hidden.js"].map(PathBuf::from)
    );
    let descriptions = project.descriptions.as_object().unwrap();
    assert_eq!(
        descriptions.keys().cloned().collect::<Vec<_>>(),
        project
            .files
            .iter()
            .map(|path| name(&config.cwd.join(path)).unwrap())
            .collect::<Vec<_>>()
    );
    assert_eq!(
        descriptions[&name(&config.cwd.join("src/a.js")).unwrap()]["mutate"],
        true
    );
    assert_eq!(
        descriptions[&name(&config.cwd.join("src/b.js")).unwrap()]["mutate"],
        json!([{"start":{"line":0,"column":0},"end":{"line":0,"column":24}}])
    );
    assert_eq!(
        descriptions[&name(&config.cwd.join("test/a.js")).unwrap()]["mutate"],
        false
    );
}

#[test]
fn missing_or_unselected_tsconfig_is_never_parsed() {
    let directory = tempfile::tempdir().unwrap();
    write(directory.path(), "asset", "asset");
    let mut config = config(directory.path());
    assert!(prepare(&config).unwrap().preprocessed.is_empty());
    write(directory.path(), "tsconfig.json", "malformed secret");
    config.options["ignorePatterns"] = json!(["tsconfig.json"]);
    assert!(prepare(&config).unwrap().preprocessed.is_empty());
    assert!(!directory.path().join(".stryker-tmp").exists());
}

#[test]
fn jsonc_selected_only_dfs_handles_cycles_missing_references_and_integer_key_order() {
    let directory = tempfile::tempdir().unwrap();
    write(
        directory.path(),
        "tsconfig.json",
        "// config\n{\"extends\":\"./base.json\",\"references\":[{\"path\":\"child\"},{\"path\":\"missing\"}],\"compilerOptions\":{\"strict\":true,},\"10\":10,\"2\":2,}",
    );
    write(
        directory.path(),
        "base.json",
        "{\"extends\":\"./tsconfig.json\"}",
    );
    write(
        directory.path(),
        "child/tsconfig.json",
        "{\"extends\":\"../tsconfig.json\",\"include\":[\"./src/**/*\"]}",
    );
    write(directory.path(), "unused.json", "not valid JSON");
    let config = config(directory.path());
    let project = prepare(&config).unwrap();
    assert_eq!(
        project
            .preprocessed
            .iter()
            .map(|(path, _)| name(path).unwrap())
            .collect::<Vec<_>>(),
        ["base.json", "child/tsconfig.json", "tsconfig.json"]
    );
    let root = &project.preprocessed[2].1;
    assert!(root.starts_with("{\n  \"2\": 2,\n  \"10\": 10,"), "{root}");
    let root: Value = serde_json::from_str(root).unwrap();
    assert_eq!(
        root["references"],
        json!([{"path":"child"},{"path":"missing"}])
    );
    assert_eq!(root["compilerOptions"], json!({"strict":true}));
    assert!(
        fs::read_to_string(config.cwd.join("tsconfig.json"))
            .unwrap()
            .starts_with("// config")
    );
}

#[test]
fn external_rewrites_resolve_to_original_targets_at_every_sandbox_depth() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("project");
    fs::create_dir(&root).unwrap();
    // A glob is a lexical pattern, not a verbatim Windows filesystem path.
    let root = tsconfig::normalize(&root.canonicalize().unwrap());
    write(
        &root,
        "nested/tsconfig.json",
        "{\"extends\":\"../../external/base.json\",\"references\":[{\"path\":\"../../external/model\"}],\"include\":[\"../../external/**/*.ts\"],\"exclude\":[\"../../external/generated\"],\"files\":[\"../../external/a.ts\"],\"compilerOptions\":{\"baseUrl\":\"../../external\"}}",
    );
    for temp in [".stryker-tmp", "build/cache/sandboxes"] {
        let mut config = config(&root);
        config.options["tsconfigFile"] = "nested/tsconfig.json".into();
        config.options["tempDirName"] = temp.into();
        let original = fs::read(root.join("nested/tsconfig.json")).unwrap();
        let project = prepare(&config).unwrap();
        let mut sandbox = Sandbox::create(&config, &project).unwrap();
        let rewritten: Value =
            serde_json::from_slice(&fs::read(sandbox.path.join("nested/tsconfig.json")).unwrap())
                .unwrap();
        for (value, suffix) in [
            (&rewritten["extends"], "external/base.json"),
            (
                &rewritten["references"][0]["path"],
                "external/model/tsconfig.json",
            ),
            (&rewritten["include"][0], "external/**/*.ts"),
            (&rewritten["exclude"][0], "external/generated"),
            (&rewritten["files"][0], "external/a.ts"),
        ] {
            assert_eq!(
                tsconfig::normalize(&sandbox.path.join("nested").join(value.as_str().unwrap())),
                tsconfig::normalize(&root.parent().unwrap().join(suffix))
            );
        }
        assert_eq!(rewritten["compilerOptions"]["baseUrl"], "../../external");
        assert_eq!(
            fs::read(root.join("nested/tsconfig.json")).unwrap(),
            original
        );
        sandbox.finish(&config);
        sandbox.cleanup().unwrap();
    }
}

#[test]
fn absolute_paths_and_array_extends_keep_sandbox_and_original_resolution() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("project");
    fs::create_dir(&root).unwrap();
    let root = root.canonicalize().unwrap();
    let external = directory.path().join("external.json");
    write(
        &root,
        "base.json",
        "{\"compilerOptions\":{\"strict\":true}}",
    );
    write(&root, ".base.json", "{}");
    write(&root, "tsconfig.json", &json!({"extends":[root.join("base.json"), external, root.join(".base.json")],"files":[root.join("src/file.ts")],"include":["../project/src/*.ts", "..generated/**/*.ts"]}).to_string());
    let config = config(&root);
    let project = prepare(&config).unwrap();
    assert_eq!(project.preprocessed.len(), 3);
    let mut sandbox = Sandbox::create(&config, &project).unwrap();
    let rewritten: Value =
        serde_json::from_slice(&fs::read(sandbox.path.join("tsconfig.json")).unwrap()).unwrap();
    assert_eq!(rewritten["extends"][0], "./base.json");
    assert_eq!(rewritten["extends"][1], json!(external));
    assert_eq!(rewritten["extends"][2], "./.base.json");
    assert_eq!(rewritten["files"], json!(["./src/file.ts"]));
    assert_eq!(
        rewritten["include"],
        json!(["./src/*.ts", "..generated/**/*.ts"])
    );
    sandbox.finish(&config);
    sandbox.cleanup().unwrap();
}

#[cfg(windows)]
#[test]
fn native_windows_tsconfig_paths_preserve_targets_and_selected_reference_dfs() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("project");
    fs::create_dir(&root).unwrap();
    // Keep the standard library's verbatim canonical form in this fixture. The
    // rewriter must match it with ordinary absolute paths without reading targets.
    let root = root.canonicalize().unwrap();
    let ordinary_root = dunce::simplified(&root);
    let drive_root = ordinary_root.ancestors().last().unwrap();
    let rooted_internal = ordinary_root
        .join("src/file.ts")
        .components()
        .skip(1)
        .collect::<PathBuf>();
    let other_drive = if name(drive_root).unwrap().starts_with("C:") {
        r"D:\unread-external\missing.ts"
    } else {
        r"C:\unread-external\missing.ts"
    };
    let other_config = Path::new(other_drive).with_extension("json");
    write(&root, "base.json", "{}");
    write(&root, ".base.json", "{}");
    write(&root, "model/tsconfig.json", "{}");
    let source = json!({
        "extends": [r"..\base.json", ordinary_root.join("base.json"), root.join(".base.json"), other_config],
        "references": [{"path": "..\\model\\"}],
        "files": [r"..\src\file.ts", rooted_internal, other_drive],
        "include": [r"..\..\external\**\*.ts"],
        "exclude": [r"\unread-external\generated"]
    })
    .to_string();
    write(&root, "nested/tsconfig.json", &source);
    let mut config = config(&root);
    config.options["tsconfigFile"] = r"nested\tsconfig.json".into();
    config.options["tempDirName"] = r"build\cache\sandboxes".into();
    let project = prepare(&config).unwrap();
    assert_eq!(
        project
            .preprocessed
            .iter()
            .map(|(path, _)| name(path).unwrap())
            .collect::<Vec<_>>(),
        [
            "base.json",
            ".base.json",
            "model/tsconfig.json",
            "nested/tsconfig.json"
        ]
    );
    assert!(!root.join("build").exists());
    let mut sandbox = Sandbox::create(&config, &project).unwrap();
    let rewritten: Value =
        serde_json::from_slice(&fs::read(sandbox.path.join("nested/tsconfig.json")).unwrap())
            .unwrap();
    assert_eq!(
        rewritten["extends"],
        json!([
            r"..\base.json",
            "../base.json",
            "../.base.json",
            other_config
        ])
    );
    assert_eq!(rewritten["references"], json!([{"path": "..\\model\\"}]));
    assert_eq!(
        rewritten["files"],
        json!([r"..\src\file.ts", "../src/file.ts", other_drive])
    );
    for (value, target) in [
        (
            &rewritten["include"][0],
            tsconfig::normalize(root.parent().unwrap()).join("external/**/*.ts"),
        ),
        (
            &rewritten["exclude"][0],
            drive_root.join("unread-external/generated"),
        ),
    ] {
        assert_eq!(
            tsconfig::normalize(&sandbox.path.join("nested").join(value.as_str().unwrap())),
            tsconfig::normalize(&target)
        );
    }
    assert_eq!(
        fs::read_to_string(root.join("nested/tsconfig.json")).unwrap(),
        source
    );
    for path in ["base.json", ".base.json", "model/tsconfig.json"] {
        assert_eq!(fs::read_to_string(root.join(path)).unwrap(), "{}");
    }
    sandbox.finish(&config);
    sandbox.cleanup().unwrap();
}

#[cfg(windows)]
#[test]
fn windows_tsconfig_relative_paths_keep_drive_roots_and_absolute_other_drives() {
    assert_eq!(
        tsconfig::normalize(Path::new(r"c:\project\base.json")),
        Path::new(r"C:\project\base.json")
    );
    assert_eq!(
        tsconfig::normalize(Path::new(r"C:\..\..\external\file.ts")),
        Path::new(r"C:\external\file.ts")
    );
    assert_eq!(
        tsconfig::relative(
            Path::new(r"C:\project\sandbox"),
            Path::new(r"D:\external\missing.json")
        )
        .unwrap(),
        "D:/external/missing.json"
    );
    assert_eq!(
        tsconfig::relative(
            Path::new(r"\\?\C:\project\sandbox"),
            Path::new(r"C:\project\src\file.ts")
        )
        .unwrap(),
        "../src/file.ts"
    );
    assert!(
        tsconfig::relative(
            Path::new(r"C:\Project\src"),
            Path::new(r"c:\project\base.json")
        )
        .unwrap_err()
        .contains("case-different Windows path alias")
    );
}

#[cfg(windows)]
#[test]
fn case_different_windows_tsconfig_aliases_fail_before_effects() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("CaseSensitiveProject");
    fs::create_dir(&root).unwrap();
    write(&root, "base.json", "{}");
    let root = root.canonicalize().unwrap();
    let config = config(&root);
    let case_alias_root = dunce::simplified(&root)
        .to_str()
        .unwrap()
        .replace("CaseSensitiveProject", "casesensitiveproject");
    for value in [
        json!({"extends": "./BASE.json"}),
        json!({"extends": format!("{case_alias_root}\\base.json")}),
        json!({"files": [format!("{case_alias_root}\\src\\file.ts")]}),
        json!({"references": [{"path": "./BASE.json"}]}),
    ] {
        let source = value.to_string();
        write(&root, "tsconfig.json", &source);
        let error = match prepare(&config) {
            Ok(_) => panic!("Unexpectedly accepted {source}"),
            Err(error) => error,
        };
        assert!(
            error.contains("case-different Windows path alias"),
            "{error}"
        );
        assert!(!root.join(".stryker-tmp").exists());
        assert!(!root.join("reports").exists());
        assert_eq!(
            fs::read_to_string(root.join("tsconfig.json")).unwrap(),
            source
        );
        assert_eq!(fs::read_to_string(root.join("base.json")).unwrap(), "{}");
    }
}

#[test]
fn malformed_or_ambiguous_tsconfig_fails_before_sandbox_effects() {
    let directory = tempfile::tempdir().unwrap();
    let config = config(directory.path());
    for source in [
        "{\"a\":1 \"b\":2}",
        "{unquoted:true}",
        "{'single':true}",
        "{\"a\":.5}",
        "{\"a\":9007199254740992}",
        "[]",
        "{\"extends\":[[\"base.json\"]]}",
        "{\"references\":[{}]}",
        "{\"include\":[false]}",
        "{\"files\":[\"\"]}",
        "{\"files\":[\"bad\\u0000path\"]}",
    ] {
        write(directory.path(), "tsconfig.json", source);
        let error = match prepare(&config) {
            Ok(_) => panic!("Unexpectedly accepted {source}"),
            Err(error) => error,
        };
        assert!(error.contains("TSConfig"), "{error}");
        assert!(!directory.path().join(".stryker-tmp").exists());
        assert!(!directory.path().join("reports").exists());
        assert_eq!(
            fs::read_to_string(directory.path().join("tsconfig.json")).unwrap(),
            source
        );
    }
}

#[test]
fn platform_ambiguous_tsconfig_paths_fail_before_sandbox_effects() {
    let directory = tempfile::tempdir().unwrap();
    let config = config(directory.path());
    #[cfg(unix)]
    let paths = [
        r"..\secret",
        r"C:\secret\file.ts",
        "C:/secret/file.ts",
        "C:relative.ts",
    ];
    #[cfg(windows)]
    let paths = [
        r"C:relative.ts",
        "C:",
        r"\\server\share\file.ts",
        r"\\.\PhysicalDrive0",
        r"\\?\C:\CON",
        r"\\?\C:\literal\..\file.ts",
    ];
    for path in paths {
        let source = json!({"files": [path]}).to_string();
        write(directory.path(), "tsconfig.json", &source);
        let error = match prepare(&config) {
            Ok(_) => panic!("Unexpectedly accepted {path}"),
            Err(error) => error,
        };
        assert!(error.contains("TSConfig"), "{error}");
        assert!(!directory.path().join(".stryker-tmp").exists());
        assert!(!directory.path().join("reports").exists());
        assert_eq!(
            fs::read_to_string(directory.path().join("tsconfig.json")).unwrap(),
            source
        );
    }
}

#[test]
fn signed_zero_and_uppercase_reference_suffix_match_the_pinned_serializer_contract() {
    let directory = tempfile::tempdir().unwrap();
    write(
        directory.path(),
        "tsconfig.json",
        "{\"value\":-0,\"references\":[{\"path\":\"child.JSON\"}]}",
    );
    write(
        directory.path(),
        "child.JSON",
        "selected but deliberately not a referenced config",
    );
    let config = config(directory.path());
    let project = prepare(&config).unwrap();
    assert_eq!(project.preprocessed.len(), 1);
    assert_eq!(
        project.preprocessed[0].1,
        "{\n  \"value\": 0,\n  \"references\": [\n    {\n      \"path\": \"child.JSON\"\n    }\n  ]\n}"
    );
}

#[test]
fn tsconfig_sandbox_cleanup_obeys_all_policies_and_preserves_originals() {
    let directory = tempfile::tempdir().unwrap();
    let source = "// original comment\n{\"include\":[\"../external/*.ts\",],}";
    write(directory.path(), "tsconfig.json", source);
    for (policy, finish, removed) in [
        (json!("always"), false, true),
        (json!(true), false, false),
        (json!(true), true, true),
        (json!(false), true, false),
    ] {
        let mut config = config(directory.path());
        config.options["cleanTempDir"] = policy;
        let project = prepare(&config).unwrap();
        let mut sandbox = Sandbox::create(&config, &project).unwrap();
        let path = sandbox.path.clone();
        assert_ne!(
            fs::read_to_string(path.join("tsconfig.json")).unwrap(),
            source
        );
        if finish {
            sandbox.finish(&config);
        }
        drop(sandbox);
        assert_eq!(!path.exists(), removed);
        assert_eq!(
            fs::read_to_string(directory.path().join("tsconfig.json")).unwrap(),
            source
        );
        if path.exists() {
            fs::remove_dir_all(path).unwrap();
        }
    }
}

#[cfg(unix)]
#[test]
fn ignored_symlinks_and_binary_assets_preserve_bytes_modes_and_dependency_links() {
    use std::os::unix::fs::{PermissionsExt, symlink};
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    write(root, "keep", "asset");
    fs::write(root.join("binary"), [0, 255, 128, 10]).unwrap();
    fs::set_permissions(root.join("binary"), fs::Permissions::from_mode(0o751)).unwrap();
    symlink("/must/not/be/read", root.join("secret")).unwrap();
    fs::create_dir(root.join("dependency-store")).unwrap();
    symlink("dependency-store", root.join("node_modules")).unwrap();
    let mut config = config(root);
    config.options["ignorePatterns"] = json!(["secret", "dependency-store"]);
    let project = prepare(&config).unwrap();
    let mut sandbox = Sandbox::create(&config, &project).unwrap();
    assert_eq!(
        fs::read(sandbox.path.join("binary")).unwrap(),
        [0, 255, 128, 10]
    );
    assert_eq!(
        fs::metadata(sandbox.path.join("binary"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o751
    );
    assert!(
        fs::symlink_metadata(sandbox.path.join("node_modules"))
            .unwrap()
            .file_type()
            .is_symlink()
    );
    assert!(!sandbox.path.join("secret").exists());
    sandbox.finish(&config);
    sandbox.cleanup().unwrap();
}
