# Agents Team Workflow (PPE Content Automation)

This folder defines a 3-agent workflow to scale Playwright test creation and translation fixing by OPCO.

## Agents

- **Explorer** (`agents/explorer.md`)
  - Read-only repository analysis
  - Produces: `agents/handoff/plan.json`

- **Generator** (`agents/generator.md`)
  - Creates/updates tests under `tests/<opco>/`
  - Uses existing template/style (e.g. `tests/lowi/ESLowiGeneral.spec.ts`)
  - Produces: `agents/handoff/changeset.json`

- **Executor + Translation Fixer** (`agents/executor.md`)
  - Runs Playwright CLI
  - Detects translation failures
  - Patches **existing** files in `data/` only
  - Produces: `agents/handoff/run-report.json`

---

## Guardrails (Mandatory)

1. Allowed write paths:
   - `tests/**`
   - existing `data/**` files only
   - `agents/handoff/*.json`

2. Forbidden:
   - creating any new translation file in `data/`
   - editing unrelated folders/files

3. Execution:
   - always use Playwright CLI
   - parse both stdout and stderr
   - max retry for auto-fix: `3`

---

## Standard Run Order

1. **Explore**
2. **Generate**
3. **Execute + Fix**
4. Review `run-report.json`

---

## Interactive Orchestrator

Run:

````powershell
# from repo root
npx ts-node orchestrator.ts