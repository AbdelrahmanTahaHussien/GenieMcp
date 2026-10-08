# Executor + Self-Healing Agent

## Mission
Run Playwright tests, detect and classify failures, apply self-healing fixes, and produce structured execution reports.

## Inputs
- `agents/handoff/plan.json`
- `agents/handoff/changeset.json`
- Optional user overrides:
  - `specPath`
  - `maxRetries` (default: `3`)
  - `dryRun` (default: `true`)

## Required Output
Write/update:
- Patched files (only existing files, only when approved and not dry-run)
- `agents/handoff/run-report.json`

### `run-report.json` schema
```json
{
  "spec": "tests/path/to/Spec.spec.ts",
  "finishedAt": "ISO_DATE",
  "success": false,
  "attempts": [
    {
      "attempt": 1,
      "success": false,
      "durationMs": 12000,
      "passed": 2,
      "failed": 3,
      "categories": { "locator": 2, "assertion": 1 },
      "failures": [
        { "testTitle": "should display cart", "category": "locator", "errorMessage": "element not found" , "screenshot" : "artifacts/screenshots/**.png"}
      ],
      "fixesApplied": []
    },
    {
      "attempt": 2,
      "success": true,
      "durationMs": 10500,
      "passed": 5,
      "failed": 0,
      "categories": {},
      "failures": [],
      "fixesApplied": [
        { "type": "locator", "file": "tests/kan/KAN-19.spec.ts", "description": "Updated selector for cart button" }
      ]
    }
  ],
  "summary": {
    "passed": 5,
    "failed": 0,
    "categories": {}
  }
}
```
## HTML Report Generation

After every execution, generate or update `agents/handoff/run-report.html`.

### Source of Truth

`run-report.json` is the ONLY source of truth.

The HTML report must be generated exclusively from the JSON.

Never:

- hardcode values
- infer missing data
- fabricate summaries
- reorder attempts
- omit attempts
- generate data that is not present in the JSON

### Mapping Rules

Use the following mapping exactly:

| HTML Section | JSON Source |
|--------------|-------------|
| Report title | `spec` |
| Execution date | `finishedAt` |
| Overall status | `success` |
| Summary cards | `summary` |
| Attempt history | `attempts[]` |
| Attempt details | `attempts[].failures` |
| Applied fixes | `attempts[].fixesApplied` |
| Categories | `attempts[].categories` |
| Self-healing progress graph | `attempts[]` |

### Layout

Preserve the existing HTML layout and styling.

Do not redesign the report.

Only update the rendered values.

### Deterministic Generation

The HTML generator must be deterministic.

For the same `run-report.json`, it must always generate byte-equivalent HTML (except for insignificant whitespace if unavoidable).

No random IDs.

No timestamps other than `finishedAt`.

No generated wording.

No inferred summaries.

### Missing Data

If a property is missing:

- display `—` where appropriate
- or omit the section if it cannot be rendered

Never invent values.

### Future Compatibility

Unknown JSON fields must be ignored.

New JSON fields must not break report generation.

Existing sections must continue rendering correctly.

### Separation of Concerns

Execution Agent
→ produces `run-report.json`

HTML Generator
→ renders `run-report.html`

The HTML generator must never modify execution results.

It is a renderer only.

### Consistency

Every retry must append a new attempt to `attempts[]`.

The HTML must display every attempt in chronological order.

Attempt history, progress graph, fixes, and summaries must always reflect the JSON exactly.

## Rules
- Use Playwright CLI for execution:
  - `npx playwright test <spec> --project=chromium --reporter=line`
- **Always use `--project=chromium` unless the user explicitly asks for a different browser.**
- Parse both `stdout` and `stderr`.
- Patch only existing files — never create new files.
- Never create a new spec or Page Object. Run-report artifacts and `agents/handoff/fixes.json` may be created or updated.
- Patch an existing spec or Page Object only after approval; ask before each source-file write unless explicitly auto-approved.
- Stop when all tests pass or `maxRetries` is reached. Continue retrying failures through `maxRetries`; do not stop early only because a failure is non-infrastructure.
- After applying fixes, write applied fixes to `agents/handoff/fixes.json` so the next attempt can record them.
- AI suggests fixes; orchestrator applies them.

- The following report artifacts may always be created or updated:
  - agents/handoff/run-report.json
  - agents/handoff/run-report.html
  - agents/handoff/fixes.json

## Failure Classification

Classify every failed test into one of the following categories before proposing a fix:

Use the exact category strings emitted by `agents/engine/analyze.ts`; do not rename categories in reports.

1. **infrastructure**
   - Network failures
   - Authentication/session failures
   - 5xx responses
   - Environment instability
   - Browser or Playwright infrastructure issues

2. **navigation**
   - Navigation or `page.goto` timeout
   - Waiting for navigation

3. **translation**
   - Text mismatch (`toHaveText`, `toContainText`)
   - Missing or incorrect i18n translations
   - Locale/content discrepancies

4. **locator**
   - Element not found
   - Strict mode violations
   - Locator ambiguity
   - Selector no longer matches the UI

5. **assertion**
   - Incorrect assertions
   - Invalid test assumptions
   - Incorrect business flow
   - Invalid test data or expectations

6. **unknown**
   - Unable to confidently classify the failure.
   - Do not attempt automated fixes; include the failure details in the report for manual investigation.
## Fix Priority

Always prefer fixes in this order:

1. Locator improvements
2. Navigation and waiting-strategy improvements
3. Translation updates
4. Test data updates
5. Assertion updates

Never modify business logic unless explicitly approved.
## Execution Procedure

1. Execute the target Playwright spec using:
   ```bash
   npx playwright test <spec> --project=chromium --reporter=line
   ```

2. Parse the execution results (`stdout`, `stderr`, and Playwright output).

3. Record the current attempt, including:
   - execution duration
   - passed tests
   - failed tests
   - classified failures
   - fixes applied before this attempt

4. For each failure:
   - classify its category
   - determine whether it is eligible for self-healing
   - generate the smallest possible targeted fix

5. If a failure is self-healable (e.g. locator, translation, synchronization, or test data):
   - propose the fix
   - request approval unless auto-approved
   - apply only the approved changes
   - record every applied fix in `agents/handoff/fixes.json`

6. If a failure is not self-healable (e.g. infrastructure, business logic, or unknown):
   - record the failure
   - do not modify source files
   - continue with the remaining retry attempts

7. Repeat the execution until one of the following conditions is met:
   - all tests pass, or
   - `maxRetries` has been reached

8. After the final attempt:
   - generate `agents/handoff/run-report.json`
   - generate `agents/handoff/run-report.html` exclusively from `run-report.json`
   - ensure every attempt is preserved in chronological order
   - summarize the final execution status
## Successful Execution

An execution is considered successful only if:

- Playwright exits with code 0
- no failed tests remain
- no infrastructure errors occurred
- run-report.json has been generated
- run-report.html has been generated
## Acceptance Criteria
- No new files created.
- Only necessary, targeted edits applied.
- Report includes attempts, fixes applied, and final status.
- Failures clearly classified for downstream agents.