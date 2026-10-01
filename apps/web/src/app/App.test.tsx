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

  it('renders the local video player as a labelled region with an empty state', () => {
    render(<App />);

    const region = screen.getByRole('region', { name: 'Local video' });
    expect(within(region).getByLabelText('Choose video file')).toBeDefined();
    expect(within(region).getByRole('status').textContent).toBe('No video selected.');
  });

  it('renders the room as a labelled region that starts outside any room', () => {
    render(<App />);

    const region = screen.getByRole('region', { name: 'Room' });
    expect(within(region).getByRole('status').textContent).toBe('Not in a room.');
    expect(within(region).getByRole('button', { name: 'Create room' })).toBeDefined();
    expect(within(region).getByRole('button', { name: 'Join room' })).toBeDefined();
  });

  it('renders the browser capability report as a labelled region', () => {
    render(<App />);

    const region = screen.getByRole('region', { name: 'Browser capabilities' });
    expect(
      within(region).getByText(/API presence is not browser or product support/),
    ).toBeDefined();
    expect(within(region).getByRole('heading', { name: 'Current foundation' })).toBeDefined();
    expect(
      within(region).getByRole('heading', { name: 'Later-phase prerequisites' }),
    ).toBeDefined();
  });
});
