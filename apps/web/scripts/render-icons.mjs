// Rasterizes public/icons/icon.svg into the PNG sizes referenced by the web
// app manifest. Run with `npm run icons` after changing the SVG; the output is
// committed. The artwork keeps its mark inside the maskable safe zone, so the
// 512 px image also serves as the maskable icon.
import { readFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';

const iconsDir = new URL('../public/icons/', import.meta.url);
const svg = await readFile(new URL('icon.svg', iconsDir), 'utf8');
const sizes = [192, 512];

const browser = await chromium.launch();
try {
  for (const size of sizes) {
    const page = await browser.newPage({ viewport: { width: size, height: size } });
    await page.setContent(
      `<style>html,body{margin:0}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`,
    );
    await page.screenshot({ path: new URL(`icon-${size}.png`, iconsDir).pathname });
    await page.close();
  }
} finally {
  await browser.close();
}
