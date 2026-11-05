---
name: test-design
description: "Use when extracting test conditions from supplied cases and designing ISTQB-aligned, traceable Gherkin scenarios before Playwright generation."
---

# Test Design

Turn each user-supplied test case into a concise, testable scenario. Cases may arrive in plain language or Gherkin. The user-provided cases are the primary source; a Jira ticket is optional supporting evidence.

Apply relevant ISTQB Foundation-level testing concepts without forcing every technique onto every case:

- Identify the test condition, preconditions, action, and observable expected result.
- Consider equivalence partitioning and boundary-value analysis for input ranges; decision tables for combinations of conditions; state-transition testing for stateful behavior.
- Use risk and existing coverage to choose which cases need priority or extension.
- Select a technique only when it improves coverage; otherwise record `none`.

## Gherkin Contract
The current `plan.json` schema requires only `feature` and `createdAt`. Store designed cases, evidence, assumptions, and open questions as additional fields so they remain available to Generator without making those fields schema-required.


Represent every case with Given, When, and Then clauses:

- **Given** states observable setup or preconditions.
- **When** states the user's action or event.
- **Then** states the observable expected result, not an implementation guess.
- Use additional clauses only when they add a distinct precondition, action, or expected outcome. Keep each clause independently actionable and concise.

If input is already Gherkin, preserve its intent and terminology while clarifying only what the evidence supports. If input is plain language, convert it without adding requirements. Preserve case IDs and include a source reference for each case.

Record the designed cases in `plan.json` using `testCases` entries with `id`, `title`, `sourceRef`, `gherkin.given`, `gherkin.when`, `gherkin.then`, `technique`, and `assumptions`. Record unresolved details in `openQuestions`. Do not fabricate test data, UI behavior, or expected results. If a missing detail blocks a meaningful Then clause, recommend clarification and do not mark that case ready for generation.

Generator must implement each actionable clause as a correspondingly named Playwright `test.step()`; assertions belong in Then steps. This is a test-design convention, not a requirement to add a Gherkin/Cucumber runtime.
