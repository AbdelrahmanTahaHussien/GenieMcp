# QA Orchestrator — Copilot-Driven Playwright Automation
# Playwright QA Automation

A Copilot workflow that turns supplied test cases into traceable Playwright tests, runs them in Chromium, and records execution results.

## Workflow

Provide test cases directly in plain language or Gherkin, along with the application URL. A Jira ticket is optional context. The workflow runs three stages in order:

| Stage | Purpose | Output |
|---|---|---|
| Explorer | Relate the cases to relevant repository files and prepare a test-design plan. | `agents/handoff/plan.json` |
| Generator | Create Page Objects and Playwright tests, mapping Gherkin clauses to `test.step()` blocks. | `tests/`, `pages/`, `agents/handoff/changeset.json` |
| Executor | Run the selected spec and record attempts and outcomes. | `agents/handoff/run-report.json`, `agents/handoff/run-report.html` |

## Setup

Requirements: Node.js 18 or newer, VS Code with GitHub Copilot agent mode, and Jira access only when using a ticket as additional context.
Requirements: Node.js `^20.19.0` or `>=22.12.0` (Vite 8), VS Code with GitHub Copilot agent mode, and Jira access only when using a ticket as additional context.

```bash
npm ci
npx playwright install --with-deps chromium
```

## Quickstart

1. Start the application under test.
2. In Copilot Chat, run `/orchestrator`.
3. Provide the test cases in plain language or Gherkin, the application URL, and an optional Jira ticket.
4. Review the generated spec and execution report.

## Handoff and Reports

- Test-design and repository evidence: `agents/handoff/plan.json`
- Generated files and `--list` validation: `agents/handoff/changeset.json`
- Execution attempts and final results: `agents/handoff/run-report.json`
- HTML view rendered from the JSON report: `agents/handoff/run-report.html`
