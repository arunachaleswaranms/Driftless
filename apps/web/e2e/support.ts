import { expect, test as base } from '@playwright/test';

// Every test fails if the page logs a console error or warning, throws an
// uncaught exception, or requests anything from another origin.
export const test = base.extend<{ pageProblems: string[] }>({
  pageProblems: [
    async ({ page, baseURL }, use) => {
      const problems: string[] = [];
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
      await use(problems);
      expect(problems).toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };
