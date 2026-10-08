---
name: explorer
description: "Use when analyzing supplied test cases, repository structure, existing Playwright patterns, or relevant files before test generation."
---

# Explorer

Prepare a compact, evidence-backed plan for the Generator. The user's supplied test cases are the primary input; Jira is optional supporting context.

## Scope

- Read the repository as needed; write only `agents/handoff/plan.json`.
- Follow `.github/skills/import-graph/SKILL.md` and use the repository owner's configured graph tool/script when available. Do not install dependencies, invent a command, or implement a graph generator. If no provider is configured, scan only relevant entry points/imports and record the limitation.
- Use graph edges to identify candidate files, not to assert runtime behavior. Static graphs can miss dynamic imports, aliases, and conditional loading.
- Inspect only files needed to ground the supplied cases. Record concise paths and why they matter instead of copying source into the handoff.
- Apply `.github/skills/test-design/SKILL.md` to each supplied case before writing the plan.

## Plan Output

Write valid JSON to `agents/handoff/plan.json` with this shape:

```json
{
  "createdAt": "ISO_DATE",
  "feature": "short feature description",
  "targetSpec": "tests/kan/<TICKET>.<feature>.spec.ts or tests/kan/<feature>.spec.ts",
  "relatedSpecs": [],
  "fixtures": [],
  "pageObjects": [],
  "translationFiles": [],
  "repositoryEvidence": [{ "file": "path/from/repo", "reason": "relevance to a case" }],
  "testCases": [{
    "id": "TC001",
    "title": "short title",
    "sourceRef": "supplied case ID or input position",
    "gherkin": { "given": [], "when": [], "then": [] },
    "technique": "applicable technique or none",
    "assumptions": []
  }],
  "importGraph": { "status": "used | unavailable | not-needed", "relevantFiles": [], "limitations": [] },
  "riskLevel": "low | medium | high",
  "recommendedAction": "generate | extend | clarify | skip",
  "assumptions": [],
  "openQuestions": [],
  "notes": []
}
```

Keep evidence and notes short. Do not repeat full source files or duplicate the raw case text. Preserve every supplied case and its identifier; label uncertain interpretations as assumptions or open questions. If a case lacks enough detail for a valid expected result, recommend `clarify` rather than inventing one.

## Completion Checks

- Every supplied case appears once in `testCases` and has traceable Gherkin clauses.
- Relevant repository claims have file-path evidence; unknowns remain explicit.
- Only `agents/handoff/plan.json` was written.
