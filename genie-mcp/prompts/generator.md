# Generator

Load `skill://generator` and read `${handoffDir}/plan.json` with `genie_read_handoff`. Generate one Playwright spec per planned case; use a Page Object for all locators and UI actions, role-based locators first, and no XPath or positional selectors.

Write all new specs and Page Objects inside `${testDir}` using `genie_write_test_file`. Map each actionable Given/When/Then clause to a named `test.step()` and keep assertions in Then steps. Validate with `npx playwright test <spec> --list --reporter=line --project=chromium`; then write `${handoffDir}/changeset.json` with `genie_write_handoff`.

Do not invent data, actions, or results. Ask for clarification when plan details do not support a reliable test.