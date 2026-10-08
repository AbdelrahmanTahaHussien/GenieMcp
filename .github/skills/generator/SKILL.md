---
name: generator
description: "Use when generating Playwright specs and Page Objects from the test cases and evidence in agents/handoff/plan.json."
---

# Test Generator Agent

## When to Use
- Creating a new Playwright test spec for a feature or requirement
- Generating specs from existing templates and patterns
- Scaffolding automation based on `plan.json`

## Inputs
- `agents/handoff/plan.json`, containing normalized Gherkin cases, repository evidence, assumptions, and open questions.

## Required Output
Write/update:
- Spec file in `tests/` following existing naming conventions
- `agents/handoff/changeset.json`

### `changeset.json` schema
```json
{
  "createdAt": "ISO_DATE",
  "feature": "description of the feature",
  "generatedSpec": "tests/path/to/GeneratedSpec.spec.ts",
  "templateUsed": "tests/path/to/TemplateSpec.spec.ts",
  "filesChanged": [],
  "validation": {
    "playwrightListPassed": true,
    "command": "npx playwright test <spec> --list --reporter=line"
  }
}
```

## Rules
- Only write test specs under `tests/`, page objects under `pages/`, and handoff JSON.
- Read and implement every `testCases` entry in `plan.json`; do not source cases from Jira instead of the supplied input.
- Create one Playwright test per planned case. Map each actionable Gherkin clause to a clearly named `test.step()` beginning with its `Given`, `When`, or `Then` keyword. Put assertions in `Then` steps.
- Preserve case IDs and expected outcomes. Do not invent data, actions, or expected results; stop and request clarification when a gap blocks a reliable test.
- **Always use the Page Object Model** — create or reuse page objects in `pages/`.
- **Locator priority**: `getByRole` > `getByText/getByLabel/getByPlaceholder` > `getByTestId/data-qa` > CSS selectors (last resort).
- Never use XPath, nth-child, or auto-generated IDs.
- Reuse existing fixtures, page objects, and utilities.
- Follow existing naming conventions, tag style, and project patterns.
- Keep changes minimal and pattern-based.
- No translation or data file edits in this agent.
- Follow `.github/instructions/playwright-best-practices.instructions.md`.

## Procedure
1. Load `plan.json`.
2. Resolve open questions that block test behavior; do not silently assume answers.
3. Choose a relevant existing spec/Page Object pattern using the plan's evidence.
4. Create or reuse a Page Object in `pages/` for locators and UI actions only.
5. Generate one spec test per planned case, with Gherkin clauses represented by named `test.step()` blocks.
6. Validate with `npx playwright test <spec> --list --reporter=line --project=chromium`.
7. Save `changeset.json` with the generated paths and exact validation result.

## Acceptance Criteria
- Spec path follows project conventions.
- Every planned case is represented and retains its case ID.
- Every case has actionable Given/When/Then `test.step()` blocks; assertions are in Then steps.
- **Page object exists** in `pages/` for the target page.
- **Locators use recommended strategies** (role-based, text-based, test IDs).
- Specs **import page objects** — no raw selectors in spec files.
- `--list` passes without errors for Chromium.
- `changeset.json` includes validation command and result.
