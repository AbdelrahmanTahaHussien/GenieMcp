---
agent: agent
description: >
  Turn supplied plain-language or Gherkin test cases into Playwright tests,
  execute them, and produce traceable QA reports.
---

# QA Orchestrator

Use the supplied plain-language or Gherkin cases as the requirements. Jira is optional supporting context. Read `genie_get_config` first for `testDir`, `handoffDir`, `baseUrl`, and conventions. Load stage guidance from `skill://explorer`, `skill://test-design`, `skill://import-graph`, `skill://generator`, and `skill://executor` as needed.

Run Explorer → Generator → Executor in order. Preserve user case IDs and intent. Never guess expected outcomes or write outside configured directories.

## Explorer

Use GraphDoc tools (`onboard`, then focused `query_docs`, `get_unit`, or `read_unit_source`) to locate relevant files. Treat graph/docs as navigation clues; verify behavior against current source and tests. Create a traceable Gherkin design and write `${handoffDir}/plan.json` with `genie_write_handoff`. The required core is `feature` and `createdAt`; detailed cases, evidence, assumptions, and questions may be additional fields.

## Generator

Read the plan with `genie_read_handoff`. Create one Playwright test per designed case and use Page Objects. All new specs and Page Objects must be written under `${testDir}` with `genie_write_test_file`. Map actionable Given/When/Then clauses to named `test.step()` blocks and put assertions in Then steps. Validate with `npx playwright test <spec> --list --reporter=line --project=chromium`, then write `${handoffDir}/changeset.json`.

## Executor

Run the selected spec with `--project=chromium --reporter=line`. Classify failures as `infrastructure`, `translation`, `assertion`, `locator`, `navigation`, or `unknown`; request approval before changing existing source files. Write the actual report structure to `${handoffDir}/run-report.json` and the compact run summary array to `${handoffDir}/run-history.json`. Use `genie_analyze` for line-reporter classification and `genie_run_report` to render HTML from `run-report.json`.

## Finish

Report pass/fail counts, retries, applied fixes, remaining failure categories, and the configured report paths.
