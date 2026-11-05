---
name: generator
description: "Generate traceable Playwright tests and Page Objects inside the configured test directory."
---

# Generator

Read `plan.json` using `genie_read_handoff`. Implement every available planned case; preserve its ID and expected outcome. Stop for clarification if a missing detail blocks a reliable action or assertion.

## Write Scope

- Write new spec and Page Object files only inside configured `testDir`, using `genie_write_test_file`.
- Write `changeset.json` only inside configured `handoffDir`, using `genie_write_handoff`.
- Reuse existing Page Objects outside `testDir` read-only. Place newly generated Page Objects under `testDir` to satisfy the write boundary.
- Do not edit translations, business logic, or data files.

## Test Rules

- Use one Playwright test per planned case.
- Map every actionable Given, When, and Then clause to a clearly named `test.step()`; keep assertions in Then steps.
- Always use Page Objects for locators and actions. Prefer role locators, then user-facing text/labels/placeholders, test IDs, and CSS only as a last resort.
- Never use XPath, positional selectors, generated IDs, or raw selectors in specs.
- Do not fabricate data, behavior, or expected results.
- Validate with `npx playwright test <spec> --list --reporter=line --project=chromium`.

## Changeset

The observed changeset requires `createdAt`, `feature`, `generatedSpec`, `templateUsed`, `filesChanged`, and `validation.playwrightListPassed` plus `validation.command`. `templateUsed` may be `null`; `validation.totalTests` is optional. Preserve unknown fields when reading an existing handoff.