---
name: executor
description: "Use when running Playwright tests, classifying failures, proposing approved fixes, or producing execution reports."
---

# Executor Skill

For each execution, read and follow `agents/executor.md`; it is the detailed executor policy and source of truth for retries, failure categories, approvals, and report output. Use Chromium unless explicitly overridden. The engine's categories are `infrastructure`, `translation`, `assertion`, `locator`, `navigation`, and `unknown`.

The executor may create or update the run-report artifacts and `agents/handoff/fixes.json`. It may patch an existing spec or Page Object only with approval; it must not create a new spec or Page Object.