---
description: Build one MCP server that combines AutoMateGenie and GraphDoc-MCP
mode: agent
---

# Goal

Create a single MCP server (`genie-mcp`) that combines my **AutoMateGenie** agent logic and my existing **GraphDoc-mcp** so any repo can use both by adding only `.vscode/mcp.json` and `genie.config.json`.

# Before writing code

1. Read the AutoMateGenie repo: `agents/engine/*` (analyze.ts, cli.ts, fsGuard.ts, logger.ts), `agents/orchestrator.ts`, `agents/{explorer,generator,executor}.md`, `.github/prompts/orchestrator.prompt.md`, `.github/skills/*/SKILL.md`, `.github/instructions/*`, and the handoff JSON files in `agents/handoff/`.
2. Read the GraphDoc-mcp project: `src/`, `.mcp.json`, `package.json`, `tsconfig.json`, `test/`.
3. Summarize what each part does and propose the final folder layout. Wait for my confirmation before moving files.

# Target structure

```
genie-mcp/
  src/
    server.ts          # registers everything (skeleton provided in server.ts)
    graphdoc/          # existing GraphDoc code, moved as-is, exposed via registerGraphdocTools()
    genie/             # engine code (analyze, fsGuard, logger, orchestrator helpers)
  prompts/             # orchestrator.md, explorer.md, generator.md, executor.md
  skills/              # executor.md, explorer.md, generator.md, import-graph.md, test-design.md
  test/
  package.json         # bin: genie-mcp
```

# Requirements

- Use `@modelcontextprotocol/sdk` and `zod`. TypeScript, ESM, same tooling as GraphDoc-mcp (build, vitest, prettier).
- CLI: `genie-mcp --root <workspaceFolder> [--modules graphdoc,genie]`. Both modules are on by default and each can be disabled.
- **Tools**: keep every existing GraphDoc tool unchanged (prefix with `graphdoc_` only if there is no name clash, and tell me about any rename). Add: `genie_get_config`, `genie_analyze`, `genie_read_handoff`, `genie_write_handoff`, `genie_write_test_file`, `genie_run_report`.
- **Handoff**: derive real zod schemas for `plan`, `changeset`, `run-history`, `run-report` from the current JSON files. `genie_write_handoff` must validate before writing.
- **fsGuard**: reuse `fsGuard.ts` logic. Writes are only allowed inside `testDir` and `handoffDir` from `genie.config.json`; reject path traversal.
- **Prompts**: expose the four markdown prompts as MCP prompts (`genie_orchestrator`, `genie_explorer`, `genie_generator`, `genie_executor`).
- **Resources**: expose the skills as `skill://{name}` resources.
- **No hardcoding**: remove anything specific to my React + Vite storefront (paths, URLs, page-object names). Everything repo-specific comes from `genie.config.json` (`testDir`, `handoffDir`, `baseUrl`, `conventions`).
- Update the Explorer instructions so it uses the GraphDoc tools to find relevant files instead of reading the whole repo.
- Logging goes to stderr only (stdout is reserved for the MCP protocol).

# Consumer setup to generate

- `examples/.vscode/mcp.json` using `npx -y @<org>/genie-mcp --root ${workspaceFolder}` (leave the package scope as a placeholder).
- `examples/genie.config.json` with sensible defaults.
- A README section: install, config fields, tool list, how to publish to GitHub Packages.

# Tests and acceptance

- Unit tests for fsGuard (traversal, allowed/blocked paths) and for handoff schema validation.
- A smoke test that starts the server over stdio and lists tools, prompts and resources.
- `npm run build` and `npm test` pass.
- Run the server against the AutoMateGenie repo with `--root` and confirm Explorer → Generator → Executor still produce the same handoff files.

# Working style

Work in small steps, run the build/tests after each step, and list any assumption or behavior change at the end. Do not delete the original repos' files; copy or move into `genie-mcp/` and tell me what remains to clean up.
