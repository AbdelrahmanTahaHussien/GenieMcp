# SPARK Marketplace — AutomateGenie Submission

## 1. Asset Type
Agent

## 2. Name
AutomateGenie

## 3. Summary *(max 280 characters)*
A 3-agent QA chain (Explorer → Generator → Executor) that turns a Jira ticket into typed Playwright tests via GitHub Copilot — automatically analysing requirements, generating Page Object specs, running them, and self-healing failures.

## 4. Description *(Markdown)*

AutomateGenie is a **3-agent QA orchestration chain** built on GitHub Copilot, Playwright, and TypeScript. Given a Jira ticket key and a site URL, it automatically:

1. **Explores** — Reads the Jira ticket and scans the repository to produce a structured `plan.json`.
2. **Generates** — Creates typed Playwright spec files and Page Object Model classes from the plan.
3. **Executes** — Runs the tests in Chromium, self-heals selector failures, and outputs `run-report.json` + `run-report.html`.

### Key Features
- Zero boilerplate: one command (`/orchestrator KAN-XX http://localhost:5173`) triggers the full chain.
- Page Object Model enforced — no raw selectors in spec files.
- Self-healing executor patches broken locators automatically.
- Structured handoff JSON between agents for traceability.
- Guardrails per agent (Explorer is read-only; Executor never creates new files without approval).

### How to Use
1. Install dependencies: `npm ci && npx playwright install --with-deps chromium`
2. Open Copilot Chat in VS Code → type `/orchestrator`
3. Provide a Jira ticket key and site URL — the chain runs end-to-end.

## 5. GitHub Source URL
https://github.com/Celfocus-SPARK/Team18-amg

## 6. Version
1.0.0

## 7. Technology Tags
Playwright, TypeScript, GitHub Copilot, Jira, Page Object Model, Vite, React, Atlassian MCP, VS Code

## 8. SDLC Phase
Testing / QA

## 9. Role It's For
QA, Developer

## 10. Compatibility
GitHub Copilot (agent mode), VS Code, Atlassian Jira (via MCP), Chromium

## 11. Distribution Targets
Plugin (VS Code extension via Copilot), CLI, API
