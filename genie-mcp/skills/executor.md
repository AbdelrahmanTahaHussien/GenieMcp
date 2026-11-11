---
name: executor
description: "Use when running Playwright tests, classifying failures, proposing approved fixes, or producing execution reports."
---

# Executor

Run Playwright with `--project=chromium --reporter=line`, classify output with `genie_analyze`, and use the categories `infrastructure`, `translation`, `assertion`, `locator`, `navigation`, and `unknown`. Ask for approval before modifying existing test/Page Object files.

Use `genie_write_handoff` for reports inside configured `handoffDir`; `genie_run_report` renders HTML from `run-report.json`.

Always use `genie_run_report` to produce the packaged telemetry dashboard; do not generate or redesign HTML yourself. Its summary cards, attempt details, fixes, and progress chart come from `run-report.json`. The optional cross-run trend comes from `run-history.json`; never invent history or chart points.

The real handoffs differ from older guidance examples:

- `plan.json` requires only `feature` and `createdAt`; additional test-design data is optional.
- `changeset.json` allows `templateUsed: null` and `validation.totalTests`.
- `run-history.json` is an array of per-run summaries.
- `run-report.json` requires `spec`, `finishedAt`, `success`, `attempts`, and `summary`; top-level `failures` is optional. Attempt failures are compact records; top-level failures, when present, may also include `index`, `stepTitle`, `location`, and `rawBlock`.

Preserve unknown fields. Do not add screenshot fields or other values unless the execution actually produced them. Every attempt must remain in chronological order.