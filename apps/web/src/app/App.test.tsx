import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { App } from './App.tsx';

describe('App shell', () => {
  it('names the application in a single top-level heading inside the banner', () => {
    render(<App />);

    const banner = screen.getByRole('banner');
    expect(within(banner).getByRole('heading', { level: 1 }).textContent).toBe('Driftless');
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });

  it('provides a skip link that targets the focusable main landmark', () => {
    render(<App />);

    const main = screen.getByRole('main');
    const skipLink = screen.getByRole('link', { name: 'Skip to main content' });

    expect(skipLink.getAttribute('href')).toBe(`#${main.id}`);
    expect(main.tabIndex).toBe(-1);
  });

  it.each([
    ['Local video', /not available in this build/],
    ['Browser capabilities', /makes no browser support claims/],
  ])('renders the %s placeholder as a labelled region', (name, status) => {
    render(<App />);

    const region = screen.getByRole('region', { name });
    expect(within(region).getByText(status)).toBeDefined();
  });
});
