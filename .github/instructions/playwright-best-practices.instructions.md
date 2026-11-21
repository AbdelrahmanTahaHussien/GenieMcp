# Playwright Best Practices (base rules for every repo)
 
These rules apply whenever you write, review or fix Playwright specs and Page Objects. They are served by genie-mcp (`genie_get_instructions` with name `best-practices`, and inside `genie_orchestrator`), so they apply in every repo without a file in it.
 
Repo-specific choices (folders, locator attribute, conventions) come from `genie_get_config`. Never assume `tests/` or `pages/`: use `testDir`, `specDir` and `conventions` from the config. If a repo rule conflicts with this file, the repo rule wins.
 
---
 
## 1. Reuse before you create (most important)
 
- Before creating a Page Object, fixture, helper or locator, search for an existing one: GraphDoc `query_docs`, `get_unit`, `get_graph`, then `read_unit_source`. If GraphDoc is unavailable, scan the existing pages, fixtures and specs for the same flow.
- Extend an existing class or fixture instead of creating a near-duplicate.
- New Page Objects go only inside the configured test directory. Existing ones outside it are reused read-only.
- In the plan, list what you reused and what you created, with file paths.
## 2. Test design
 
- Test what a user sees and does, not implementation details (function names, CSS classes, internal state).
- One behavior per test. Several `expect` calls for one outcome are fine; do not split a test just to have one assertion.
- Every test traces to a supplied test case. Use the case ID or name in the test title.
- Titles say the outcome: `should show an error when the password is wrong`.
- Do not invent data, steps or expected results. If a detail is missing, ask.
- Only test what you control. Do not test third-party sites; stub their responses (see section 8).
## 3. Gherkin to `test.step()`
 
- Express each case as Given / When / Then.
- Each actionable clause is one `test.step()` named with the clause text.
- Put assertions in the Then steps. Given and When steps perform actions only.
## 4. Page Objects
 
- One class per page or major component, named `LoginPage`, `ProductPage`. File name follows the repo's pattern (default `login.page.ts`).
- The constructor takes `Page`: `constructor(private readonly page: Page)`.
- Define locators as `readonly` properties built with built-in locators.
- Methods describe **user actions** (`login(email, password)`, `addToCart(productName)`), not DOM structure. Never create methods like `clickButton3()`.
- Page Objects expose locators and return values; **specs make the assertions**. Do not import `expect` in Page Objects.
- Page Objects hold no test state between tests. Do not use module-level mutable variables.
- Do not put test data or credentials in Page Objects.
## 5. Fixtures
 
- Prefer small, single-purpose fixtures over logic-heavy `beforeEach` hooks. Compose them: a fixture can depend on another.
- Provide Page Objects through fixtures once a suite has more than a handful of specs:
```ts
import { test as base } from '@playwright/test';
import { LoginPage } from '../pages/login.page';
 
export const test = base.extend<{ loginPage: LoginPage }>({
  loginPage: async ({ page }, use) => {
    await use(new LoginPage(page));
  },
});
export { expect } from '@playwright/test';
```
 
- No "god fixture" that sets up everything for every test.
## 6. Locators
 
Use built-in locators. They auto-wait and retry. Order of preference:
 
1. `getByRole(role, { name })`: accessible and resilient.
2. `getByLabel` for form fields.
3. `getByTestId`: if the repo uses a custom attribute (for example `data-qa`), set `testIdAttribute` in `playwright.config.ts` instead of using raw `[data-qa=...]` selectors.
4. `getByText`, `getByPlaceholder`, `getByAltText`, `getByTitle`: **only when the text is fixed**.
5. CSS: last resort, short and scoped.
Rules:
- **Multilingual or changing copy:** if the app is translated or the text changes often, prefer role with a stable name, or test IDs. Text locators in that case cause `translation` failures.
- Make locators unique (strict mode). Narrow the scope instead of using `.first()` or `.nth()`:
```ts
page.getByRole('listitem')
  .filter({ hasText: 'Product 2' })
  .getByRole('button', { name: 'Add to cart' });
```
 
- Scope broad text locators to a dialog, form or section.
- Avoid XPath, `nth-child`, index-based locators, generated IDs and deep CSS chains.
- Find locators with `npx playwright codegen <url>` or the VS Code extension, then simplify them.
## 7. Assertions and waiting
 
- Use web-first assertions that retry: `await expect(locator).toBeVisible()`. Never `expect(await locator.isVisible()).toBe(true)`.
- Always `await` `expect` and every Playwright action. Enable the `@typescript-eslint/no-floating-promises` lint rule.
- **Never use `waitForTimeout`.** Rely on auto-waiting, assertions, `waitForResponse` or `waitForURL`.
- Do not use `waitForLoadState('networkidle')` as a readiness signal. Wait for a concrete element or API response.
- After navigation, assert on the URL first (`await expect(page).toHaveURL(...)`), then on the content.
- Use `expect.soft` only to collect several independent checks in one test. Set explicit timeouts only when needed: `{ timeout: 10000 }`.
## 8. Isolation and test data
 
- Every test is independent and must pass alone, in any order, in any worker or shard.
- No shared mutable state at module level. Put stateful setup in test-scoped or worker-scoped fixtures.
- Each test creates the data it needs. Use API setup for non-UI concerns (creating a user, seeding a cart) and keep the UI for what the test is checking.
- Parallel workers must not share one mutable account. Use a separate account or data per worker, and clean up.
- Reuse sign-in with a setup project and `storageState`, generated per run or per worker. Never commit state files.
- No hardcoded credentials, tokens or environment URLs. Read them from environment variables or config. Use `baseURL` from the Playwright config instead of full URLs.
- Stub third-party calls with `page.route(...)`. Mock selectively; do not mock the application's own critical integrations.
- Do not commit `test.only` or `test.skip`. If a test must be skipped, link the reason or issue in a comment.
## 9. Naming and layout
 
- Spec file names follow the repo's pattern. If a Jira ticket is supplied, use the ticket-based name; otherwise `<specDir>/<feature>.spec.ts`.
- Group related tests with `test.describe()`. Use `beforeEach` only for simple shared navigation.
- Tag tests so subsets can run: `@smoke`, `@regression`, `@slow` in the title or via the `tag` option. Run subsets with `--grep`.
- Keep specs in TypeScript with types on helpers and Page Object methods. Do not use `any`.
## 10. Configuration and CI (when you touch them)
 
- Define browsers as `projects`. Use `fullyParallel: true`, set `workers` explicitly in CI, and enable `forbidOnly` in CI.
- Use one or two retries in CI. Treat a test that needed a retry as a flaky test to fix.
- Traces: `trace: 'on-first-retry'`. Use traces, not videos, to debug CI failures.
- Run `tsc --noEmit` and lint in CI. Install only the browsers you need: `npx playwright install chromium --with-deps`.
- Speed up large suites with sharding (`--shard=1/N`) across jobs, and merge the reports.
## 11. Validate before handoff
 
Before writing the changeset, check each item:
 
- Every supplied case has exactly one test, and its title traces to the case.
- Each Given/When/Then clause is a named `test.step()`; assertions are in Then steps.
- Existing Page Objects and fixtures were reused where possible.
- No raw selectors in specs, no `waitForTimeout`, no `networkidle`, no hardcoded credentials or URLs.
- No `expect` in Page Objects. Every action and assertion is awaited.
- Files are written only inside the configured test directory.
- `npx playwright test <spec> --list --reporter=line --project=<project>` succeeds.
---
 
## Example: Page Object
 
```ts
import { type Page, type Locator } from '@playwright/test';
 
export class LoginPage {
  readonly emailInput: Locator;
  readonly passwordInput: Locator;
  readonly loginButton: Locator;
  readonly errorMessage: Locator;
 
  constructor(private readonly page: Page) {
    this.emailInput = page.getByLabel('Email');
    this.passwordInput = page.getByLabel('Password');
    this.loginButton = page.getByRole('button', { name: 'Login' });
    this.errorMessage = page.getByRole('alert');
  }
 
  async goto() {
    await this.page.goto('/login');
  }
 
  async login(email: string, password: string) {
    await this.emailInput.fill(email);
    await this.passwordInput.fill(password);
    await this.loginButton.click();
  }
}
```
 
## Example: spec with Gherkin steps
 
```ts
import { test, expect } from '../fixtures';
 
test.describe('Login @smoke', () => {
  test('TC-01 should show an error when the password is wrong', async ({ loginPage, page }) => {
    await test.step('Given the login page is open', async () => {
      await loginPage.goto();
    });
 
    await test.step('When the user submits a wrong password', async () => {
      await loginPage.login(process.env.TEST_USER!, 'wrong-password');
    });
 
    await test.step('Then an error message is shown', async () => {
      await expect(page).toHaveURL(/login/);
      await expect(loginPage.errorMessage).toBeVisible();
    });
  });
});
```
 
---
 
## Sources
 
- Playwright documentation, Best Practices: https://playwright.dev/docs/best-practices
- Currents, Playwright anti-patterns: https://currents.dev/posts/playwright-anti-patterns
- BrowserStack, Playwright Best Practices in 2026: https://www.browserstack.com/guide/playwright-best-practices
- TestDino, 17 Playwright Best Practices: https://testdino.com/blog/playwright-best-practices
 