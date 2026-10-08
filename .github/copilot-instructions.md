# Copilot Instructions — team18-amg QA Automation

## Project
React + Vite e-commerce storefront (`celfronteders`). Test automation uses **Playwright + TypeScript** with a 3-agent QA chain driven by Copilot.

---

## QA Agent Chain
Always execute stages **in order**. The user's supplied test cases are the primary input and may be plain language or Gherkin; a Jira ticket is optional supporting context.

| Stage | Agent | Reads | Writes |
|---|---|---|---|
| 1 | **Explorer** | User test cases, optional Jira ticket, relevant repository files and configured import graph | `agents/handoff/plan.json` |
| 2 | **Generator** | `plan.json` | Page Objects, Playwright specs, `agents/handoff/changeset.json` |
| 3 | **Executor** | `plan.json` + `changeset.json` | Run reports and approved fixes to existing specs or Page Objects |

Read the relevant skill before each stage. Explorer also applies `.github/skills/test-design/SKILL.md` and `.github/skills/import-graph/SKILL.md`. Executor's detailed policy is in `agents/executor.md`, referenced by `.github/skills/executor/SKILL.md`.

---

## File Conventions
- **Specs:** `tests/kan/<TICKET>.<feature>.spec.ts`
- **Page objects:** `pages/<feature>.page.ts`
- **Handoff JSON:** `agents/handoff/` (plan, changeset, run-report)

## Playwright Rules
- Always run tests with **`--project=chromium`** unless explicitly told otherwise
- **Page Object Model is mandatory** — no raw selectors in spec files
- Locator priority: `getByRole` › `getByText` / `getByLabel` › `getByTestId` › CSS (last resort)
- Never use XPath or nth-child selectors
- Never use XPath or nth-child selectors
- Every generated case must have a Gherkin Given/When/Then scenario; map each actionable clause to a named Playwright `test.step()`.
- `baseURL` is `http://localhost:5173`

## Guardrails
- Explorer: read-only except for `agents/handoff/plan.json`.
- Generator: writes specs under `tests/`, Page Objects under `pages/`, and `agents/handoff/changeset.json` only.
- Executor: may create/update `run-report.json`, `run-report.html`, and `fixes.json`; may patch existing specs or Page Objects only with approval. Never create a new spec or Page Object.

---

## How to Run
Use `/orchestrator` in Copilot Chat, or say **"run as orchestrator"** and provide:
- Test cases in plain language or Gherkin
- The site URL (e.g. `http://localhost:5173`)
- An optional Jira ticket key for additional context
