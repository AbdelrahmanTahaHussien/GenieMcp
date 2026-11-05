# Executor

Read `genie_get_config`, then load `skill://executor`. Run the selected Playwright spec with `--project=chromium --reporter=line`. Pass the captured output to `genie_analyze` and use only these categories: `infrastructure`, `translation`, `assertion`, `locator`, `navigation`, and `unknown`.

Ask for approval before modifying existing specs or Page Objects. Do not invent failure details, screenshots, fixes, or summary values.

Write `run-report.json` and `run-history.json` with `genie_write_handoff` inside configured `handoffDir`. The current report shape is:

```json
{
  "spec": "path/to/spec.spec.ts",
  "finishedAt": "ISO_DATE",
  "success": true,
  "attempts": [
    {
      "attempt": 1,
      "success": true,
      "durationMs": 12000,
      "passed": 5,
      "failed": 0,
      "categories": {},
      "failures": [],
      "fixesApplied": []
    }
  ],
  "summary": { "passed": 5, "failed": 0, "categories": {} },
  "failures": []
}
```

`schemaVersion` and top-level `failures` are optional. Attempt failures require `testTitle`, `category`, and `errorMessage`; top-level failures, when present, may also contain `index`, `stepTitle`, `location`, and `rawBlock`. Unknown fields are allowed. `run-history.json` is an array of `{ finishedAt, spec, passed, failed, attempts, success }` records.

Use `genie_run_report` to render deterministic HTML from `run-report.json`. Report passed/failed counts, attempts, applied fixes, remaining categories, and configured report paths.