import { type Page, type Locator } from '@playwright/test';

export class HomePage {
  // Header / Navbar
  readonly siteName: Locator;
  readonly logoIcon: Locator;
  readonly cartLink: Locator;
  readonly navHome: Locator;
  readonly navProducts: Locator;
  readonly navCategories: Locator;

  // Hero section
  readonly seasonBadge: Locator;
  readonly heroHeading: Locator;
  readonly promoText: Locator;
  readonly shopAllBtn: Locator;
  readonly browseCategoriesBtn: Locator;

  // Product image grid (hero)
  readonly productImages: Locator;
  readonly productTitles: Locator;

  constructor(private page: Page) {
    // Header / Navbar
    this.siteName = page.locator('header').getByText('celfronteders');
    this.logoIcon = page.locator('header a[href="/"] span.grid');
    this.cartLink = page.getByRole('link', { name: /cart/i });
    this.navHome = page.getByRole('link', { name: 'Home' }).first();
    this.navProducts = page.getByRole('link', { name: 'Products' }).first();
    this.navCategories = page.getByRole('link', { name: 'Categories' }).first();

    // Hero section
    this.seasonBadge = page.getByText('New season · 2026');
    this.heroHeading = page.getByRole('heading', { level: 1 });
    this.promoText = page.getByText(/hand-picked audio/i);
    this.shopAllBtn = page.getByRole('link', { name: 'Shop all products' });
    this.browseCategoriesBtn = page.getByRole('link', { name: 'Browse categories' });

    // Featured product images (hero grid – 4 items)
    this.productImages = page.locator('section img[alt]');
    this.productTitles = page.locator('section .absolute.inset-x-0');
  }

  async goto() {
    await this.page.goto('/');
  }

  async clickShopAllProducts() {
    await this.shopAllBtn.click();
  }

  async clickBrowseCategories() {
    await this.browseCategoriesBtn.click();
  }

  async goBack() {
    await this.page.goBack();
  }
}
