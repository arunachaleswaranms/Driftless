import { expect, test as base, type Page } from '@playwright/test';

/**
 * Records every console error or warning, uncaught exception, and request to
 * another origin on `page` into `problems`.
 */
export function watchPage(page: Page, baseURL: string | undefined, problems: string[]): void {
  const expectedOrigin = new URL(baseURL ?? '').origin;
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      problems.push(`console ${message.type()}: ${message.text()}`);
    }
  });
  page.on('pageerror', (error) => {
    problems.push(`page error: ${error.message}`);
  });
  page.on('request', (request) => {
    // A blob: URL's origin is the origin of the page that created it.
    const url = new URL(request.url());
    if (url.protocol !== 'data:' && url.origin !== expectedOrigin) {
      problems.push(`cross-origin request: ${url.origin}`);
    }
  });
}

// Every test fails if the page logs a console error or warning, throws an
// uncaught exception, or requests anything from another origin. Tests that
// open further pages watch them with `watchPage` into the same list.
export const test = base.extend<{ pageProblems: string[] }>({
  pageProblems: [
    async ({ page, baseURL }, use) => {
      const problems: string[] = [];
      watchPage(page, baseURL, problems);
      await use(problems);
      expect(problems).toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };
