import { render, screen, within } from '@testing-library/react';
import { StrictMode } from 'react';
import { describe, expect, it } from 'vitest';
import { makeFullScope, removeApi } from '../../test/capabilities.ts';
import { CapabilityPanel } from './CapabilityPanel.tsx';

const STATUS_VOCABULARY = ['Available', 'Not available', 'Not evaluated', 'Yes', 'No'];

function region() {
  return screen.getByRole('region', { name: 'Browser capabilities' });
}

/** The status shown for a capability, by its visible name. */
function statusFor(name: string): string | null {
  const term = within(region()).getByText(name, { selector: 'dt' });
  return term.nextElementSibling?.textContent ?? null;
}

function checkItem(capability: string, api: string): string | null {
  const list = within(region()).getByRole('list', { name: `${capability} checks` });
  const code = within(list).getByText(api, { selector: 'code' });
  return code.closest('li')?.textContent ?? null;
}

describe('CapabilityPanel', () => {
  it('groups current-foundation and later-phase observations under headings', () => {
    render(<CapabilityPanel scope={makeFullScope().scope} />);

    const headings = within(region())
      .getAllByRole('heading')
      .map((heading) => heading.textContent);
    expect(headings).toEqual([
      'Browser capabilities',
      'Current foundation',
      'Later-phase prerequisites',
    ]);
    expect(
      within(region())
        .getAllByRole('term')
        .map((term) => term.textContent),
    ).toEqual([
      'Secure context',
      'Local file objects',
      'Object URLs',
      'HTML video',
      'Service Worker API',
      'WebRTC peer connection',
      'WebRTC data channel',
      'Media Source Extensions',
      'Origin private file system',
      'Web Crypto digest',
    ]);
  });

  it('states every observation in text', () => {
    render(<CapabilityPanel scope={makeFullScope().scope} />);

    expect(statusFor('Secure context')).toBe('Yes');
    expect(statusFor('Object URLs')).toBe('Available');
    expect(statusFor('WebRTC data channel')).toBe('Available');
    expect(checkItem('Secure context', 'window.isSecureContext')).toBe(
      'window.isSecureContext: true',
    );
    expect(checkItem('Object URLs', 'URL.revokeObjectURL')).toBe('URL.revokeObjectURL: present');
    const declarations = within(region()).getByRole('list', { name: 'Media type declarations' });
    expect(
      within(declarations)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['video/mp4: Browser reports: maybe', 'video/webm: Browser reports: no']);
  });

  it('reports missing APIs explicitly', () => {
    const { scope } = makeFullScope();
    for (const api of ['navigator.serviceWorker', 'RTCPeerConnection', 'MediaSource', 'crypto']) {
      removeApi(scope, api);
    }
    removeApi(scope, 'navigator.storage');
    render(<CapabilityPanel scope={{ ...scope, isSecureContext: false }} />);

    expect(statusFor('Secure context')).toBe('No');
    expect(statusFor('Service Worker API')).toBe('Not available');
    expect(statusFor('WebRTC peer connection')).toBe('Not available');
    expect(statusFor('Media Source Extensions')).toBe('Not available');
    expect(statusFor('Origin private file system')).toBe('Not available');
    expect(statusFor('Web Crypto digest')).toBe('Not available');
    expect(checkItem('Media Source Extensions', 'MediaSource')).toBe('MediaSource: not present');
    expect(statusFor('HTML video')).toBe('Available');
  });

  it('renders an empty scope without throwing', () => {
    render(<CapabilityPanel scope={{}} />);

    expect(statusFor('Secure context')).toBe('Not evaluated');
    expect(statusFor('Object URLs')).toBe('Not available');
    const declarations = within(region()).getByRole('list', { name: 'Media type declarations' });
    expect(
      within(declarations)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['video/mp4: Not evaluated', 'video/webm: Not evaluated']);
  });

  it('uses only observation vocabulary for statuses', () => {
    const { scope } = makeFullScope();
    removeApi(scope, 'MediaSource');
    render(<CapabilityPanel scope={scope} />);

    const statuses = within(region())
      .getAllByRole('definition')
      .filter((definition) => definition.classList.contains('capability-status'))
      .map((definition) => definition.textContent);
    expect(statuses).toHaveLength(10);
    for (const status of statuses) {
      expect(STATUS_VOCABULARY).toContain(status);
    }
  });

  it('states that API presence is not support, and never claims support', () => {
    render(<CapabilityPanel scope={makeFullScope().scope} />);

    const text = region().textContent;
    expect(text).toContain('API presence is not browser or product support');
    expect(text).toContain(
      'Their presence does not establish that Progressive Watch, synchronized watching, or any other later feature will work in this browser.',
    );
    expect(text).not.toMatch(/\b(un)?supported\b/i);
    expect(text).not.toMatch(/\b(in)?compatib/i);
    expect(text).not.toMatch(/\bqualified\b/i);
    expect(text).not.toMatch(/Progressive Watch (is )?(available|ready|enabled)/i);
  });

  it('observes the real global scope by default', () => {
    render(
      <StrictMode>
        <CapabilityPanel />
      </StrictMode>,
    );

    expect(statusFor('Local file objects')).toBe(
      typeof File === 'function' && typeof Blob === 'function' ? 'Available' : 'Not available',
    );
  });
});
