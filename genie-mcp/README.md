# Genie MCP

One MCP server combines AutoMateGenie QA tools and GraphDoc codebase navigation. Add the consumer MCP config and `genie.config.json` to a repository. GraphDoc analyzes React applications and plain JavaScript/TypeScript projects, including Node.js services, libraries, CLIs, and Playwright Page Object Model repositories.

## Install

Requires Node.js 20 or newer. Copy [examples/.vscode/mcp.json](examples/.vscode/mcp.json) and [examples/genie.config.json](examples/genie.config.json) into the consumer repository. Replace `@<org>` with the published GitHub Packages scope.

For Git installation, the Git repository must have this package's `package.json` at its root. Replace the organization placeholder with a dedicated repository containing the `genie-mcp` package:

```json
{
  "servers": {
    "genie-mcp": {
      "type": "stdio",
      "command": "npx",
      "args": [
        "-y",
        "git+https://github.com/<org>/genie-mcp.git#main",
        "--root",
        "${workspaceFolder}"
      ]
    }
  }
}
```

Pin a release by replacing `main` with a tag, for example `git+https://github.com/<org>/genie-mcp.git#v0.1.0`. For reproducible installs, use an immutable release tag or commit hash rather than a moving branch. The package's `prepare` script builds `dist/server.js` during Git installation.

npm installs the package at the Git repository root; it does not select this package from the parent AutoMateGenie monorepo by a `subdirectory` URL fragment. Keep/publish `genie-mcp` as a standalone Git repository, or use the GitHub Packages install shown above.

For a private repository, authenticate Git itself before starting VS Code: use Git Credential Manager/`gh auth login` with HTTPS, or configure an SSH key and use `git+ssh://git@github.com/<org>/genie-mcp.git#v0.1.0`. Do not put a personal access token in the MCP config or Git URL. The account/key needs read access to the repository.

The published MCP configuration uses:

```json
{
  "servers": {
    "genie-mcp": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@<org>/genie-mcp", "--root", "${workspaceFolder}"]
    }
  }
}
```

For local development from the `genie-mcp` package checkout, build with `npm install` and `npm run build`, then use:

```json
{
  "servers": {
    "genie-mcp": {
      "type": "stdio",
      "command": "node",
      "args": ["${workspaceFolder}/dist/server.js", "--root", "${workspaceFolder}"]
    }
  }
}
```

Both modules are enabled by default. Disable either with `--modules graphdoc` or `--modules genie`; for example, `--modules genie` starts only the Genie tools.

## Configuration

All directory settings are relative to the workspace passed to `--root` and are checked to remain inside it.

| Field | Required | Default | Purpose |
|---|---|---|---|
| `testDir` | Yes | None | Allowed root for `genie_write_test_file`. |
| `handoffDir` | Yes | None | Allowed root for Genie handoff and report writes. |
| `graphdocDir` | No | `docs` | Allowed root for every GraphDoc-generated document and state write. |
| `baseUrl` | No | None | Application URL available to prompts/workflows. |
| `conventions` | No | `{}` | Repository-specific test conventions supplied to prompts. |

See the example config for a starting point. `genie.config.json` must be at the `--root` directory.

## Tools

Genie tools: `genie_get_config`, `genie_analyze`, `genie_read_handoff`, `genie_write_handoff`, `genie_write_test_file`, `genie_run_report`.

GraphDoc tools retain their original names: `detect_project`, `analyze_project`, `onboard`, `get_tree`, `get_graph`, `get_unit`, `query_docs`, `generate_graphdoc`, `read_unit_source`, `document_unit`, `link_units`, `unlink_units`, `document_all_units`, `generate_module_graphdoc`, `sync`, and `export_doc_state`.

Prompts: `genie_orchestrator`, `genie_explorer`, `genie_generator`, `genie_executor`. Skills are exposed at `skill://executor`, `skill://explorer`, `skill://generator`, `skill://import-graph`, and `skill://test-design`.

The Explorer workflow uses GraphDoc's `onboard`, `query_docs`, `get_unit`, and `read_unit_source` tools to locate relevant files, then checks current source/tests for behavioral evidence.

## Playwright and Plain JS/TS Projects

GraphDoc detects non-React JavaScript/TypeScript projects from `package.json` and follows ESM, CommonJS, NodeNext `.js` specifiers, and application wiring. For Page Object Model repositories, set `includeSpecs: true` on `analyze_project` or `generate_graphdoc`; GraphDoc emits `Tests.md`, per-unit “Tested by” sections, spec pages, and spec links in the dependency diagrams. This is import-based coverage mapping, not line coverage.

For repositories with independent roots and no single entry point, pass `roots` with a value such as `src/pages` to `analyze_project` or `generate_graphdoc`. The selected roots and spec-coverage setting are persisted in `graphdocDir/graphdoc.json` and reused by `sync`.

## Handoff Shape Notes

The Zod schemas follow the current handoff JSON files; core fields are validated and other fields pass through.

- `plan.json` currently requires only `feature` and `createdAt`; detailed test-planning fields may be included as optional extras.
- `changeset.json` permits the observed `templateUsed: null` and `validation.totalTests` fields; the older guidance did not show those forms.
- `run-history.json` is an array of compact per-run summaries, not a single report object.
- `run-report.json` has core fields `spec`, `finishedAt`, `success`, `attempts`, and `summary`; top-level `failures` is optional in the current file shape. Attempt failures are compact; when top-level failure records are present they may include parser details such as `index`, `stepTitle`, `location`, and `rawBlock`.

`genie_read_handoff` returns raw content plus validation warnings. `genie_write_handoff` requires valid core fields. The HTML renderer uses `run-report.json` as its source and writes inside `handoffDir`.

## Build, Test, Publish

```bash
npm install
npm run build
npm test
```

To publish to GitHub Packages, set `name` in `package.json` to your organization scope, authenticate with a token that has `write:packages`, then publish to the configured registry:

```bash
npm login --registry=https://npm.pkg.github.com
npm publish
```

Do not commit the package token. Consumers need read access to the package and may need a project or user `.npmrc` mapping their scope to `https://npm.pkg.github.com`.