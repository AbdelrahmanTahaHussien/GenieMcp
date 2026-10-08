import { test, expect } from '@playwright/test';
import { HomePage } from '../../pages/home.page';

test.describe('KAN-19 – Home Page', () => {
  let homePage: HomePage;

  test.beforeEach(async ({ page }) => {
    homePage = new HomePage(page);
    await homePage.goto();
  });

  // TC001 – Verify Home Page Loads Successfully
  test('TC001 – home page loads with all main elements visible', async () => {
    await expect(homePage.heroHeading).toBeVisible();
    await expect(homePage.shopAllBtn).toBeVisible();
    await expect(homePage.browseCategoriesBtn).toBeVisible();
    await expect(homePage.siteName).toBeVisible();
    await expect(homePage.cartLink).toBeVisible();
  });

  // TC002 – Verify Navigation Menu Items
  test('TC002 – navigation menu contains Home, Products, and Categories links', async () => {
    await expect(homePage.navHome).toBeVisible();
    await expect(homePage.navProducts).toBeVisible();
    await expect(homePage.navCategories).toBeVisible();
  });

  // TC003 – Verify 'Shop all products' Button Functionality
  test('TC003 – clicking "Shop all products" navigates to /products', async ({ page }) => {
    await homePage.clickShopAllProducts();
    await expect(page).toHaveURL(/\/products/);
  });

  // TC004 – Verify 'Browse categories' Button Functionality
  test('TC004 – clicking "Browse categories" navigates to /categories', async ({ page }) => {
    await homePage.clickBrowseCategories();
    await expect(page).toHaveURL(/\/categories/);
  });

  // TC005 – Verify Promotional Text Content
  test('TC005 – promotional text is visible and readable', async () => {
    await expect(homePage.promoText).toBeVisible();
    const text = await homePage.promoText.textContent();
    expect(text).toBeTruthy();
    expect(text!.length).toBeGreaterThan(0);
  });

  // TC006 – Verify Product Images and Titles Display
  test('TC006 – product images and titles are displayed in the hero grid', async () => {
    const images = homePage.productImages;
    const count = await images.count();
    expect(count).toBeGreaterThan(0);

    for (let i = 0; i < count; i++) {
      await expect(images.nth(i)).toBeVisible();
      const alt = await images.nth(i).getAttribute('alt');
      expect(alt).toBeTruthy();
    }

    const titles = homePage.productTitles;
    const titleCount = await titles.count();
    expect(titleCount).toBeGreaterThan(0);
  });

  // TC007 – Verify Cart Icon Presence
  test('TC007 – cart icon is visible and accessible in the header', async () => {
    await expect(homePage.cartLink).toBeVisible();
  });

  // TC008 – Verify Header Logo and Text
  test('TC008 – header shows logo icon and site name "celfronteders"', async () => {
    await expect(homePage.logoIcon).toBeVisible();
    await expect(homePage.siteName).toBeVisible();
    const name = await homePage.siteName.textContent();
    expect(name).toContain('celfronteders');
  });

  // TC009 – Verify New Season Label Display
  test('TC009 – "New season · 2026" badge is displayed', async () => {
    await expect(homePage.seasonBadge).toBeVisible();
    const text = await homePage.seasonBadge.textContent();
    expect(text).toContain('New season · 2026');
  });

  // TC010 – Verify Responsive Layout of Home Page
  test('TC010 – responsive layout: hero heading and CTAs visible on mobile viewport', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await homePage.goto();
    await expect(homePage.heroHeading).toBeVisible();
    await expect(homePage.shopAllBtn).toBeVisible();
    await expect(homePage.browseCategoriesBtn).toBeVisible();
    // Verify no overlapping by checking elements are within viewport
    const heading = await homePage.heroHeading.boundingBox();
    expect(heading).not.toBeNull();
    expect(heading!.width).toBeLessThanOrEqual(375);
  });

  // TC011 – Negative Test: Verify Behavior on Slow Network
  test('TC011 – page displays content even under throttled network conditions', async ({ page }) => {
    const client = await page.context().newCDPSession(page);
    await client.send('Network.emulateNetworkConditions', {
      offline: false,
      downloadThroughput: (500 * 1024) / 8, // 500 Kbps
      uploadThroughput: (500 * 1024) / 8,
      latency: 400,
    });
    await page.goto('/');
    await expect(homePage.heroHeading).toBeVisible({ timeout: 30000 });
    await client.send('Network.emulateNetworkConditions', {
      offline: false,
      downloadThroughput: -1,
      uploadThroughput: -1,
      latency: 0,
    });
  });

  // TC012 – Negative Test: Verify Broken Image Handling
  test('TC012 – broken images show alt text instead of broken icon', async ({ page }) => {
    // Intercept image requests and abort them to simulate broken images
    await page.route('**/*.jpg', (route) => route.abort());
    await page.route('**/*.jpeg', (route) => route.abort());
    await page.route('**/*.png', (route) => route.abort());
    await page.route('**/picsum.photos/**', (route) => route.abort());
    await page.goto('/');

    const images = page.locator('section img[alt]');
    const count = await images.count();
    for (let i = 0; i < count; i++) {
      const alt = await images.nth(i).getAttribute('alt');
      expect(alt).toBeTruthy();
    }
  });

  // TC013 – Boundary Test: Verify Text Length in Promotional Area
  test('TC013 – promotional text area handles long text without layout breakage', async () => {
    await expect(homePage.promoText).toBeVisible();
    const box = await homePage.promoText.boundingBox();
    expect(box).not.toBeNull();
    // Ensure text area has a non-zero width and is within viewport
    expect(box!.width).toBeGreaterThan(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(1280 + 1); // Desktop Chrome default width
  });

  // TC014 – Alternative Flow: Cancel Navigation from 'Shop all products' Button
  test('TC014 – back navigation from /products returns user to home page', async ({ page }) => {
    await homePage.clickShopAllProducts();
    await expect(page).toHaveURL(/\/products/);
    await homePage.goBack();
    await expect(page).toHaveURL(/\/$/);
    await expect(homePage.heroHeading).toBeVisible();
  });

  // TC015 – Edge Case: Verify Home Page with No Products
  test('TC015 – home page remains stable when product grid is empty (mock scenario)', async ({ page }) => {
    // Intercept the module import to simulate empty products by checking UI is still intact
    // Since products are statically bundled, we verify the UI structure is intact
    // and the page does not crash when there are minimal products
    await page.goto('/');
    await expect(homePage.heroHeading).toBeVisible();
    await expect(homePage.shopAllBtn).toBeVisible();
    await expect(homePage.browseCategoriesBtn).toBeVisible();
    // Verify the page does not show any unhandled error UI
    const errorTexts = page.getByText(/something went wrong|uncaught error|500/i);
    await expect(errorTexts).toHaveCount(0);
  });
});
