---
name: import-graph
description: "Use GraphDoc dependency navigation to select repository files relevant to supplied cases."
---

# Import Graph

Use the enabled GraphDoc MCP tools to find likely relevant files without reading the whole repository.

- Start with `onboard` in compact mode.
- Use focused `query_docs`, `get_unit`, or `read_unit_source` calls to follow only relevant units and dependencies.
- Record concise repository-relative paths and why they matter; do not dump the full graph into the plan.
- Treat graph edges and generated docs as navigation evidence, not proof of runtime behavior or expected outcomes.
- If the GraphDoc module is disabled or the project is unsupported, perform a narrow scan from the closest relevant entry point and record that limitation.
- Note material gaps such as dynamic imports, aliases, generated modules, or conditional loading. Do not infer API/network behavior from imports.

Explorer records the provider status, relevant paths, and limitations in the optional plan details. This skill does not write files.