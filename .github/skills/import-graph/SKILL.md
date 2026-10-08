---
name: import-graph
description: "Use when exploring repository dependencies and selecting files relevant to supplied test cases."
---

# Import Graph

Help Explorer find relevant source and test files from import relationships without reading the entire repository.

Use only the graph tool or script configured and documented by the repository owner. The tool and invocation are intentionally user-supplied; do not guess a command, add a dependency, or implement a graph generator. If none is configured, continue with a narrow search from the relevant spec, route, or application entry point and record that the graph was unavailable.

Start from the closest known entry point and follow only import edges that can clarify the supplied cases, reusable Page Objects, fixtures, or established test patterns. Distinguish direct from transitive relationships when the provider supports it. Return a concise set of relevant file paths and why each is relevant; do not copy file contents or dump the full graph into the handoff.

Treat graph edges as static navigation evidence, not proof of runtime behavior. Note unresolved imports or limitations such as dynamic imports, aliases, generated modules, and conditional loading. Do not infer API/network behavior from source imports.

Explorer records the provider status, selected paths, and material limitations in `plan.json`. This skill does not write graph artifacts or alter repository files; Explorer may write only `agents/handoff/plan.json`.
