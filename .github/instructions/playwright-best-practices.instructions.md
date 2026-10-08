---
applyTo: "tests/**/*.spec.ts,pages/**/*.ts"
description: "Playwright test best practices: Page Object Model pattern and recommended locator strategies. Use when writing, reviewing, or fixing test specs and page objects."
---

# Playwright Best Practices

## Page Object Model (POM)

### Structure
- Every page or major component gets its own class under `pages/`
- Page classes encapsulate **locators** and **actions** — tests should never use raw selectors directly
- Name pattern: `LoginPage`, `SignupPage`, `ProductPage`
- File pattern: `pages/login.page.ts`, `pages/signup.page.ts`

### Page Object Rules
- Constructor takes a `Page` instance: `constructor(private page: Page)`
- Define locators as readonly properties using `this.page.locator()` or `this.page.getByRole()`
- Expose **action methods** (e.g., `login(email, password)`) that encapsulate multi-step interactions
- Expose **assertion helpers** when assertions are reusable (e.g., `expectErrorVisible()`)
- Never import `expect` inside page objects — keep assertions in specs
- Page objects should be stateless between tests

### Example Page Object
```typescript
import { type Page, type Locator } from '@playwright/test';

export class LoginPage {
  readonly emailInput: Locator;
  readonly passwordInput: Locator;
  readonly loginButton: Locator;
  readonly errorMessage: Locator;

  constructor(private page: Page) {
    this.emailInput = page.getByPlaceholder('Email Address');
    this.passwordInput = page.getByPlaceholder('Password');
    this.loginButton = page.getByRole('button', { name: 'Login' });
    this.errorMessage = page.getByText('Your email or password is incorrect!');
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

### Example Spec Using POM
```typescript
import { test, expect } from '@playwright/test';
import { LoginPage } from '../pages/login.page';

test.describe('Login', () => {
  let loginPage: LoginPage;

  test.beforeEach(async ({ page }) => {
    loginPage = new LoginPage(page);
    await loginPage.goto();
  });

  test('should fail with invalid credentials', async () => {
    await loginPage.login('invalid@test.com', 'wrong');
    await expect(loginPage.errorMessage).toBeVisible();
  });
});
```

## Locator Best Practices (Priority Order)

Use Playwright's built-in locators in this priority order:

### 1. Role-based (BEST — accessible and resilient)
```typescript
page.getByRole('button', { name: 'Submit' })
page.getByRole('link', { name: 'Home' })
page.getByRole('heading', { name: 'Login' })
page.getByRole('textbox', { name: 'Email' })
```

### 2. User-facing text
```typescript
page.getByText('Welcome back')
page.getByLabel('Email Address')
page.getByPlaceholder('Enter your email')
page.getByTitle('Close dialog')
```

### 3. Test IDs (when role/text not sufficient)
```typescript
page.getByTestId('submit-btn')       // uses data-testid
page.locator('[data-qa="login-email"]')  // custom test attributes
```

### 4. CSS selectors (LAST RESORT)
```typescript
page.locator('.login-form >> input[type="email"]')
```

### Locators to AVOID
- **XPath** — brittle, hard to read
- **nth-child / nth-of-type** — breaks on layout changes
- **IDs that are auto-generated** — not stable
- **Deep CSS chains** — `div > div > span > a` breaks easily
- **Multiple matching elements** — always ensure locators are unique (strict mode)

## General Test Rules
- One assertion concern per test — don't test login + signup in one test
- Use `test.describe()` to group related tests
- Use `test.beforeEach()` for common setup (navigation, page object init)
- Use meaningful test names: `should fail login with invalid credentials`
- Set explicit timeouts only when needed: `{ timeout: 10000 }`
- Use `baseURL` in playwright config instead of hardcoding URLs
