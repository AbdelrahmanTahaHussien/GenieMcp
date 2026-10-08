---
agent: agent
description: >
  Turn supplied plain-language or Gherkin test cases into Playwright tests,
  execute them, and produce traceable QA reports.
---

# QA Orchestrator

Use the supplied test cases as the primary requirements. Accept either plain-language cases or Gherkin. Jira is optional supporting context.

- **Test cases:** `${input:testCases:Paste test cases in plain language or Gherkin}`
- **Site URL:** `${input:siteUrl:Application base URL, e.g. http://localhost:5173}`
- **Optional Jira ticket:** `${input:jiraTicket:Optional Jira ticket key}`

Run Explorer → Generator → Executor in order. Consult each stage's skill; do not duplicate detailed rules here.

## Stage 1 — Explorer

Read `.github/skills/explorer/SKILL.md`, `.github/skills/test-design/SKILL.md`, and `.github/skills/import-graph/SKILL.md` before acting.

1. Analyze `${input:testCases}` directly. If a Jira ticket was supplied, use it only as additional evidence; do not replace or silently change the supplied cases.
2. Use the configured repository import-graph tool/script when available. Do not assume a command or install graph tooling. If unavailable, perform a narrow file/import scan and record that limitation.
3. Identify relevant existing specs, Page Objects, fixtures, and implementation files; record concise path-based evidence.
4. Apply the test-design skill to every case. Preserve traceability, express each case as Gherkin Given/When/Then, and record assumptions or unanswered questions.
5. Write `agents/handoff/plan.json` only.

**Complete when:** the plan is valid JSON, includes every supplied test case, and separates evidence from assumptions and open questions.

## Stage 2 — Generator

Read `.github/skills/generator/SKILL.md` before acting.

1. Generate one Playwright test per designed case and use a Page Object for locators and UI actions.
2. Represent each actionable Given, When, and Then clause as a clearly named `test.step()`; put assertions in Then steps. Preserve the designed Gherkin meaning and do not invent data or expected results.
3. If a missing detail prevents a reliable expected result or action, stop for clarification rather than guessing.
4. Validate with `npx playwright test <spec> --list --reporter=line --project=chromium` and write `agents/handoff/changeset.json`.

Use the repository's ticket-based spec name when Jira is supplied. Without a ticket, use `tests/kan/<feature>.spec.ts`.

**Complete when:** all planned cases are represented, `--list` succeeds, and the changeset records the validation result.

## Stage 3 — Executor

Read `.github/skills/executor/SKILL.md` and `agents/executor.md` before acting.

Run the selected spec with `--project=chromium`. Use only these engine categories: `infrastructure`, `translation`, `assertion`, `locator`, `navigation`, and `unknown`. Follow executor approval and retry rules, and write every attempt to `agents/handoff/run-report.json`; render `run-report.html` from that JSON.

## Final Report

Summarize passed/failed counts, fixes applied, remaining failures and categories, and the paths to `agents/handoff/run-report.json` and `agents/handoff/run-report.html`.
